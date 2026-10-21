import type { z } from "zod";
import { getGoogleAccessToken } from "@/server/features/google/googleOAuth";
import {
  gbpAccountNameSchema,
  gbpLocationNameSchema,
  gbpReviewIdSchema,
  googleErrorSchema,
} from "@/server/lib/gbpApiSchemas";
import {
  GbpApiError,
  GbpTokenError,
  type GbpErrorReason,
} from "@/server/lib/gbpErrors";
import { GBP_OAUTH_PROVIDER_ID } from "@/shared/gbp";

// Authenticated requests to the Business Profile APIs, with Google's errors
// mapped to a GbpApiError the tools can act on. Shared by gbpClient (reads)
// and gbpListingApi (listing reads and edits).

export const BUSINESS_INFO_API_BASE =
  "https://mybusinessbusinessinformation.googleapis.com/v1";
/** Google My Business API v4: reviews, posts and food menus. */
export const V4_API_BASE = "https://mybusiness.googleapis.com/v4";
const MAX_ERROR_BODY_LENGTH = 8_000;
const MAX_REJECTION_MESSAGE = 600;

type GoogleError = z.infer<typeof googleErrorSchema>["error"];
type GoogleErrorDetail = NonNullable<GoogleError["details"]>[number];

/** v4 resources live under accounts/A/locations/L. The schemas keep a
 *  model-supplied id from adding path segments. */
export const v4LocationName = (input: {
  accountName: string;
  location: string;
}) =>
  `${gbpAccountNameSchema.parse(input.accountName)}/${gbpLocationNameSchema.parse(input.location)}`;

/** One v4 review; the reply lives at `${reviewUrl}/reply`. */
export const reviewUrl = (input: {
  accountName: string;
  location: string;
  reviewId: string;
}) =>
  `${V4_API_BASE}/${v4LocationName(input)}/reviews/${gbpReviewIdSchema.parse(input.reviewId)}`;

/** Follows nextPageToken until `max` items are collected or pages run out. */
export async function collectPages<T>(
  max: number,
  fetchPage: (
    pageToken: string | undefined,
  ) => Promise<{ items: T[]; nextPageToken?: string }>,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = await fetchPage(pageToken);
    items.push(...page.items);
    pageToken = page.nextPageToken || undefined;
  } while (pageToken && items.length < max);
  return items.slice(0, max);
}

function classifyError(
  status: number,
  details: GoogleErrorDetail[],
): { reason: GbpErrorReason; service?: string } {
  // Before Google approves a Cloud project for the Business Profile APIs,
  // every API has a quota of 0 requests and answers 429; an API that is not
  // enabled answers SERVICE_DISABLED.
  const pending = details.find(
    (detail) =>
      detail.reason === "SERVICE_DISABLED" ||
      detail.metadata?.quota_limit_value === "0",
  );
  if (pending) {
    return { reason: "api_access_pending", service: pending.metadata?.service };
  }
  if (
    status === 401 ||
    details.some(
      (detail) => detail.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
    )
  ) {
    return { reason: "reconnect" };
  }
  if (status === 403) return { reason: "permission_denied" };
  if (status === 429) return { reason: "rate_limited" };
  if (status === 400 || status === 404 || status === 409) {
    return { reason: "invalid_request" };
  }
  return { reason: "other" };
}

/** Google's own words plus its reason codes, so the agent can fix the input:
 *  "STRING_TOO_LONG on profile.description (max 750)". */
function describeRejection(error: GoogleError | undefined): string {
  const parts = (error?.details ?? []).flatMap((detail) => {
    const {
      field_mask: field,
      max_length: max,
      ...rest
    } = detail.metadata ?? {};
    const reason = detail.reason
      ? [
          [
            detail.reason,
            field ? `on ${field}` : "",
            max ? `(max ${max})` : "",
            ...Object.entries(rest).map(([key, value]) => `${key}=${value}`),
          ]
            .filter(Boolean)
            .join(" "),
        ]
      : [];
    const validation = (detail.errorDetails ?? []).map((item) =>
      [item.field, item.message].filter(Boolean).join(": "),
    );
    return [...reason, ...validation];
  });
  const text = [error?.message, ...parts].filter(Boolean).join("; ");
  return `Google rejected the request: ${text || "invalid request"}`.slice(
    0,
    MAX_REJECTION_MESSAGE,
  );
}

function messageFor(
  reason: GbpErrorReason,
  status: number,
  error: GoogleError | undefined,
  service?: string,
) {
  switch (reason) {
    case "api_access_pending":
      return `Google has not opened ${service ?? "the Business Profile APIs"} to this Google Cloud project yet: the API is disabled or its quota is 0 until Google approves the Business Profile API access request.`;
    case "reconnect":
      return "The Google Business Profile connection expired or was revoked.";
    case "permission_denied":
      return "Google denied access to this Business Profile account or location.";
    case "rate_limited":
      return "Google Business Profile rate limit reached. Retry in a minute.";
    case "invalid_request":
      return describeRejection(error);
    default:
      return `Google Business Profile API error (${status}).`;
  }
}

async function toApiError(response: Response): Promise<GbpApiError> {
  const body = await response
    .text()
    .then((text) => text.slice(0, MAX_ERROR_BODY_LENGTH))
    .catch(() => "");
  let error: GoogleError | undefined;
  try {
    const parsed = googleErrorSchema.safeParse(JSON.parse(body));
    if (parsed.success) error = parsed.data.error;
  } catch {
    // Non-JSON error pages collapse to a status-only error.
  }
  const { reason, service } = classifyError(
    response.status,
    error?.details ?? [],
  );
  return new GbpApiError(
    response.status,
    messageFor(reason, response.status, error, service),
    reason,
  );
}

export function createGbpRequest(opts: {
  userId: string;
  googleAccountId: string;
}) {
  let tokenPromise: Promise<string> | undefined;
  const accessToken = () =>
    (tokenPromise ??= getGoogleAccessToken({
      providerId: GBP_OAUTH_PROVIDER_ID,
      userId: opts.userId,
      accountId: opts.googleAccountId,
    }).catch((error: unknown) => {
      throw new GbpTokenError(
        "Could not mint a Google Business Profile access token.",
        error,
      );
    }));

  return async function request(
    method: "GET" | "PATCH" | "PUT" | "POST" | "DELETE",
    url: URL | string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await accessToken()}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new GbpApiError(
        0,
        "Google Business Profile is temporarily unavailable.",
        "other",
      );
    }
    if (!response.ok) throw await toApiError(response);
    // validateOnly PATCH and DELETE answer with an empty body.
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : {};
  };
}

export type GbpRequest = ReturnType<typeof createGbpRequest>;
