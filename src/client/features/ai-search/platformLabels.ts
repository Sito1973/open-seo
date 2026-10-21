import type {
  BrandLookupPlatform,
  PromptExplorerModel,
} from "@/types/schemas/ai-search";

const MENTION_PLATFORM_LABELS: Record<BrandLookupPlatform, string> = {
  chat_gpt: "ChatGPT",
  google: "Google AI Overview",
  google_ai_mode: "Google AI Mode",
  gemini: "Gemini",
  claude: "Claude",
  perplexity: "Perplexity",
};

/**
 * Per-model accent colors. Applied as left-border + dot on response cards so
 * the model header is unambiguously separated from the markdown content that
 * follows. Values are Tailwind color tokens that work in light + dark themes.
 */
type ModelAccent = {
  border: string;
  dot: string;
};

const MODEL_ACCENTS: Record<PromptExplorerModel, ModelAccent> = {
  chat_gpt: {
    border: "border-l-emerald-500",
    dot: "bg-emerald-500",
  },
  claude: {
    border: "border-l-orange-500",
    dot: "bg-orange-500",
  },
  gemini: {
    border: "border-l-sky-500",
    dot: "bg-sky-500",
  },
  perplexity: {
    border: "border-l-violet-500",
    dot: "bg-violet-500",
  },
};

export function formatPlatformLabel(platform: BrandLookupPlatform): string {
  return MENTION_PLATFORM_LABELS[platform];
}

/** Shared per-platform accent dot + short label for compact table/KPI rows. */
export const PLATFORM_DOT_CLASS: Record<BrandLookupPlatform, string> = {
  chat_gpt: "bg-emerald-500",
  google: "bg-sky-500",
  google_ai_mode: "bg-blue-700",
  gemini: "bg-cyan-500",
  claude: "bg-orange-500",
  perplexity: "bg-violet-500",
};

export const PLATFORM_SHORT_LABEL: Record<BrandLookupPlatform, string> = {
  chat_gpt: "ChatGPT",
  google: "Google",
  google_ai_mode: "AI Mode",
  gemini: "Gemini",
  claude: "Claude",
  perplexity: "Perplexity",
};

export function getModelAccent(model: PromptExplorerModel): ModelAccent {
  return MODEL_ACCENTS[model];
}

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

/** Render a count for display. Null/undefined renders as an em-dash. */
export function formatCount(value: number | null | undefined): string {
  if (value == null) return "—";
  return NUMBER_FORMATTER.format(value);
}
