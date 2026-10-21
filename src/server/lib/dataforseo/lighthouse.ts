import { dataforseoPostResponse } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  DataforseoChargedTaskError,
  type DataforseoApiResponse,
  type DataforseoResponseLike,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import {
  parseDataforseoLighthousePayload,
  requestCategories,
  type LighthouseStrategy,
} from "@/server/lib/dataforseoLighthousePayload";
import {
  type StoredLighthousePayload,
  withLighthouseParseLock,
} from "@/server/lib/lighthouseStoredPayload";

const LIGHTHOUSE_PATH = "/v3/on_page/lighthouse/live/json";
const REQUEST_TIMEOUT_MS = 60_000;

export async function fetchLighthouseResult(input: {
  url: string;
  strategy: LighthouseStrategy;
}): Promise<DataforseoApiResponse<StoredLighthousePayload>> {
  // Billed, non-idempotent POST: a 5xx does not prove the provider skipped
  // the charge, so never replay it. The response is taken un-consumed (unlike
  // dataforseoPost) so the multi-MB body read happens inside the parse lock,
  // and the timeout is cleared once headers arrive — an armed signal would
  // otherwise cover a body read queued behind the lock past 60s and abort an
  // already-billed call unmetered.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await dataforseoPostResponse(
      LIGHTHOUSE_PATH,
      [
        {
          url: input.url,
          for_mobile: input.strategy === "mobile",
          categories: [...requestCategories],
        },
      ],
      { maxServerErrorRetries: 0, signal: controller.signal },
    );
  } finally {
    clearTimeout(timeout);
  }

  return withLighthouseParseLock(async () => {
    const body =
      await response.json<DataforseoResponseLike<DataforseoTaskLike>>();
    // Build the metering envelope before parsing. The provider has already
    // charged a successful task, so a malformed payload must carry its
    // billing metadata out to the metered client instead of looking
    // retryable.
    const task = assertOk(body);
    const billing = buildTaskBilling(task);
    try {
      const data = parseDataforseoLighthousePayload(body, input);
      return { data, billing };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DataforseoChargedTaskError(message, billing);
    }
  });
}
