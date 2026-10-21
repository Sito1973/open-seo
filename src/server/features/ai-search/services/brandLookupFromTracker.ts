import { firstBy, groupBy, groupByProp, sortBy, unique } from "remeda";
import { AiVisibilityRepository as repo } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { markdownToText } from "@/server/features/ai-visibility/providers/dataforseoEvidence";
import { aiBrands } from "@/server/features/ai-visibility/services/aiVisibilityConfiguration";
import {
  aiMentionSpans,
  ownedAiDomain,
} from "@/server/features/ai-visibility/services/aiVisibilityMatching";
import { resolveResearchTarget } from "@/server/features/ai-search/services/brandLookup";
import { resolveCompetitorGroups } from "@/server/features/ai-search/services/shareOfVoice";
import type { AiBrand, AiEngine } from "@/shared/ai-visibility";
import {
  parseResearchTarget,
  urlMatchesResearchTarget,
  type ResearchTarget,
} from "@/shared/researchScope";
import { safeHostname, safeHttpUrl } from "@/shared/safe-url";
import { detectTarget } from "@/shared/targetDetection";
import type {
  BrandLookupInput,
  BrandLookupPlatform,
  BrandLookupResult,
} from "@/types/schemas/ai-search";

/**
 * Brand Lookup for a self-hosted install without DataForSEO: the same result
 * shape, counted over the AI answers this project's prompt tracker collected
 * in the last 12 weeks. A brand counts in an answer as AI Visibility counts
 * it: its name or domain in the prose, or a cited page on its site. No source
 * reports AI search volume, so every volume field stays null.
 */

const WINDOW_DAYS = 84;
// The AI Visibility history reads at most this many runs as well.
const MAX_RUNS = 50;
const TOP_SOURCES_PER_PLATFORM = 10;
const TOP_QUERIES_PER_PLATFORM = 25;
const PROMPTS_PER_SOURCE = 50;

const PLATFORM_BY_ENGINE: Record<AiEngine, BrandLookupPlatform> = {
  chatgpt: "chat_gpt",
  google_ai_overview: "google",
  google_ai_mode: "google_ai_mode",
  gemini: "gemini",
  claude: "claude",
  perplexity: "perplexity",
};

type Answer = {
  promptId: string;
  prompt: string;
  platform: BrandLookupPlatform;
  collectedAt: string;
  text: string;
  sources: { url: string; title: string | null }[];
  brandsMentioned: string[];
};

type LookupBrand = {
  label: string;
  names: string[];
  site: ResearchTarget | null;
  own: boolean;
};

export async function brandLookupFromTracker(
  input: BrandLookupInput,
  now = new Date(),
): Promise<BrandLookupResult> {
  const detected = detectTarget(input.query);
  const researchTarget = resolveResearchTarget(input, detected);
  const scope = researchTarget?.scope;
  const pageFilter =
    scope === "exact_url" || scope === "subfolder" ? researchTarget : null;
  // Counts are per site, like DataForSEO's: one subdomain rule for the target
  // and every competitor, and URL scopes only narrow the page rows.
  const siteScope =
    researchTarget === null || scope === "subdomains" ? "subdomains" : "domain";

  const project = await repo.getProject(input.projectId);
  const known = project
    ? aiBrands(project, await repo.listCompetitors(project.id))
    : [];
  const target = lookupBrand(detected, known, siteScope);
  const competitors = resolveCompetitorGroups(
    detected.value,
    input.competitors,
  ).map((group) => lookupBrand(group.detected, known, siteScope));

  const { answers, truncated } = await loadAnswers(input.projectId, now);
  const hits = answers.filter((answer) => mentions(answer, target));
  const engines = unique(answers.map((answer) => answer.platform));
  const perPlatform = engines.map((platform) => ({
    platform,
    status: "success" as const,
    mentions: hits.filter((hit) => hit.platform === platform).length,
    aiSearchVolume: null,
  }));
  const totalMentions = engines.length > 0 ? hits.length : null;
  // Under a URL scope a page row only counts an answer that cited the scope.
  const pageHits = pageFilter
    ? hits.filter((hit) =>
        hit.sources.some((s) => urlMatchesResearchTarget(s.url, pageFilter)),
      )
    : hits;
  const topPages = shapeTopPages(pageHits, pageFilter);
  const topQueries = shapeTopQueries(pageHits);
  const shareOfVoice =
    competitors.length > 0 && answers.length > 0
      ? shapeShareOfVoice(answers, [target, ...competitors], engines)
      : null;

  return {
    query: input.query,
    detectedTargetType: detected.type,
    resolvedTarget: researchTarget?.display ?? detected.value,
    scope: scope ?? null,
    aggregatesAreDomainLevel: pageFilter !== null,
    fetchedAt: now.toISOString(),
    hasData:
      hits.length > 0 ||
      (shareOfVoice?.entries.some((entry) => (entry.mentions ?? 0) > 0) ??
        false),
    totalMentions,
    totalAiSearchVolume: null,
    perPlatform,
    shareOfVoice,
    topPages,
    topQueries,
    monthlyVolume: [],
    collectedAnswers: {
      answers: answers.length,
      engines,
      since:
        firstBy(answers, (answer) => answer.collectedAt)?.collectedAt ?? null,
      truncated,
      ownBrand: target.own,
    },
  };
}

/** Answered collections of the runs in the window, with their evidence. */
async function loadAnswers(projectId: string, now: Date) {
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const runs = (await repo.listRuns(projectId, MAX_RUNS)).filter(
    (run) => run.createdAt >= cutoff.toISOString(),
  );
  const runCreatedAt = new Map(runs.map((run) => [run.id, run.createdAt]));
  const observations = (
    await repo.getObservations(runs.map((run) => run.id))
  ).filter((o) => o.status === "completed" && o.answerMarkdown);
  const evidence = await repo.getEvidence(observations.map((o) => o.id));
  const sources = groupByProp(evidence.sources, "observationId");
  const matches = groupByProp(evidence.matches, "observationId");
  const answers = observations.map(
    (o): Answer => ({
      promptId: o.promptId,
      prompt: o.prompt,
      platform: PLATFORM_BY_ENGINE[o.engine],
      collectedAt: o.collectedAt ?? runCreatedAt.get(o.runId) ?? "",
      text: markdownToText(o.answerMarkdown ?? ""),
      sources: (sources[o.id] ?? []).map(({ url, title }) => ({ url, title })),
      brandsMentioned: (matches[o.id] ?? [])
        .filter((match) => match.mentioned)
        .map((match) => match.name),
    }),
  );
  return { answers, truncated: runs.length === MAX_RUNS };
}

/**
 * The searched brand or domain, with the name and site of the project brand or
 * competitor it names, so "bandidos.co" also counts answers that say
 * "Bandidos" and "Bandidos" also counts answers that cite bandidos.co.
 */
function lookupBrand(
  detected: ReturnType<typeof detectTarget>,
  known: AiBrand[],
  siteScope: "domain" | "subdomains",
): LookupBrand {
  const brand = known.find((candidate) =>
    detected.type === "domain"
      ? ownedAiDomain(detected.value, candidate.domain)
      : candidate.name.localeCompare(detected.value, undefined, {
          sensitivity: "base",
        }) === 0,
  );
  const domain = detected.type === "domain" ? detected.value : brand?.domain;
  const site = domain ? parseResearchTarget(domain, siteScope) : null;
  return {
    label: detected.value,
    names: [detected.value, brand?.name ?? ""],
    site: site?.ok ? site.target : null,
    own: brand?.own ?? false,
  };
}

function mentions(answer: Answer, brand: LookupBrand): boolean {
  const site = brand.site;
  return (
    aiMentionSpans(answer.text, brand.names).length > 0 ||
    (site !== null &&
      answer.sources.some((source) =>
        urlMatchesResearchTarget(source.url, site),
      ))
  );
}

function shapeTopPages(
  hits: Answer[],
  pageFilter: ResearchTarget | null,
): BrandLookupResult["topPages"] {
  const pages = new Map<
    string,
    {
      url: string;
      platform: BrandLookupPlatform;
      answers: number;
      prompts: Set<string>;
    }
  >();
  for (const hit of hits) {
    for (const url of unique(hit.sources.map((source) => source.url))) {
      const safeUrl = safeHttpUrl(url);
      if (!safeUrl || safeUrl.length > 2048) continue;
      if (pageFilter && !urlMatchesResearchTarget(safeUrl, pageFilter))
        continue;
      const key = `${hit.platform}::${safeUrl}`;
      const page = pages.get(key) ?? {
        url: safeUrl,
        platform: hit.platform,
        answers: 0,
        prompts: new Set<string>(),
      };
      page.answers++;
      page.prompts.add(hit.prompt.slice(0, 500));
      pages.set(key, page);
    }
  }
  const byPlatform = groupBy([...pages.values()], (page) => page.platform);
  return sortBy(
    Object.values(byPlatform).flatMap((list) =>
      sortBy(list, [(page) => page.answers, "desc"]).slice(
        0,
        TOP_SOURCES_PER_PLATFORM,
      ),
    ),
    [(page) => page.answers, "desc"],
  )
    .slice(0, 40)
    .map((page) => ({
      url: page.url,
      domain: safeHostname(page.url),
      platform: page.platform,
      mentions: page.answers,
      capturedVolume: null,
      keywords: [...page.prompts]
        .slice(0, PROMPTS_PER_SOURCE)
        .map((question) => ({ question, aiSearchVolume: null })),
    }));
}

/** One row per prompt and engine, most often matched first. */
function shapeTopQueries(hits: Answer[]): BrandLookupResult["topQueries"] {
  const groups = groupBy(hits, (hit) => `${hit.platform}::${hit.promptId}`);
  const rows = Object.values(groups).map((group) => {
    const sorted = sortBy(group, [(hit) => hit.collectedAt, "asc"]);
    const latest = sorted[sorted.length - 1];
    return {
      count: group.length,
      row: {
        question: latest.prompt.slice(0, 500),
        platform: latest.platform,
        aiSearchVolume: null,
        firstSeenAt: sorted[0].collectedAt,
        lastSeenAt: latest.collectedAt,
        citedSources: latest.sources
          .flatMap((source) => {
            const url = safeHttpUrl(source.url);
            return url && url.length <= 2048
              ? [
                  {
                    url,
                    domain: safeHostname(url),
                    title: source.title?.slice(0, 300) ?? null,
                  },
                ]
              : [];
          })
          .slice(0, 10),
        brandsMentioned: latest.brandsMentioned
          .map((name) => name.slice(0, 200))
          .slice(0, 20),
      },
    };
  });
  const byPlatform = groupBy(rows, (entry) => entry.row.platform);
  const ranked = (list: typeof rows) =>
    sortBy(
      list,
      [(entry) => entry.count, "desc"],
      [(entry) => entry.row.lastSeenAt ?? "", "desc"],
    );
  return ranked(
    Object.values(byPlatform).flatMap((list) =>
      ranked(list).slice(0, TOP_QUERIES_PER_PLATFORM),
    ),
  )
    .slice(0, 50)
    .map((entry) => entry.row);
}

/** Answers that mention each brand, as a share of all those mentions. */
function shapeShareOfVoice(
  answers: Answer[],
  brands: LookupBrand[],
  engines: BrandLookupPlatform[],
): NonNullable<BrandLookupResult["shareOfVoice"]> {
  const counts = brands.map(
    (brand) => answers.filter((answer) => mentions(answer, brand)).length,
  );
  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    platforms: engines,
    entries: sortBy(
      brands.map((brand, index) => ({
        label: brand.label,
        isTarget: index === 0,
        mentions: counts[index],
        sharePct: total > 0 ? (counts[index] / total) * 100 : null,
      })),
      [(entry) => entry.mentions, "desc"],
    ),
  };
}
