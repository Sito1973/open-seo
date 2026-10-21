import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import { backlinksUsd } from "@/server/lib/dataforseo/pricing";
import { AppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  BACKLINKS_MAX_ROWS_PER_REQUEST,
  parseBacklinksMonthlyRequests,
} from "@/shared/selfhost-checks";

/**
 * Takes one request from this month's (UTC) budget of Backlinks API requests,
 * DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS, on a server with
 * DATAFORSEO_SCOPE=backlinks, where DataForSEO bills the operator for every
 * request. A request whose estimate (pricing.ts) allows more than 1,000 rows
 * is refused, so a month costs at most the budget times backlinksUsd(1,000),
 * $0.06. Failed requests stay counted: the safe direction.
 */
export async function reserveBacklinksRequest(estimatedUsd: number) {
  if (estimatedUsd > backlinksUsd(BACKLINKS_MAX_ROWS_PER_REQUEST)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `This backlinks request could return more than ${BACKLINKS_MAX_ROWS_PER_REQUEST.toLocaleString("en-US")} rows, the most this server asks DataForSEO for at once, so it was not sent.`,
    );
  }
  const budget = parseBacklinksMonthlyRequests(
    await getOptionalEnvValue("DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS"),
  );
  if (budget === null) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS must be a whole number above 0, so no backlinks request was sent.",
    );
  }
  const month = new Date().toISOString().slice(0, 7);
  const used = await GooglePlacesUsageRepository.reserveCalls({
    month,
    sku: "dataforseo_backlinks",
    count: 1,
    limit: budget,
  });
  if (used == null) {
    throw new AppError(
      "MONTHLY_BUDGET_EXHAUSTED",
      `This server's monthly DataForSEO backlinks budget (${budget} requests in ${month}, UTC) is used up, so no request was sent. It resets on the 1st; DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS sets it.`,
    );
  }
}
