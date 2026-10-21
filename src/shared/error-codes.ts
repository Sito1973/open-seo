import { z } from "zod";

const ERROR_CODES = [
  "UNAUTHENTICATED",
  "AUTH_CONFIG_MISSING",
  "PAYMENT_REQUIRED",
  "INSUFFICIENT_CREDITS",
  "FORBIDDEN",
  "NOT_FOUND",
  "AUDIT_CAPACITY_REACHED",
  "AUDIT_PAGE_LIMIT_EXCEEDED",
  "AUDIT_ALREADY_RUNNING",
  "AUDIT_RENDERING_UNAVAILABLE",
  "VALIDATION_ERROR",
  "UNKNOWN_LOCATION",
  "CRAWL_TARGET_BLOCKED",
  "BACKLINKS_BILLING_ISSUE",
  "AI_SEARCH_BILLING_ISSUE",
  "AI_VISIBILITY_ERROR",
  "DATAFORSEO_AUTH_FAILED",
  "GOOGLE_ADS_NOT_CONNECTED",
  "GOOGLE_ADS_ACCESS_PENDING",
  "RATE_LIMITED",
  "MONTHLY_BUDGET_EXHAUSTED",
  "PROVIDER_NOT_CONFIGURED",
  "UPSTREAM_UNAVAILABLE",
  "CONFLICT",
  "INTERNAL_ERROR",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

const NON_REPORTABLE_ERROR_CODES = new Set<ErrorCode>([
  "UNAUTHENTICATED",
  // External throttling (Google Analytics quota, Autumn, DataForSEO): expected
  // and transient, and nothing in the app can act on it.
  "RATE_LIMITED",
  // A self-hosted provider budget doing its job.
  "MONTHLY_BUDGET_EXHAUSTED",
  // A self-hosted install without a data source for the feature: setup the
  // owner acts on, not a bug.
  "PROVIDER_NOT_CONFIGURED",
  "NOT_FOUND",
  "PAYMENT_REQUIRED",
  "INSUFFICIENT_CREDITS",
  "VALIDATION_ERROR",
  "UNKNOWN_LOCATION",
  "AI_VISIBILITY_ERROR",
  "AUDIT_CAPACITY_REACHED",
  "AUDIT_PAGE_LIMIT_EXCEEDED",
  "AUDIT_ALREADY_RUNNING",
  "AUDIT_RENDERING_UNAVAILABLE",
  // Self-hosted Keyword Planner setup states the owner acts on.
  "GOOGLE_ADS_NOT_CONNECTED",
  "GOOGLE_ADS_ACCESS_PENDING",
  // An external provider (DataForSEO) failing on its own side. Nothing in the
  // app to fix, and it drowned real exceptions. Note the error handlers only
  // log what they capture, so every throw site warns on its own line to keep
  // the failure rate visible in Workers Observability.
  "UPSTREAM_UNAVAILABLE",
]);

export function isErrorCode(value: string): value is ErrorCode {
  return errorCodeSchema.safeParse(value).success;
}

export function shouldCaptureAppErrorCode(
  code: ErrorCode | null | undefined,
): boolean {
  return code == null || !NON_REPORTABLE_ERROR_CODES.has(code);
}
