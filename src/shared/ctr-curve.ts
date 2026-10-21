// OpenSEO's one click-through-rate curve: the share of a query's searches
// that click the result at each position of Google's first page. Every
// estimate built on positions (visibility, estimated traffic) reads it, so
// two features never disagree, and recalibrating it, for example from the
// owned sites' Search Console clicks by position, is one change here. The
// values follow published CTR studies: about 28% at #1, under 3% at #10.
const FIRST_PAGE_CTR = [
  0.276, 0.158, 0.11, 0.084, 0.063, 0.049, 0.039, 0.033, 0.027, 0.024,
];

// With an AI Overview on the page, results below it get fewer clicks:
// 2025 studies measured from about a third to over half fewer. This takes 40%.
const AI_OVERVIEW_FACTOR = 0.6;

/**
 * The expected CTR (0-1) at a 1-based position of a page, lower when the
 * page shows an AI Overview. Past the first page it is 0.
 */
export function ctrAt(position: number, page: { aiOverview: boolean }): number {
  const ctr = FIRST_PAGE_CTR[position - 1] ?? 0;
  return page.aiOverview ? ctr * AI_OVERVIEW_FACTOR : ctr;
}
