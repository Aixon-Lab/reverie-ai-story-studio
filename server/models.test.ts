/**
 * Model catalog mapping — the numbers a choice is made on.
 *
 * Shapes here are copied from a live OpenRouter /models response, including the
 * awkward parts: prices as per-token strings, benchmarks absent on most rows,
 * and a reasoning block that sometimes carries no levels at all.
 */
import { describe, expect, it } from 'vitest';
import { mapOpenRouterModel, type OpenRouterModelRaw } from './providers/models';
import {
  modelRelevance, formatContext, rankModels, variantsByBase, type CatalogModel,
} from '../shared/modelCatalog';

const flash: OpenRouterModelRaw = {
  id: 'google/gemini-3.7-flash',
  name: 'Google: Gemini 3.7 Flash',
  description: 'Multimodal model for fast agentic workflows.',
  context_length: 1_048_576,
  architecture: { modality: 'text+image+file+audio+video->text' },
  pricing: {
    prompt: '0.000000375',
    completion: '0.000001875',
    internal_reasoning: '0.000001875',
  },
  top_provider: { context_length: 1_048_576, max_completion_tokens: 65_536 },
  reasoning: {
    mandatory: true,
    default_enabled: true,
    supported_efforts: ['high', 'medium', 'low'],
    default_effort: 'medium',
  },
  benchmarks: {
    artificial_analysis: { intelligence_index: 56, coding_index: 76.1, agentic_index: 45.1 },
  },
};

describe('openrouter model mapping', () => {
  it('reads price, window, output cap, score, and effort levels', () => {
    const m = mapOpenRouterModel(flash, 'text');
    expect(m.pricePromptPerM).toBeCloseTo(0.375, 6);
    expect(m.priceCompletionPerM).toBeCloseTo(1.875, 6);
    expect(m.priceReasoningPerM).toBeCloseTo(1.875, 6);
    expect(m.contextTokens).toBe(1_048_576);
    expect(m.maxOutputTokens).toBe(65_536);
    expect(m.intelligenceIndex).toBe(56);
    expect(m.codingIndex).toBe(76.1);
    expect(m.reasoning?.supportedEfforts).toEqual(['high', 'medium', 'low']);
    expect(m.reasoning?.defaultEffort).toBe('medium');
    expect(m.reasoning?.mandatory).toBe(true);
  });

  it('prefers the window of the provider the request will actually hit', () => {
    const m = mapOpenRouterModel(
      { ...flash, context_length: 2_000_000, top_provider: { context_length: 200_000 } },
      'text',
    );
    expect(m.contextTokens).toBe(200_000);
  });

  it('leaves the score undefined rather than zero when nothing is published', () => {
    const m = mapOpenRouterModel({ ...flash, benchmarks: undefined }, 'text');
    expect(m.intelligenceIndex).toBeUndefined();
    expect(m.codingIndex).toBeUndefined();
  });

  it('does not invent effort levels for a model that only says it reasons', () => {
    const m = mapOpenRouterModel({ ...flash, reasoning: { mandatory: false } }, 'text');
    expect(m.reasoning).toBeTruthy();
    expect(m.reasoning?.supportedEfforts).toBeUndefined();
  });

  it('reports no reasoning price when the provider folds it into completion', () => {
    const m = mapOpenRouterModel(
      { ...flash, pricing: { prompt: '0.000001', completion: '0.000002' } },
      'text',
    );
    expect(m.priceReasoningPerM).toBeUndefined();
  });

  it('splits a variant off its base so the row can fold under the family', () => {
    const free = mapOpenRouterModel({ ...flash, id: 'google/gemini-3.7-flash:free' }, 'text');
    expect(free.baseId).toBe('google/gemini-3.7-flash');
    expect(free.variant).toBe('free');
    expect(mapOpenRouterModel(flash, 'text').variant).toBeUndefined();
  });

  it('marks a zero-priced model Free rather than "$0 / $0"', () => {
    const m = mapOpenRouterModel(
      { ...flash, id: 'x/y:free', pricing: { prompt: '0', completion: '0' } },
      'text',
    );
    expect(m.price).toBe('Free');
    expect(m.pricePromptPerM).toBe(0);
  });
});

describe('catalog search ranking', () => {
  const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel =>
    ({ id, name: id, ...extra });

  it('puts the model you named above models that merely mention it', () => {
    const opus = model('anthropic/claude-opus-5', { name: 'Anthropic: Claude Opus 5' });
    const mentions = model('vendor/other-1', {
      name: 'Other 1',
      description: 'Benchmarked against Claude Opus 5 and GPT.',
    });
    expect(modelRelevance(opus, 'opus')).toBeGreaterThan(modelRelevance(mentions, 'opus'));
  });

  it('ranks an exact id above a prefix above a substring', () => {
    const exact = modelRelevance(model('openai/gpt-5'), 'openai/gpt-5');
    const prefix = modelRelevance(model('openai/gpt-5-mini'), 'gpt-5');
    const middle = modelRelevance(model('vendor/wrapped-gpt-5-thing'), 'gpt-5');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(middle);
  });

  it('scores a non-match zero so it can be filtered out', () => {
    expect(modelRelevance(model('openai/gpt-5'), 'llama')).toBe(0);
    expect(modelRelevance(model('openai/gpt-5'), '')).toBe(0);
  });
});

describe('catalog list assembly', () => {
  const catalog: CatalogModel[] = [
    { id: 'a/base', name: 'Base', intelligenceIndex: 40, pricePromptPerM: 3, priceCompletionPerM: 15, contextTokens: 200_000 },
    { id: 'a/base:free', name: 'Base (free)', baseId: 'a/base', variant: 'free', pricePromptPerM: 0, priceCompletionPerM: 0, contextTokens: 200_000 },
    { id: 'b/smart', name: 'Smart', intelligenceIndex: 70, pricePromptPerM: 10, priceCompletionPerM: 40, contextTokens: 1_048_576, reasoning: { supportedEfforts: ['high', 'low'] } },
    { id: 'c/orphan:free', name: 'Orphan (free)', baseId: 'c/orphan', variant: 'free', pricePromptPerM: 0, priceCompletionPerM: 0 },
  ];

  it('folds a variant into its base but keeps a variant that has no base row', () => {
    const ids = rankModels(catalog).map((m) => m.id);
    expect(ids).not.toContain('a/base:free');
    expect(ids).toContain('a/base');
    expect(ids).toContain('c/orphan:free');
  });

  it('shows every variant as its own row when asked', () => {
    const ids = rankModels(catalog, { showAllVariants: true }).map((m) => m.id);
    expect(ids).toContain('a/base:free');
  });

  it('leads with the strongest model when nothing is typed', () => {
    expect(rankModels(catalog)[0].id).toBe('b/smart');
  });

  it('sorts by price, context, and name on demand', () => {
    expect(rankModels(catalog, { sort: 'cheapest' })[0].id).toBe('c/orphan:free');
    expect(rankModels(catalog, { sort: 'context' })[0].id).toBe('b/smart');
    expect(rankModels(catalog, { sort: 'name' }).map((m) => m.name)).toEqual(
      ['Base', 'Orphan (free)', 'Smart'],
    );
  });

  it('filters to free and to reasoning-capable models', () => {
    expect(rankModels(catalog, { freeOnly: true, showAllVariants: true }).map((m) => m.id))
      .toEqual(['a/base:free', 'c/orphan:free']);
    expect(rankModels(catalog, { reasoningOnly: true }).map((m) => m.id)).toEqual(['b/smart']);
  });

  it('drops non-matching rows once a query is typed', () => {
    const ids = rankModels(catalog, { query: 'smart' }).map((m) => m.id);
    expect(ids).toEqual(['b/smart']);
  });

  it('groups variants under the base they belong to', () => {
    const groups = variantsByBase(catalog);
    expect(groups.get('a/base')?.map((v) => v.id)).toEqual(['a/base:free']);
    expect(groups.has('b/smart')).toBe(false);
  });
});

describe('context formatting', () => {
  it('reads the way people quote windows', () => {
    expect(formatContext(1_048_576)).toBe('1M');
    expect(formatContext(2_097_152)).toBe('2M');
    expect(formatContext(200_000)).toBe('200K');
    expect(formatContext(131_072)).toBe('131K');
    expect(formatContext(8_192)).toBe('8K');
  });

  it('says nothing when the window is unknown', () => {
    expect(formatContext(undefined)).toBe('');
    expect(formatContext(0)).toBe('');
  });
});
