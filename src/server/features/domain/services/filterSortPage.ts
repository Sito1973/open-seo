import { sort } from "remeda";
import { parseFilterTerms } from "@/server/lib/dataforseo/filters";
import type { DomainKeywordsFilters } from "@/types/schemas/domain";

type NumberField<Row> = (row: Row) => number | null;

/** The min/max pairs of DomainKeywordsFilters: `min${key}` and `max${key}`. */
const RANGE_KEYS = ["Traffic", "Vol", "Cpc", "Kd", "Rank"] as const;

/**
 * Filters, sorts and pages domain table rows in memory, with the semantics the
 * DataForSEO-backed tables get from the provider: every include term must
 * appear and no exclude term may, a min/max range drops rows that have no
 * value, and the search term matches any search field (all case-insensitive).
 * Rows without a sort value go last; ties keep the input order.
 */
export function filterSortPage<Row>(
  rows: readonly Row[],
  fields: {
    /** Text the include/exclude terms match. */
    terms: (row: Row) => string;
    /** Texts the free-text search matches, any of them. */
    search: (row: Row) => Array<string | null>;
    ranges: Partial<Record<(typeof RANGE_KEYS)[number], NumberField<Row>>>;
  },
  query: {
    filters: DomainKeywordsFilters;
    search?: string;
    sortBy: NumberField<Row>;
    sortOrder: "asc" | "desc";
    offset: number;
    limit: number;
  },
): { rows: Row[]; totalCount: number; hasMore: boolean } {
  const include = parseFilterTerms(query.filters.include);
  const exclude = parseFilterTerms(query.filters.exclude);
  const search = query.search?.trim().toLowerCase();
  const ranges = RANGE_KEYS.flatMap((key) => {
    const value = fields.ranges[key];
    const min = query.filters[`min${key}`];
    const max = query.filters[`max${key}`];
    const hasMin = typeof min === "number" && Number.isFinite(min);
    const hasMax = typeof max === "number" && Number.isFinite(max);
    return value && (hasMin || hasMax)
      ? [{ value, min: hasMin ? min : null, max: hasMax ? max : null }]
      : [];
  });

  const matches = rows.filter((row) => {
    const text = fields.terms(row).toLowerCase();
    if (include.some((term) => !text.includes(term))) return false;
    if (exclude.some((term) => text.includes(term))) return false;
    if (
      search &&
      !fields.search(row).some((value) => value?.toLowerCase().includes(search))
    ) {
      return false;
    }
    return ranges.every(({ value, min, max }) => {
      const number = value(row);
      return (
        number != null &&
        (min == null || number >= min) &&
        (max == null || number <= max)
      );
    });
  });

  const direction = query.sortOrder === "asc" ? 1 : -1;
  const sorted = sort(matches, (a, b) => {
    const left = query.sortBy(a);
    const right = query.sortBy(b);
    if (left == null || right == null) {
      return Number(left == null) - Number(right == null);
    }
    return (left - right) * direction;
  });

  return {
    rows: sorted.slice(query.offset, query.offset + query.limit),
    totalCount: sorted.length,
    hasMore: query.offset + query.limit < sorted.length,
  };
}
