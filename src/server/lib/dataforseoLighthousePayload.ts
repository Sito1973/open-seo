import { z } from "zod";
import {
  buildStoredLighthousePayload,
  lighthouseReportSchema,
  type StoredLighthousePayload,
  summarizeZodIssues,
} from "@/server/lib/lighthouseStoredPayload";

export const requestCategories = [
  "performance",
  "accessibility",
  "best_practices",
  "seo",
] as const;

export type LighthouseStrategy = "mobile" | "desktop";

const dataforseoTaskSchema = z.object({
  id: z.string().optional(),
  cost: z.number().optional(),
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  result: z.array(lighthouseReportSchema).optional(),
});

const dataforseoLighthouseResponseSchema = z.object({
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  tasks: z.array(dataforseoTaskSchema).optional(),
});

export function parseDataforseoLighthousePayload(
  payload: unknown,
  input: { url: string; strategy: LighthouseStrategy },
): StoredLighthousePayload {
  // Only the envelope scalars are validated up front. The report is reduced
  // straight into the compact stored payload, which buildStoredLighthousePayload
  // then validates in full — the same fields the old whole-report schema
  // checked, at kilobyte size instead of multi-megabyte.
  const parsed = dataforseoLighthouseResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `DataForSEO Lighthouse returned an invalid response: ${summarizeZodIssues(parsed.error)}`,
    );
  }

  if (parsed.data.status_code !== 20000) {
    throw new Error(
      parsed.data.status_message ?? "DataForSEO Lighthouse request failed",
    );
  }

  const task = parsed.data.tasks?.[0];
  if (!task) {
    throw new Error("DataForSEO Lighthouse response missing task");
  }

  if (task.status_code !== 20000) {
    throw new Error(task.status_message ?? "DataForSEO Lighthouse task failed");
  }

  const result = task.result?.[0];
  if (!result) {
    throw new Error("DataForSEO Lighthouse response missing result");
  }

  return buildStoredLighthousePayload({
    report: result,
    request: input,
    source: "dataforseo-lighthouse",
    taskId: task.id ?? null,
    cost: task.cost ?? null,
    fetchedAt: new Date().toISOString(),
    providerLabel: "DataForSEO Lighthouse",
  });
}
