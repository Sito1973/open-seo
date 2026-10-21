import { entries } from "remeda";
import { getDomain } from "tldts";
import { z } from "zod";
import {
  CRUX_METRICS,
  fetchCruxHistory,
  fetchCruxRecord,
} from "@/server/lib/chromeUxReport";
import { AppError } from "@/server/lib/errors";
import {
  getOptionalEnvValue,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable } from "@/server/mcp/table";
import { parseResearchTarget } from "@/shared/researchScope";

// Real-user Core Web Vitals from the Chrome UX Report. Registered only on the
// self-hosted MCP transport. It reuses GOOGLE_PAGESPEED_API_KEY, but unlike the
// Lighthouse checks it also runs next to DATAFORSEO_API_KEY: DataForSEO has no
// CrUX data for it to stand in for, and the CrUX API is free.

const SOURCE_NOTE =
  "Source: Chrome UX Report (CrUX) by Google. Real Chrome users worldwide (no country filter); Chrome on iOS is not counted.";

const NOT_CONFIGURED =
  "Real-user Core Web Vitals need GOOGLE_PAGESPEED_API_KEY, with the Chrome UX Report API enabled on the key, on a self-hosted install. See docs/SELF_HOSTING_GOOGLE_APIS.md.";

const FORM_FACTORS = {
  phone: "PHONE",
  desktop: "DESKTOP",
  all: undefined,
} as const;

type Level = "origin" | "url";
type Device = keyof typeof FORM_FACTORS;

const inputSchema = {
  projectId: projectIdSchema,
  targets: z
    .array(z.string().min(1).max(2048))
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Up to 5 sites or pages to compare: origins (https://www.example.com), bare domains (example.com; www. is tried when the bare domain has no data) or page URLs. Default: the project's domain.",
    ),
  level: z
    .enum(["origin", "url"])
    .optional()
    .describe(
      "origin (default): every page of each site combined. url: only the exact page given, which needs far more traffic to have data.",
    ),
  device: z
    .enum(["phone", "desktop", "all"])
    .optional()
    .describe(
      "Omit for phone and desktop side by side. all combines every device (tablet too) and has data more often on low-traffic sites.",
    ),
  historyWeeks: z
    .number()
    .int()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Also return up to 40 weekly p75 values from the CrUX History API (updated Mondays), each over the 28 days ending that week. Omit for the current data only.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

/**
 * The origins or URLs to try for one target, in order. CrUX keys data by the
 * exact address visitors land on, and project domains are stored as bare apex
 * domains that often redirect to www, so a bare apex domain also tries www.
 */
function cruxCandidates(input: string, level: Level): string[] {
  const trimmed = input.trim();
  const checked = parseResearchTarget(trimmed);
  if (!checked.ok) {
    throw new AppError("VALIDATION_ERROR", `${input}: ${checked.message}`);
  }
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError("VALIDATION_ERROR", `${input}: use an http(s) URL.`);
  }
  url.hash = "";
  const key = (value: URL) => (level === "origin" ? value.origin : value.href);
  if (hasScheme || getDomain(url.hostname) !== url.hostname) return [key(url)];
  const www = new URL(url);
  www.hostname = `www.${url.hostname}`;
  return [key(url), key(www)];
}

async function fetchRow(input: {
  apiKey: string;
  target: string;
  candidates: string[];
  level: Level;
  device: Device;
  historyWeeks?: number;
}) {
  const { apiKey, target, candidates, level, device, historyWeeks } = input;
  const formFactor = FORM_FACTORS[device];
  for (const candidate of candidates) {
    const cruxTarget =
      level === "origin" ? { origin: candidate } : { url: candidate };
    const record = await fetchCruxRecord({
      apiKey,
      target: cruxTarget,
      formFactor,
    });
    if (!record) continue;
    const history = historyWeeks
      ? await fetchCruxHistory({
          apiKey,
          target: cruxTarget,
          formFactor,
          weeks: historyWeeks,
        })
      : undefined;
    return {
      target,
      device,
      hasData: true as const,
      ...record,
      ...(history === undefined ? {} : { history }),
    };
  }
  return { target, device, hasData: false as const, tried: candidates };
}

type Row = Awaited<ReturnType<typeof fetchRow>>;
type DataRow = Extract<Row, { hasData: true }>;
type HistoryWeek = NonNullable<
  Awaited<ReturnType<typeof fetchCruxHistory>>
>[number];

function formatValue(value: number, unit: string) {
  return unit
    ? `${Math.round(value).toLocaleString("en-US")} ${unit}`
    : value.toFixed(2);
}

function deviceLabel(device: Device) {
  return device === "all" ? "all devices" : device;
}

function formatShare(share: number | null) {
  return share == null ? "?" : `${Math.round(share * 100)}%`;
}

const ASSESSMENT_TEXT = {
  passed: "passed",
  failed: "failed",
  not_assessed: "not assessed (LCP or CLS lacks data)",
} as const;

function formatDataRow(row: DataRow): string[] {
  const lines = [
    `${row.key ?? row.target} (${deviceLabel(row.device)}), 28 days ending ${row.collectionPeriod.lastDate}: Core Web Vitals ${ASSESSMENT_TEXT[row.coreWebVitals]}`,
    ...entries(CRUX_METRICS).map(([key, { label, unit }]) => {
      const metric = row.metrics[key];
      return metric
        ? `  ${label} ${formatValue(metric.p75, unit)} ${metric.rating.replace("_", " ")} (good ${formatShare(metric.good)}, needs improvement ${formatShare(metric.needsImprovement)}, poor ${formatShare(metric.poor)})`
        : `  ${label}: not enough data`;
    }),
  ];
  if (row.history === null) {
    lines.push("  Weekly history: no data.");
  } else if (row.history) {
    lines.push(
      "  Weekly p75 history (oldest first):",
      formatMcpTable(row.history, [
        { header: "28 days ending", value: (week) => week.windowEnd },
        ...entries(CRUX_METRICS).map(([key, { label, unit }]) => ({
          header: unit ? `${label} ${unit}` : label,
          value: (week: HistoryWeek) => week[key],
        })),
      ]),
    );
  }
  return lines;
}

function formatRow(row: Row): string[] {
  if (row.hasData) return formatDataRow(row);
  return [
    `${row.target} (${deviceLabel(row.device)}): no field data. CrUX has too few Chrome visits in the last 28 days for ${row.tried.join(" or ")}, or visitors land on another address (check https and www). The site audit's Lighthouse lab checks still work.`,
  ];
}

export const getCoreWebVitalsTool = {
  name: "get_core_web_vitals",
  config: {
    title: "Get real-user Core Web Vitals",
    description:
      "Real-user Core Web Vitals from the Chrome UX Report (CrUX) for any public site, to compare the project's sites with competitors: p75 LCP, INP, CLS, FCP and TTFB, the share of good / needs-improvement / poor page loads, and Google's Core Web Vitals pass or fail, over the last 28 days. historyWeeks adds up to 40 weekly p75 values. Sites with too few Chrome visits return no field data; the site audit's Lighthouse checks are lab data that work for any site. Self-hosted installs with GOOGLE_PAGESPEED_API_KEY only. Read-only; uses no credits.",
    inputSchema,
    outputSchema: z.looseObject({
      provider: z.string(),
      level: z.string(),
      rows: z.array(looseObjectOutputSchema),
      source: z.string(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const apiKey = (await isHostedServerAuthMode())
      ? null
      : await getOptionalEnvValue("GOOGLE_PAGESPEED_API_KEY");
    if (!apiKey) throw new AppError("AUTH_CONFIG_MISSING", NOT_CONFIGURED);

    const level = args.level ?? "origin";
    const targets =
      args.targets ?? (context.project.domain ? [context.project.domain] : []);
    if (targets.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "This project has no domain. Pass targets.",
      );
    }
    const devices: Device[] = args.device
      ? [args.device]
      : ["phone", "desktop"];
    // Validate every target before the first request is sent.
    const plans = targets.map((target) => ({
      target,
      candidates: cruxCandidates(target, level),
    }));

    const rows = await Promise.all(
      plans.flatMap((plan) =>
        devices.map((device) =>
          fetchRow({
            apiKey,
            ...plan,
            level,
            device,
            historyWeeks: args.historyWeeks,
          }),
        ),
      ),
    );

    const header = `Real-user Core Web Vitals (${level} level): p75 values, rated with Google's thresholds, and the share of page loads that were good, needs improvement or poor.`;
    return mcpResponse({
      text: [header, ...rows.flatMap(formatRow), SOURCE_NOTE].join("\n"),
      meta: buildProjectMeta(context, args.projectId),
      structuredContent: {
        provider: "chrome_ux_report",
        level,
        rows,
        source: SOURCE_NOTE,
      },
    });
  }),
};
