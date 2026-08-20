/**
 * Model catalog presentation — ranking, filtering, and the short forms a row
 * shows. Pure functions, shared by the picker UI and its tests, and kept out of
 * the component so "why did this model rank above that one" is answerable.
 */

/** The subset of ModelInfo the catalog list reasons about. */
export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
  price?: string;
  pricePromptPerM?: number;
  priceCompletionPerM?: number;
  intelligenceIndex?: number;
  contextTokens?: number;
  reasoning?: { supportedEfforts?: string[] } | undefined;
  baseId?: string;
  variant?: string;
}

export type ModelSortKey = 'relevance' | 'intelligence' | 'cheapest' | 'context' | 'name';

/** 1048576 → "1M", 200000 → "200K". Windows are quoted in round numbers. */
export function formatContext(tokens?: number): string {
  if (!tokens || !Number.isFinite(tokens)) return '';
  if (tokens >= 1_000_000) {
    // 1048576 is "1M" to everyone except a calculator; 1500000 is not.
    const mib = tokens / 1_048_576;
    const value = Math.abs(mib - Math.round(mib)) < 0.05 ? Math.round(mib) : Math.round((tokens / 1_000_000) * 10) / 10;
    return `${value}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/**
 * Ranking for a typed query.
 *
 * An exact id wins, then the bare slug, then a prefix, and only then a
 * description hit — searching "opus" must not bury Opus under every model whose
 * blurb claims to rival it. Zero means "not a match" and is used to filter.
 */
export function modelRelevance(m: CatalogModel, needle: string): number {
  const q = needle.trim().toLowerCase();
  if (!q) return 0;
  const id = m.id.toLowerCase();
  const name = m.name.toLowerCase();
  const slug = id.split('/').pop() ?? id;
  if (id === q || name === q) return 100;
  if (slug === q) return 95;
  if (slug.startsWith(q) || name.startsWith(q)) return 80;
  if (id.startsWith(q)) return 70;
  if (slug.includes(q) || name.includes(q)) return 55;
  if (id.includes(q)) return 45;
  if (m.description?.toLowerCase().includes(q)) return 20;
  return 0;
}

export interface RankOptions {
  query?: string;
  sort?: ModelSortKey;
  freeOnly?: boolean;
  reasoningOnly?: boolean;
  /** Show `:free` / `:batch` rows separately instead of folding them in. */
  showAllVariants?: boolean;
}

function totalPrice(m: CatalogModel): number {
  if (m.pricePromptPerM == null && m.priceCompletionPerM == null) return Number.POSITIVE_INFINITY;
  return (m.pricePromptPerM ?? 0) + (m.priceCompletionPerM ?? 0);
}

export function rankModels<T extends CatalogModel>(models: T[], opts: RankOptions = {}): T[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const baseIds = new Set(models.filter((m) => !m.variant).map((m) => m.id));

  const rows = models.filter((m) => {
    if (q && !modelRelevance(m, q)) return false;
    if (opts.freeOnly && !(m.pricePromptPerM === 0 && m.priceCompletionPerM === 0)) return false;
    if (opts.reasoningOnly && !m.reasoning) return false;
    /**
     * A variant is the same model on different terms, so it folds into its base
     * row — but only when that row is present. A model that exists *only* as
     * `:free` must never vanish because its notional base was filtered away.
     */
    if (!opts.showAllVariants && m.variant && baseIds.has(m.baseId ?? '')) return false;
    return true;
  });

  const byName = (a: CatalogModel, b: CatalogModel) => a.name.localeCompare(b.name);
  const sorted = [...rows];
  switch (opts.sort) {
    case 'intelligence':
      sorted.sort((a, b) => (b.intelligenceIndex ?? -1) - (a.intelligenceIndex ?? -1) || byName(a, b));
      break;
    case 'cheapest':
      sorted.sort((a, b) => totalPrice(a) - totalPrice(b) || byName(a, b));
      break;
    case 'context':
      sorted.sort((a, b) => (b.contextTokens ?? 0) - (a.contextTokens ?? 0) || byName(a, b));
      break;
    case 'name':
      sorted.sort(byName);
      break;
    default:
      /**
       * With nothing typed, "relevance" has nothing to rank against and falls
       * back to the score — which is the order that makes a 400-model catalog
       * approachable when you open it cold.
       */
      if (q) {
        sorted.sort((a, b) =>
          modelRelevance(b, q) - modelRelevance(a, q)
          || (b.intelligenceIndex ?? -1) - (a.intelligenceIndex ?? -1)
          || byName(a, b));
      } else {
        sorted.sort((a, b) => (b.intelligenceIndex ?? -1) - (a.intelligenceIndex ?? -1) || byName(a, b));
      }
  }
  return sorted;
}

/** Variants grouped under the base id they belong to, for the folded rows. */
export function variantsByBase<T extends CatalogModel>(models: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const m of models) {
    if (!m.variant) continue;
    const base = m.baseId ?? m.id;
    const list = map.get(base) ?? [];
    list.push(m);
    map.set(base, list);
  }
  return map;
}
