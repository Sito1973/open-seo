import {
  AiVisibilityRepository as repo,
  type ConfigurationRows,
} from "../repositories/AiVisibilityRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import type { AiTrackerPatch } from "@/types/schemas/ai-visibility";
import { projectAiConfiguration } from "./aiVisibilityConfiguration";
import { aiCollectionProvider, requireAiEngines } from "./aiVisibilityProvider";

export async function requireConfiguration(projectId: string) {
  const config = await repo.getConfiguration(projectId);
  if (!config)
    throw new AiVisibilityError(
      "TRACKER_REQUIRED",
      "Save prompts with save_ai_visibility_tracker before starting collection.",
    );
  return config;
}

/**
 * Applies a patch to the saved tracker, or to a new one in the project's
 * market. Engines must be ones this server can collect; a new tracker on a
 * SerpApi-only server starts on Google AI Mode.
 */
export async function projectPatch(
  projectId: string,
  rawPatch: AiTrackerPatch,
  previous: ConfigurationRows | null,
) {
  const provider = await aiCollectionProvider();
  const patch =
    !previous && !rawPatch.engines && provider === "serpapi"
      ? { ...rawPatch, engines: ["google_ai_mode" as const] }
      : rawPatch;
  if (patch.engines) requireAiEngines(patch.engines, provider);
  const project = await repo.getProject(projectId);
  if (!project)
    throw new AiVisibilityError(
      "PROJECT_NOT_FOUND",
      "The selected project is not available.",
    );
  if (!project.domain)
    throw new AiVisibilityError(
      "BRAND_REQUIRED",
      "Set your project's website before configuring or running AI tracking.",
    );
  return projectAiConfiguration({
    previous,
    projectId,
    projectMarket: {
      locationCode: project.locationCode,
      languageCode: project.languageCode,
    },
    patch,
    now: new Date().toISOString(),
  });
}
