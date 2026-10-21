import { isDeepEqual } from "remeda";
import { AppError } from "@/server/lib/errors";
import type { RawFoodMenu } from "@/server/lib/gbpListingApi";

// Item-level edits on a Business Profile food menu. Google only replaces the
// whole menus array, so edits run on a copy of the raw tree and every key
// they do not touch (allergens, options, photos, nutrition) goes back as is.

type Label = RawFoodMenu["labels"][number];
type RawSection = NonNullable<RawFoodMenu["sections"]>[number];
type RawItem = NonNullable<RawSection["items"]>[number];
type Money = NonNullable<NonNullable<RawItem["attributes"]>["price"]>;

export type MenuChange = {
  section: string;
  item: string;
  price?: number;
  /** "" removes the description. */
  description?: string;
  remove?: true;
};

type MenuValue = { price: number | null; description: string | null };

const sameName = (labels: Label[], name: string) =>
  labels.some(
    (label) =>
      label.displayName.trim().toLowerCase() === name.trim().toLowerCase(),
  );

const firstName = (labels: Label[]) => labels[0]?.displayName ?? "";

/** The label in the requested language, else the first one. */
const labelFor = (labels: Label[], languageCode: string) =>
  labels.find((label) => label.languageCode === languageCode) ?? labels[0];

function toMoney(amount: number, currencyCode: string): Money {
  const units = Math.trunc(amount);
  const nanos = Math.round((amount - units) * 1e9);
  return { currencyCode, units: String(units), ...(nanos ? { nanos } : {}) };
}

function fromMoney(money: Money | undefined): number | null {
  if (!money) return null;
  const amount = Number(money.units ?? 0) + (money.nanos ?? 0) / 1e9;
  return Math.round(amount * 100) / 100;
}

function itemValue(item: RawItem, languageCode: string): MenuValue {
  return {
    price: fromMoney(item.attributes?.price),
    description: labelFor(item.labels, languageCode)?.description ?? null,
  };
}

const allItems = (menus: RawFoodMenu[]) =>
  menus.flatMap((menu) =>
    (menu.sections ?? []).flatMap((section) =>
      (section.items ?? []).map((item) => ({ menu, section, item })),
    ),
  );

/** One row per item, for reading the menu. */
export function summarizeFoodMenus(menus: RawFoodMenu[]) {
  const rows = allItems(menus);
  return {
    currencyCode:
      rows.find((row) => row.item.attributes?.price?.currencyCode)?.item
        .attributes?.price?.currencyCode ?? null,
    items: rows.map(({ menu, section, item }) => ({
      menu: firstName(menu.labels),
      section: firstName(section.labels),
      item: firstName(item.labels),
      price: fromMoney(item.attributes?.price),
      description: item.labels[0]?.description ?? null,
    })),
  };
}

type Row = {
  field: string;
  before: MenuValue | null;
  after: MenuValue | null;
};
/** One effective change and the change that undoes it; null = no-op. */
type Edit = { row: Row; revert: MenuChange } | null;
type CurrencyFor = (existing: Money | undefined) => string;

const fieldOf = (change: MenuChange) => `${change.section} › ${change.item}`;

const findByName = <T extends { labels: Label[] }>(list: T[], name: string) =>
  list.find((candidate) => sameName(candidate.labels, name));

/** The named menu, else the first one. A name that matches no menu, or no
 *  menu at all, creates one: the undo of a removal that emptied a menu
 *  re-creates it by name. */
function pickMenu(
  menus: RawFoodMenu[],
  name: string | undefined,
  languageCode: string,
): RawFoodMenu {
  const menu = name ? findByName(menus, name) : menus[0];
  if (menu) return menu;
  const created = {
    labels: [{ displayName: name ?? "Menu", languageCode }],
    sections: [],
  };
  menus.push(created);
  return created;
}

function removeItem(
  sections: RawSection[],
  section: RawSection | undefined,
  item: RawItem | undefined,
  change: MenuChange,
  languageCode: string,
): Edit {
  const items = section?.items;
  if (!section || !items || !item) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${fieldOf(change)} is not on the menu.`,
    );
  }
  const before = itemValue(item, languageCode);
  items.splice(items.indexOf(item), 1);
  // Google requires at least one item per section.
  if (items.length === 0) sections.splice(sections.indexOf(section), 1);
  return {
    row: { field: fieldOf(change), before, after: null },
    revert: {
      section: change.section,
      item: change.item,
      ...(before.price === null ? {} : { price: before.price }),
      ...(before.description ? { description: before.description } : {}),
    },
  };
}

function setItem(
  item: RawItem,
  change: MenuChange,
  languageCode: string,
  currencyFor: CurrencyFor,
): Edit {
  const before = itemValue(item, languageCode);
  const after: MenuValue = {
    price: change.price ?? before.price,
    description:
      change.description === undefined
        ? before.description
        : change.description || null,
  };
  if (isDeepEqual(before, after)) return null;
  const priceChanged = after.price !== before.price;
  const descriptionChanged = after.description !== before.description;
  if (change.price !== undefined && priceChanged) {
    item.attributes = {
      ...item.attributes,
      price: toMoney(change.price, currencyFor(item.attributes?.price)),
    };
  }
  const label = labelFor(item.labels, languageCode);
  if (label && descriptionChanged) {
    if (after.description) label.description = after.description;
    else delete label.description;
  }
  return {
    row: { field: fieldOf(change), before, after },
    revert: {
      section: change.section,
      item: change.item,
      ...(priceChanged && before.price !== null ? { price: before.price } : {}),
      ...(descriptionChanged ? { description: before.description ?? "" } : {}),
    },
  };
}

function addItem(
  sections: RawSection[],
  section: RawSection | undefined,
  change: MenuChange,
  languageCode: string,
  currencyFor: CurrencyFor,
): Edit {
  if (change.price === undefined) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${fieldOf(change)} is not on the menu; adding it needs a price.`,
    );
  }
  const item: RawItem = {
    labels: [
      {
        displayName: change.item,
        languageCode,
        ...(change.description ? { description: change.description } : {}),
      },
    ],
    attributes: { price: toMoney(change.price, currencyFor(undefined)) },
  };
  if (section) (section.items ??= []).push(item);
  else {
    sections.push({
      labels: [{ displayName: change.section, languageCode }],
      items: [item],
    });
  }
  return {
    row: {
      field: fieldOf(change),
      before: null,
      after: { price: change.price, description: change.description || null },
    },
    revert: { section: change.section, item: change.item, remove: true },
  };
}

/**
 * Applies `changes` in order to a copy of `menus`. Sections and items match
 * any of their labels, ignoring case. Returns the full menus to write, one
 * before/after row per effective change, and the changes that undo them.
 */
export function editFoodMenus(input: {
  menus: RawFoodMenu[];
  menu?: string;
  currencyCode?: string;
  languageCode: string;
  changes: MenuChange[];
}) {
  const menus = structuredClone(input.menus);
  const { languageCode } = input;
  const defaultCurrency = summarizeFoodMenus(menus).currencyCode;
  const currencyFor: CurrencyFor = (existing) => {
    const currency =
      input.currencyCode ?? existing?.currencyCode ?? defaultCurrency;
    if (!currency) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Pass currencyCode (e.g. COP): the menu has no prices to take it from.",
      );
    }
    return currency;
  };

  const menu = pickMenu(menus, input.menu, languageCode);
  const sections = (menu.sections ??= []);
  const rows: Row[] = [];
  const revert: MenuChange[] = [];
  for (const change of input.changes) {
    const section = findByName(sections, change.section);
    const item = section && findByName(section.items ?? [], change.item);
    const edit = change.remove
      ? removeItem(sections, section, item, change, languageCode)
      : item
        ? setItem(item, change, languageCode, currencyFor)
        : addItem(sections, section, change, languageCode, currencyFor);
    if (!edit) continue;
    rows.push(edit.row);
    revert.unshift(edit.revert);
  }
  // Google requires at least one section per menu.
  if (sections.length === 0) menus.splice(menus.indexOf(menu), 1);

  return {
    menus,
    menuName: firstName(menu.labels),
    currencyCode: input.currencyCode ?? defaultCurrency,
    rows,
    revert,
    note: input.changes.some((change) => change.remove)
      ? "Undoing a removal re-adds the item with its price and description only; its photos, allergens and options do not come back."
      : null,
  };
}
