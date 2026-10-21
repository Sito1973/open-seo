/**
 * Why a Business Profile call failed, as the caller can act on it:
 * - api_access_pending: Google has not approved this Cloud project for the
 *   Business Profile APIs yet (quota 0), or an API is not enabled.
 * - permission_denied: the Google account cannot read this account/location.
 * - reconnect: the grant expired or was revoked, or lacks the scope.
 * - invalid_request: Google rejected the request itself (400/404/409: a
 *   validation error, an unknown review, data Google changed). The message
 *   carries Google's reason codes so the caller can fix the input.
 */
export type GbpErrorReason =
  | "api_access_pending"
  | "permission_denied"
  | "reconnect"
  | "rate_limited"
  | "invalid_request"
  | "other";

export class GbpApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reason: GbpErrorReason,
  ) {
    super(message);
    this.name = "GbpApiError";
  }
}

export class GbpTokenError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GbpTokenError";
  }
}

export class GbpNotConnectedError extends Error {
  constructor(public readonly projectId: string) {
    super("Google Business Profile is not connected for this project");
    this.name = "GbpNotConnectedError";
  }
}
