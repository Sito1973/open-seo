import type { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";

type LighthouseRow = Awaited<
  ReturnType<typeof AuditRepository.getLighthouseResultsForAudit>
>[number];

// The audit samples at most 10 pages, each checked on mobile and desktop.
const MAX_LIGHTHOUSE_ROWS = 20;

function formatMs(value: number | null) {
  return value == null ? "n/a" : `${Math.round(value)} ms`;
}

/**
 * Lighthouse checks for the listed pages, as structured rows plus one text
 * line each. Rows are keyed by page id, so `pages` supplies the URL.
 */
export function auditLighthouseRows(
  rows: LighthouseRow[],
  pages: Array<{ id: string; url: string }>,
) {
  const urlByPageId = new Map(pages.map((page) => [page.id, page.url]));
  const lighthouse = rows
    .flatMap((row) => {
      const url = urlByPageId.get(row.pageId);
      if (!url) return [];
      return [
        {
          url,
          strategy: row.strategy,
          performance: row.performanceScore,
          accessibility: row.accessibilityScore,
          bestPractices: row.bestPracticesScore,
          seo: row.seoScore,
          lcpMs: row.lcpMs,
          cls: row.cls,
          ttfbMs: row.ttfbMs,
          error: row.errorMessage,
        },
      ];
    })
    .slice(0, MAX_LIGHTHOUSE_ROWS);

  const lines = lighthouse.map((row) =>
    row.error
      ? `- Lighthouse ${row.strategy} ${row.url}: failed (${row.error})`
      : `- Lighthouse ${row.strategy} ${row.url}: performance ${row.performance ?? "n/a"}, accessibility ${row.accessibility ?? "n/a"}, best practices ${row.bestPractices ?? "n/a"}, SEO ${row.seo ?? "n/a"}; LCP ${formatMs(row.lcpMs)}, CLS ${row.cls?.toFixed(3) ?? "n/a"}, TTFB ${formatMs(row.ttfbMs)}`,
  );

  return { lighthouse, lines };
}
