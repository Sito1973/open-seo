import { sort, sortBy } from "remeda";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { projectSearchTracker } from "@/server/features/serp/services/googleCandidates";
import { AppError } from "@/server/lib/errors";
import {
  getDataforseoKey,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";
import { normalizeAiSuggestion } from "@/shared/ai-prompt-suggestions";
import type {
  AiPromptCandidateAnswer,
  AiPromptCandidateVolume,
  AiPromptResearchResult,
  AiResearchedPrompt,
  AiTrackerState,
} from "@/shared/ai-visibility";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { markdownToText } from "../providers/dataforseoEvidence";
import {
  loadPromptCandidates,
  plannerVolumes,
  type PromptCandidate,
} from "./aiPromptCandidates";
import { aiPromptIsBranded, ownedAiDomain } from "./aiVisibilityMatching";

// Prompt Research on a self-hosted server without DataForSEO for other
// features: DataForSEO's ChatGPT question database has no stand-in, and this
// server may have no AI model, so the research lists Google's own candidates
// for the user, or their AI agent over MCP, to rewrite into prompts.

const CANDIDATE_LIMIT = 100;
const ANSWER_EXCERPT_LENGTH = 600;

// Words that change neither the topic nor the question.
const STOPWORDS = new Set(
  "a al an and con de del el en for in la las lo los of para the to un una y".split(
    " ",
  ),
);

const VOLUME_TIERS: AiPromptCandidateVolume["source"][] = [
  "business_profile",
  "search_console",
  "keyword_planner",
];

const GUIDANCE =
  "This server has no DataForSEO question database and no AI model, so these are Google's raw candidates, not prompts people typed into an AI assistant: People Also Ask questions and related searches on the keyword's Google page, autocomplete, the site's Search Console questions and its Business Profile searches, plus tracked prompts about the keyword. volume is a labeled search signal (Business Profile impressions, Search Console impressions, or Keyword Planner monthly searches), never AI prompt volume. answer is a tracked prompt's last collected answer, or Google's People Also Ask answer. Rewrite the relevant untracked candidates as natural questions a customer would ask an AI assistant, in the tracker's language, merge duplicates, drop off-topic ones, show them to the user, and save the approved ones with save_ai_visibility_tracker under a topic.";

/**
 * Whether Prompt Research lists Google's candidates: self-hosted without
 * DataForSEO for other features, as getGoogleFallbackKey rules for every
 * Google stand-in. Hosted and full-DataForSEO installs keep DataForSEO.
 */
export async function promptResearchUsesGoogle(): Promise<boolean> {
  return (
    !(await getDataforseoKey("other")) && !(await isHostedServerAuthMode())
  );
}

/** Lowercase words without accents, stopwords or a plural "s". */
function contentWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !STOPWORDS.has(word))
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word,
    );
}

/**
 * Whether a text is about the keyword: every keyword word starts one of its
 * words ("hamburguesa" matches "hamburguesas a domicilio"). The market's city
 * may be left out, since a local site's own searches rarely repeat it.
 */
function aboutKeyword(keyword: string, city: string | null) {
  const cityWords = new Set(city ? contentWords(city) : []);
  const all = contentWords(keyword);
  const required = all.filter((word) => !cityWords.has(word));
  const keywordWords = required.length ? required : all;
  return (text: string) => {
    const words = contentWords(text);
    return keywordWords.every((keywordWord) =>
      words.some(
        (word) =>
          word.startsWith(keywordWord) ||
          (word.length >= 3 && keywordWord.startsWith(word)),
      ),
    );
  };
}

// The same words in any order, without years, ask the same thing.
function mergeKey(text: string) {
  const key = sort(
    contentWords(text).filter((word) => !/^(?:19|20)\d{2}$/.test(word)),
    (a, b) => a.localeCompare(b),
  ).join(" ");
  return key || normalizeAiSuggestion(text);
}

function sentence(text: string) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Keyword Planner keyword text: no question or exclamation marks. */
function plannerText(text: string) {
  return normalizeAiSuggestion(text.replace(/[¿?¡!]/g, " "));
}

/** The group's highest volume from the best-ranked source it has. */
function bestVolume(group: PromptCandidate[]): AiPromptCandidateVolume | null {
  for (const source of VOLUME_TIERS) {
    const volumes = group.flatMap((candidate) =>
      candidate.volume?.source === source ? [candidate.volume] : [],
    );
    if (volumes.length)
      return sortBy(volumes, [(volume) => volume.value, "desc"])[0] ?? null;
  }
  return null;
}

type LastAnswer = Pick<
  AiResearchedPrompt,
  "sources" | "brandMentioned" | "ownDomainCited"
> & { answer: AiPromptCandidateAnswer };

/** Each tracked prompt's newest answer, shortened, with what it said of the brand. */
async function lastAnswers(
  promptIds: string[],
  ownDomain: string | null,
): Promise<Map<string, LastAnswer>> {
  const latest = (
    await Promise.all(promptIds.map((id) => repo.getLatestAnswer(id)))
  ).flatMap((answer, index) =>
    answer ? [{ ...answer, promptId: promptIds[index] }] : [],
  );
  const evidence = await repo.getEvidence(latest.map((answer) => answer.id));
  return new Map(
    latest.map((answer): [string, LastAnswer] => {
      const text = markdownToText(answer.answerMarkdown ?? "");
      const sources = evidence.sources
        .filter((source) => source.observationId === answer.id)
        .map(({ domain, url, title }) => ({
          domain,
          url,
          title,
          own: !!ownDomain && ownedAiDomain(domain, ownDomain),
        }));
      const own = evidence.matches.find(
        (match) => match.observationId === answer.id && match.own,
      );
      return [
        answer.promptId,
        {
          answer: {
            kind: "last_answer",
            engine: answer.engine,
            collectedAt: answer.collectedAt,
            text:
              text.length > ANSWER_EXCERPT_LENGTH
                ? `${text.slice(0, ANSWER_EXCERPT_LENGTH).trimEnd()}…`
                : text,
          },
          sources,
          brandMentioned: own?.mentioned ?? false,
          ownDomainCited: !!own?.cited || sources.some((source) => source.own),
        },
      ];
    }),
  );
}

/**
 * Prompt candidates for a keyword from Google, ranked by a labeled volume:
 * Business Profile impressions first, then Search Console impressions, then
 * Keyword Planner searches, then none. Near-duplicates merge. Tracked prompts
 * about the keyword come with their last collected answer; other People Also
 * Ask questions with Google's answer, labeled as such. A source that is not
 * set up or does not answer leaves a note instead of failing the research.
 */
export async function researchAiPromptsFromGoogle(
  input: { projectId: string; keyword: string },
  customer: BillingCustomerContext,
  state: AiTrackerState,
): Promise<AiPromptResearchResult> {
  const project = await ProjectRepository.getProjectForOrganization(
    input.projectId,
    customer.organizationId,
  );
  if (!project) throw new AppError("NOT_FOUND");
  const keyword = normalizeAiSuggestion(input.keyword);
  const { market, device } = await projectSearchTracker({
    id: project.id,
    locationCode: state.tracker?.locationCode ?? project.locationCode,
    languageCode: state.tracker?.languageCode ?? project.languageCode,
  });
  const city = market.locationName?.split(",")[0]?.trim().toLowerCase() || null;
  const isAbout = aboutKeyword(keyword, city);
  const found = await loadPromptCandidates({
    keyword,
    market,
    device,
    city,
    project,
    organizationId: customer.organizationId,
  });

  const tracked = state.prompts.filter((prompt) => !prompt.archived);
  // Tracked prompts under the keyword's topic or about it are listed with
  // their last answer; any other only marks a candidate with its wording.
  const listed = new Set(
    tracked
      .filter(
        (prompt) =>
          normalizeAiSuggestion(prompt.topic) === keyword ||
          isAbout(prompt.text),
      )
      .map((prompt) => prompt.id),
  );
  const grouped = new Map<string, PromptCandidate[]>();
  // Insertion order breaks ties and picks each group's wording: tracked
  // first, then the Google page, then what people typed.
  for (const candidate of [
    ...tracked.map(
      (prompt): PromptCandidate => ({
        text: prompt.text,
        origin: "tracked",
        volume: null,
        promptId: prompt.id,
      }),
    ),
    ...found.fromPage,
    ...found.searched.filter((searched) => isAbout(searched.text)),
  ]) {
    const key = mergeKey(candidate.text);
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }
  const groups = [...grouped.values()].filter((group) =>
    group.some((item) => !item.promptId || listed.has(item.promptId)),
  );
  const planner = await plannerVolumes(
    groups
      .filter((group) => !bestVolume(group))
      .map((group) => plannerText(group[0].text)),
    market,
    customer.userId,
  );
  const ranked = sortBy(
    groups.map((group) => {
      const searches = planner.volumes.get(plannerText(group[0].text));
      const volume: AiPromptCandidateVolume | null =
        bestVolume(group) ??
        (searches == null
          ? null
          : { source: "keyword_planner", value: searches, below: false });
      return { group, volume };
    }),
    [
      ({ volume }) =>
        volume ? VOLUME_TIERS.indexOf(volume.source) : VOLUME_TIERS.length,
      "asc",
    ],
    [({ volume }) => volume?.value ?? 0, "desc"],
  ).slice(0, CANDIDATE_LIMIT);

  const ownBrand = state.brands.find((brand) => brand.own);
  const answers = await lastAnswers(
    ranked.flatMap(({ group }) => group[0].promptId ?? []),
    ownBrand?.domain ?? null,
  );
  const prompts = ranked.map(({ group, volume }): AiResearchedPrompt => {
    const [lead] = group;
    const last = lead.promptId ? answers.get(lead.promptId) : undefined;
    const google = group.find((item) => item.peopleAlsoAsk)?.peopleAlsoAsk;
    const sources =
      last?.sources ??
      (google?.url && google.domain
        ? [
            {
              domain: google.domain,
              url: google.url,
              title: null,
              own: !!ownBrand && ownedAiDomain(google.domain, ownBrand.domain),
            },
          ]
        : []);
    const text = lead.promptId ? lead.text : sentence(lead.text);
    return {
      text,
      variants: [
        ...new Set(group.slice(1).map((item) => sentence(item.text))),
      ].filter((variant) => variant.toLowerCase() !== text.toLowerCase()),
      sources,
      ownDomainCited:
        last?.ownDomainCited ?? sources.some((source) => source.own),
      brandMentioned:
        last?.brandMentioned ??
        (!!ownBrand &&
          !!google?.answer &&
          aiPromptIsBranded(google.answer, ownBrand)),
      tracked: !!lead.promptId,
      origins: [...new Set(group.map((item) => item.origin))],
      volume,
      answer:
        last?.answer ??
        (google?.answer
          ? { kind: "people_also_ask", text: google.answer }
          : null),
    };
  });
  return {
    keyword: input.keyword,
    prompts,
    withoutModel: {
      guidance: GUIDANCE,
      notes: [...found.notes, ...(planner.note ? [planner.note] : [])],
    },
  };
}
