import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import type { KeywordPlannerConfig } from "@/server/lib/keywordPlannerConfig";

// Turns a failed Google Ads API response into an error the owner can act on.

const ACCESS_PENDING_MESSAGE =
  "Google Ads API access pending (Explorer level blocks Keyword Planner). Keyword volumes start working once Google approves Basic access for the Google Cloud project that owns GOOGLE_ADS_CLIENT_ID: apply on that project's Google Ads API Overview page in the Cloud Console. See docs/SELF_HOSTING_GOOGLE_APIS.md.";

// What a project below Basic access gets from KeywordPlanIdeaService. The
// developer token code predates the September 2026 sunset.
const ACCESS_PENDING_CODES = new Set([
  "authorizationError.SERVICE_ACCESS_DENIED",
  "authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
  "authorizationError.DEVELOPER_TOKEN_NOT_APPROVED",
]);

const errorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    details: z
      .array(
        z.looseObject({
          reason: z.string().optional(),
          errors: z
            .array(
              z.object({
                errorCode: z.record(z.string(), z.unknown()).optional(),
                message: z.string().optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
  }),
});

export function googleAdsApiError(
  status: number,
  payload: unknown,
  config: KeywordPlannerConfig,
): AppError {
  const parsed = errorBodySchema.safeParse(payload);
  const details = parsed.success ? (parsed.data.error.details ?? []) : [];
  const errors = details.flatMap((detail) => detail.errors ?? []);
  // "authorizationError.SERVICE_ACCESS_DENIED" from a GoogleAdsFailure, or an
  // ErrorInfo reason such as SERVICE_DISABLED.
  const codes = [
    ...errors.flatMap((error) =>
      Object.entries(error.errorCode ?? {}).map(
        ([kind, value]) => `${kind}.${String(value)}`,
      ),
    ),
    ...details.flatMap((detail) => (detail.reason ? [detail.reason] : [])),
  ];
  const message =
    errors.find((error) => error.message)?.message ??
    (parsed.success ? parsed.data.error.message : undefined) ??
    `HTTP ${status}`;
  console.warn("google_ads.api_error", { status, codes });

  if (codes.some((code) => ACCESS_PENDING_CODES.has(code))) {
    return new AppError("GOOGLE_ADS_ACCESS_PENDING", ACCESS_PENDING_MESSAGE);
  }
  if (
    status === 401 ||
    codes.some((code) => code.startsWith("authenticationError."))
  ) {
    return new AppError(
      "GOOGLE_ADS_NOT_CONNECTED",
      `Google Ads rejected the saved connection (${message}). Reconnect Google Ads in OpenSEO under a project's Settings → Integrations.`,
    );
  }
  if (status === 429 || codes.some((code) => code.startsWith("quotaError."))) {
    return new AppError(
      "RATE_LIMITED",
      `Google Ads API quota reached (${message}). Keyword Planner allows one request per second and Basic access 15,000 operations a day; try again later.`,
    );
  }
  if (status === 403) {
    return new AppError(
      "FORBIDDEN",
      `The Google Ads API refused the request: ${message} Check that the Google Ads API is enabled in the Cloud project that owns GOOGLE_ADS_CLIENT_ID, that the connected Google account can open customer ${config.customerId}, and that GOOGLE_ADS_LOGIN_CUSTOMER_ID names the manager account it goes through.`,
    );
  }
  return new AppError(
    status >= 500 ? "UPSTREAM_UNAVAILABLE" : "VALIDATION_ERROR",
    `Google Ads API: ${message}`,
  );
}
