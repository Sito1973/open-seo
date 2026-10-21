import { expect, it, vi } from "vitest";
import { ruleIntent } from "./intent";

// The module loads brand terms from the database, which these cases skip.
vi.mock("cloudflare:workers", () => ({ env: {} }));

const rules = { brandTerms: ["burgerland", "sumo"] };

it.each([
  ["Hamburguesas cerca de mí", false, "transactional"],
  ["burger land domicilio", false, "navigational"],
  ["sumo pereira", false, "navigational"],
  ["consumo de calorías", false, "informational"],
  ["mejor receta de hamburguesa", false, "informational"],
  ["menú hamburguesas", true, "commercial"],
  ["frisby", true, "navigational"],
  ["frisby", false, null],
] as const)("%s (Google brand: %s) is %s", (keyword, googleBrand, intent) => {
  expect(ruleIntent(rules, keyword, googleBrand)).toBe(intent);
});
