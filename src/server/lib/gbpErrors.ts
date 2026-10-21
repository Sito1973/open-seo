/**
 * Why a Business Profile call failed, as the caller can act on it:
 * - api_access_pending: Google has not approved this Cloud project for the
 *   Business Profile APIs yet (quota 0), or an API is not enabled.
 * - permission_denied: the Google account cannot read this account/location.
 * - reconnect: the grant expired or was revoked.
 */
export type GbpErrorReason =
  | "api_access_pending"
  | "permission_denied"
  | "reconnect"
  | "rate_limited"
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
