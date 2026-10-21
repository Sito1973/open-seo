import { createServerFn } from "@tanstack/react-start";
import {
  deleteSavedKeywordTagSchema,
  researchKeywordsSchema,
  saveKeywordsSchema,
  getSavedKeywordsSchema,
  exportSavedKeywordsSchema,
  removeSavedKeywordsSchema,
  refreshSavedKeywordMetricsSchema,
  estimateKeywordDifficultySchema,
  serpAnalysisSchema,
  updateSavedKeywordTagSchema,
  updateSavedKeywordTagsSchema,
} from "@/types/schemas/keywords";
import { KeywordResearchService } from "@/server/features/keywords/services/KeywordResearchService";
import {
  difficultyEstimateStatus,
  estimateProjectKeywordDifficulty,
} from "@/server/features/serp/services/difficultyEstimate";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";
import { resolveMarket } from "@/shared/keyword-locations";

function shouldUseKeywordE2eFixtures() {
  return import.meta.env.VITE_E2E_KEYWORD_FIXTURES === "1";
}

async function getKeywordE2eFixtures() {
  return import("../../tests/fixtures/keyword-research-fixtures");
}

export const researchKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(researchKeywordsSchema)
  .handler(async ({ data, context }) => {
    const input = {
      ...data,
      ...resolveMarket(data, context.project),
      projectId: context.projectId,
    };
    if (shouldUseKeywordE2eFixtures()) {
      const fixtures = await getKeywordE2eFixtures();
      return fixtures.getKeywordResearchFixture(input);
    }

    return KeywordResearchService.research(input, context);
  });

export const saveKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(saveKeywordsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.saveKeywords({
      ...data,
      ...resolveMarket(data, context.project),
      projectId: context.projectId,
    });
  });

export const getSavedKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getSavedKeywordsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.getSavedKeywords({
      ...data,
      projectId: context.projectId,
    });
  });

export const exportSavedKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(exportSavedKeywordsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.exportSavedKeywords({
      ...data,
      projectId: context.projectId,
    });
  });

export const updateSavedKeywordTags = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateSavedKeywordTagsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.updateSavedKeywordTags({
      ...data,
      projectId: context.projectId,
    });
  });

export const updateSavedKeywordTag = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateSavedKeywordTagSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.updateSavedKeywordTag({
      ...data,
      projectId: context.projectId,
    });
  });

export const deleteSavedKeywordTag = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(deleteSavedKeywordTagSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.deleteSavedKeywordTag({
      ...data,
      projectId: context.projectId,
    });
  });

export const removeSavedKeywords = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(removeSavedKeywordsSchema)
  .handler(async ({ data, context }) => {
    return KeywordResearchService.removeSavedKeywords(context.projectId, data);
  });

export const refreshSavedKeywordMetrics = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(refreshSavedKeywordMetricsSchema)
  .handler(async ({ context }) => {
    return KeywordResearchService.refreshSavedKeywordMetrics(
      { projectId: context.projectId },
      context,
    );
  });

export const getSerpAnalysis = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(serpAnalysisSchema)
  .handler(async ({ data, context }) =>
    KeywordResearchService.getSerpAnalysis(
      {
        ...data,
        ...resolveMarket(data, context.project),
        projectId: context.projectId,
      },
      context,
    ),
  );

/** Whether this server estimates keyword difficulty. */
export const getKeywordDifficultyEstimateStatus = createServerFn({
  method: "GET",
})
  .middleware(requireAuthenticatedContext)
  .handler(() => difficultyEstimateStatus());

/**
 * OpenSEO's keyword difficulty estimates for up to 50 keywords: free from
 * saved Google pages, at most 10 searched live on Bright Data per call.
 */
export const estimateKeywordDifficulty = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(estimateKeywordDifficultySchema)
  .handler(async ({ data, context }) => {
    const result = await estimateProjectKeywordDifficulty({
      organizationId: context.organizationId,
      project: context.project,
      keywords: data.keywords,
      locationCode: data.locationCode,
      languageCode: data.languageCode,
    });
    return {
      estimated: result.estimates.filter(
        (estimate) => estimate.keywordDifficulty != null,
      ).length,
      // A page without a local pack needs Open PageRank for an estimate.
      withoutEstimate: result.estimates
        .filter((estimate) => estimate.keywordDifficulty == null)
        .map((estimate) => estimate.keyword),
      searchedLive: result.estimates.filter(
        (estimate) => estimate.source === "live",
      ).length,
      failed: result.failed.map(({ keyword, reason }) => ({
        keyword,
        error: reason instanceof Error ? reason.message : String(reason),
      })),
      notChecked: result.notChecked,
      authorityUnavailable: result.authorityUnavailable,
    };
  });
