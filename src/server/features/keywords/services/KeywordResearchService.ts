import {
  deleteSavedKeywordTag,
  getSavedKeywords,
  getSerpAnalysis,
  keywordResearchSources,
  removeSavedKeywords,
  research,
  saveKeywords,
  exportSavedKeywords,
  updateSavedKeywordTag,
  updateSavedKeywordTags,
  refreshSavedKeywordMetrics,
} from "@/server/features/keywords/services/research";

export const KeywordResearchService = {
  research,
  keywordResearchSources,
  getSerpAnalysis,
  saveKeywords,
  getSavedKeywords,
  exportSavedKeywords,
  updateSavedKeywordTags,
  updateSavedKeywordTag,
  deleteSavedKeywordTag,
  removeSavedKeywords,
  refreshSavedKeywordMetrics,
} as const;
