import { createServerFn } from "@tanstack/react-start";
import { getBrandLookup } from "@/server/features/ai-search/services/brandLookup";
import { brandLookupFromTracker } from "@/server/features/ai-search/services/brandLookupFromTracker";
import { explorePrompt as runExplorePrompt } from "@/server/features/ai-search/services/promptExplorer";
import { assertPaidAiSearchPlan } from "@/server/features/ai-search/services/access";
import { usesGoogleFallbacks } from "@/server/lib/runtime-env";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";
import {
  brandLookupInputSchema,
  promptExplorerInputSchema,
} from "@/types/schemas/ai-search";

export const lookupBrand = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(brandLookupInputSchema)
  .handler(async ({ data, context }) => {
    await assertPaidAiSearchPlan(context.organizationId, "Brand Lookup");
    const input = { ...data, projectId: context.projectId };
    // Without DataForSEO's LLM Mentions API, count the answers this server's
    // own prompt tracker collected.
    if (await usesGoogleFallbacks()) return brandLookupFromTracker(input);
    return getBrandLookup(input, context);
  });

/** Where Brand Lookup reads from, so the page can say so before a search. */
export const getBrandLookupSource = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async () => ({
    collectedAnswers: await usesGoogleFallbacks(),
  }));

export const explorePrompt = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(promptExplorerInputSchema)
  .handler(async ({ data, context }) => {
    return runExplorePrompt({ ...data, projectId: context.projectId }, context);
  });
