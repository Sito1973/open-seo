import { getDomainWithoutSuffix } from "tldts";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import type { KeywordIntent } from "@/types/keywords";

// OpenSEO's own search intent for Spanish keywords, for the self-hosted
// Keyword Planner, which reports none. The rules run where the Planner's
// answers are normalized (keywordPlannerItems.ts), so every path that stores
// keyword metrics gets the same intent from the same keyword text. The word
// lists are written without accents; keywords are compared the same way.

const TRANSACTIONAL = [
  "domicilio",
  "domicilios",
  "pedir",
  "pedido",
  "pedidos",
  "ordenar",
  "reservar",
  "reserva",
  "reservas",
  "rappi",
  "didi food",
  "delivery",
  "para llevar",
  "abierto ahora",
  "abiertos ahora",
  "cerca de mi",
  "cerca a mi",
  "24 horas",
];

const INFORMATIONAL = [
  "receta",
  "recetas",
  "como",
  "que es",
  "historia",
  "calorias",
  "ingredientes",
];

const COMMERCIAL = [
  "mejor",
  "mejores",
  "barato",
  "baratos",
  "barata",
  "baratas",
  "economico",
  "economicos",
  "precio",
  "precios",
  "menu",
  "carta",
  "opiniones",
  "resenas",
  "vs",
];

// A brand this long also matches with its spaces removed, so "burger land"
// finds burgerland.co. Shorter ones match whole words only: "sumo" must not
// match "consumo".
const MIN_COMPACT_BRAND_LENGTH = 6;

export type IntentRules = { brandTerms: string[] };

/** Lowercase words without accents or punctuation, padded with spaces. */
function normalize(text: string): string {
  const words = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ` ${words} `;
}

function hasPhrase(keyword: string, phrases: string[]): boolean {
  return phrases.some((phrase) => keyword.includes(` ${phrase} `));
}

function mentionsBrand(keyword: string, brand: string): boolean {
  if (keyword.includes(` ${brand} `)) return true;
  const compact = brand.replaceAll(" ", "");
  return (
    compact.length >= MIN_COMPACT_BRAND_LENGTH &&
    keyword.replaceAll(" ", "").includes(compact)
  );
}

/**
 * The rules for one project's keywords in one language, or null when OpenSEO
 * has none for the language: only Spanish has word lists. The project's brands
 * are its own domain name and its competitors' names and domain names, from
 * Project Context. The caller has already authorized the project.
 */
export async function loadIntentRules(
  projectId: string,
  languageCode: string,
): Promise<IntentRules | null> {
  if (languageCode !== "es") return null;
  const [project, competitors] = await Promise.all([
    ProjectRepository.getProjectById(projectId),
    ProjectContextRepository.listCompetitors(projectId),
  ]);
  // Project names are free text such as "Main site", so only the domain counts.
  const names = [
    project?.domain ? getDomainWithoutSuffix(project.domain) : null,
    ...competitors.flatMap((competitor) => [
      competitor.name,
      getDomainWithoutSuffix(competitor.domain),
    ]),
  ];
  const brandTerms = new Set(
    names.flatMap((name) => {
      const brand = name ? normalize(name).trim() : "";
      return brand.length >= 3 ? [brand] : [];
    }),
  );
  return { brandTerms: [...brandTerms] };
}

/**
 * Intent by the first rule that matches, or null. A known brand wins, so
 * "bandidos domicilio" is navigational. Informational words come before
 * commercial ones: "mejor receta de hamburguesa" asks how to cook. Google's
 * brand concept, which only keyword ideas carry, comes last, so text rules give
 * the same answer on every path.
 */
export function ruleIntent(
  rules: IntentRules,
  keyword: string,
  googleBrandConcept = false,
): KeywordIntent | null {
  const text = normalize(keyword);
  if (rules.brandTerms.some((brand) => mentionsBrand(text, brand))) {
    return "navigational";
  }
  if (hasPhrase(text, TRANSACTIONAL)) return "transactional";
  if (hasPhrase(text, INFORMATIONAL)) return "informational";
  if (hasPhrase(text, COMMERCIAL)) return "commercial";
  return googleBrandConcept ? "navigational" : null;
}
