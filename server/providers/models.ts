/** Live model catalogs — proxy provider /models APIs with curated fallbacks. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getSecret, DATA_DIR, readJson } from '../storage';
import { IMAGE_CATALOG } from './image';
import type { AppSettings } from '../../shared/types';
import { zdrFetch } from './zdr';
import { guessContextForModel } from './contextLimits';

/** Reasoning-effort levels a model accepts, straight from the provider. */
export interface ModelReasoning {
  /** The model always reasons; effort cannot be turned off. */
  mandatory?: boolean;
  defaultEnabled?: boolean;
  /** e.g. ['high','medium','low'] — order as the provider gave it. */
  supportedEfforts?: string[];
  defaultEffort?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  /** Display string, e.g. "$3 / $15 · 1M tok" or "Free". */
  price?: string;
  /** Prompt USD per 1M tokens (when known) — useful for sorting later. */
  pricePromptPerM?: number;
  /** Completion USD per 1M tokens (when known). */
  priceCompletionPerM?: number;
  /**
   * USD per 1M internal reasoning tokens, when the provider prices them apart
   * from completion. This is the number that actually moves when you raise
   * reasoning effort — the effort level itself has no separate rate.
   */
  priceReasoningPerM?: number;
  /** Maximum context window in tokens. */
  contextTokens?: number;
  /** Maximum tokens the model will produce in one reply. */
  maxOutputTokens?: number;
  /**
   * Artificial Analysis scores, republished by OpenRouter under `benchmarks`.
   * Absent for most small or brand-new models — never inferred locally.
   */
  intelligenceIndex?: number;
  codingIndex?: number;
  agenticIndex?: number;
  reasoning?: ModelReasoning;
  /** Slug without its `:variant` suffix — the family a row belongs to. */
  baseId?: string;
  /** `free`, `batch`, `thinking`, `nitro`… when the id carries a suffix. */
  variant?: string;
  /** e.g. "text+image->text" — what the model can be fed. */
  modality?: string;
}

export type ModelKind = 'text' | 'image';

export interface ModelsResponse {
  models: ModelInfo[];
  source: 'live' | 'cache' | 'fallback';
  error?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; models: ModelInfo[] }>();

const TEXT_FALLBACK: Record<string, string[]> = {
  openrouter: ['anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.8', 'openai/gpt-5.2', 'google/gemini-3-pro', 'deepseek/deepseek-v3.2'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5.2', 'gpt-5-mini', 'gpt-4.1'],
  google: ['gemini-3-pro', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  custom: [],
};

function fingerprint(key: string): string {
  return createHash('sha256').update(key || '').digest('hex').slice(0, 12);
}

/**
  * Providers that publish nothing but an id still get a context number, from the
  * same curated table the brain budgets against — so the catalog and the memory
  * system can never disagree about how big a window is.
  */
function toInfos(ids: string[]): ModelInfo[] {
  return ids.map((id) => withGuessedContext({ id, name: id }));
}

function withGuessedContext(info: ModelInfo): ModelInfo {
  if (info.contextTokens) return info;
  const guess = guessContextForModel(info.id);
  if (!guess) return info;
  return {
    ...info,
    contextTokens: guess.context,
    maxOutputTokens: info.maxOutputTokens ?? guess.output,
  };
}

function curatedFallback(provider: string, kind: ModelKind): ModelInfo[] {
  if (kind === 'image') return toInfos(IMAGE_CATALOG[provider]?.models ?? []);
  return toInfos(TEXT_FALLBACK[provider] ?? []);
}

function filterClientQ(models: ModelInfo[], q?: string): ModelInfo[] {
  if (!q?.trim()) return models;
  const needle = q.trim().toLowerCase();
  return models.filter((m) =>
    m.id.toLowerCase().includes(needle)
    || m.name.toLowerCase().includes(needle)
    || (m.description?.toLowerCase().includes(needle) ?? false)
    || (m.price?.toLowerCase().includes(needle) ?? false),
  );
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (n === 0) return '0';
  if (n < 0.01) return n.toPrecision(2).replace(/\.?0+$/, '');
  if (n < 1) return n.toFixed(3).replace(/\.?0+$/, '');
  if (n < 100) return n.toFixed(2).replace(/\.?0+$/, '');
  return String(Math.round(n));
}

/** OpenRouter prices are USD per token (string). Normalize to a short label. */
function fromOpenRouterPricing(
  pricing: { prompt?: string; completion?: string; image?: string; request?: string } | undefined,
  kind: ModelKind,
): Pick<ModelInfo, 'price' | 'pricePromptPerM' | 'priceCompletionPerM'> {
  if (!pricing) return {};
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  const image = Number(pricing.image);
  const request = Number(pricing.request);
  const pricePromptPerM = Number.isFinite(prompt) ? prompt * 1e6 : undefined;
  const priceCompletionPerM = Number.isFinite(completion) ? completion * 1e6 : undefined;

  if (kind === 'image' && Number.isFinite(image) && image > 0) {
    return {
      price: `$${fmtUsd(image)} / image`,
      pricePromptPerM,
      priceCompletionPerM,
    };
  }

  const inZero = !Number.isFinite(prompt) || prompt === 0;
  const outZero = !Number.isFinite(completion) || completion === 0;
  if (inZero && outZero) {
    if (Number.isFinite(request) && request > 0) {
      return { price: `$${fmtUsd(request)} / req`, pricePromptPerM, priceCompletionPerM };
    }
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      return { price: 'Free', pricePromptPerM: 0, priceCompletionPerM: 0 };
    }
    return {};
  }

  return {
    price: `$${fmtUsd(pricePromptPerM!)} / $${fmtUsd(priceCompletionPerM!)} · 1M`,
    pricePromptPerM,
    priceCompletionPerM,
  };
}

async function secretFor(provider: string, kind: ModelKind): Promise<string> {
  const key = kind === 'image' ? `image.${provider}.apiKey` : `text.${provider}.apiKey`;
  return (await getSecret(key)) ?? '';
}

export async function listProviderModels(
  provider: string,
  kind: ModelKind,
  q?: string,
  opts?: { refresh?: boolean },
): Promise<ModelsResponse> {
  if (kind === 'image' && provider === 'anthropic') {
    return { models: [], source: 'fallback', error: 'Anthropic has no image models.' };
  }

  const apiKey = await secretFor(provider, kind);
  const settings = await readJson<Partial<AppSettings>>(path.join(DATA_DIR, 'settings.json'), {});
  const baseUrl = kind === 'image'
    ? settings.imageConnection?.baseUrl
    : settings.textConnection?.baseUrl;

  if (provider === 'custom' && !baseUrl?.trim()) {
    return { models: [], source: 'fallback', error: 'Set a Base URL for custom provider.' };
  }
  // fal list can work without key (lower rate limits); others need key
  if (provider !== 'custom' && provider !== 'fal' && !apiKey) {
    return {
      models: filterClientQ(curatedFallback(provider, kind), q),
      source: 'fallback',
      error: `No API key set for ${provider}. Showing curated defaults — add a key to load the full catalog.`,
    };
  }

  const cacheKey = `${provider}:${kind}:${fingerprint(apiKey + (baseUrl ?? ''))}`;
  const cached = cache.get(cacheKey);
  if (!opts?.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS && !q?.trim()) {
    return { models: cached.models, source: 'cache' };
  }

  try {
    let models: ModelInfo[];
    switch (provider) {
      case 'openrouter':
        models = await fetchOpenRouter(apiKey, kind, q);
        break;
      case 'openai':
        models = await fetchOpenAI(apiKey, kind);
        break;
      case 'anthropic':
        models = await fetchAnthropic(apiKey);
        break;
      case 'google':
        models = await fetchGoogle(apiKey, kind);
        break;
      case 'fal':
        models = await fetchFal(apiKey, q);
        break;
      case 'custom':
        models = await fetchOpenAICompat(baseUrl!, apiKey, kind);
        break;
      default:
        models = curatedFallback(provider, kind);
    }

    if (!q?.trim()) cache.set(cacheKey, { at: Date.now(), models });
    // Client also filters; for OpenAI/Google/Anthropic apply local q
    if (provider !== 'openrouter' && provider !== 'fal') {
      models = filterClientQ(models, q);
    }
    return { models, source: 'live' };
  } catch (err: any) {
    const fallback = filterClientQ(curatedFallback(provider, kind), q);
    return {
      models: fallback,
      source: 'fallback',
      error: err.message ?? 'Failed to fetch models',
    };
  }
}

/** `openai/gpt-5:free` → base `openai/gpt-5`, variant `free`. */
function splitVariant(id: string): { baseId: string; variant?: string } {
  const at = id.indexOf(':');
  if (at === -1) return { baseId: id };
  return { baseId: id.slice(0, at), variant: id.slice(at + 1) || undefined };
}

/** One entry of OpenRouter's /models payload — only the parts we read. */
export interface OpenRouterModelRaw {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { modality?: string };
  pricing?: {
    prompt?: string; completion?: string; image?: string; request?: string;
    internal_reasoning?: string;
  };
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[];
    default_effort?: string;
  };
  /**
   * Third-party evaluations OpenRouter republishes. Optional and uneven — well
   * under half the catalog carries an Artificial Analysis score — so every
   * consumer has to treat it as missing by default rather than as a zero.
   */
  benchmarks?: {
    artificial_analysis?: {
      intelligence_index?: number;
      coding_index?: number;
      agentic_index?: number;
    };
  };
}

export function mapOpenRouterModel(m: OpenRouterModelRaw, kind: ModelKind): ModelInfo {
  const aa = m.benchmarks?.artificial_analysis;
  const reasoningRate = Number(m.pricing?.internal_reasoning);
  const { baseId, variant } = splitVariant(m.id);
  return {
    id: m.id,
    name: m.name ?? m.id,
    description: m.description?.slice(0, 160),
    ...fromOpenRouterPricing(m.pricing, kind),
    priceReasoningPerM: Number.isFinite(reasoningRate) && reasoningRate > 0
      ? reasoningRate * 1e6
      : undefined,
    // top_provider is what the request will actually hit; the model-level number
    // is the theoretical maximum across providers, so it is only the fallback.
    contextTokens: m.top_provider?.context_length ?? m.context_length,
    maxOutputTokens: m.top_provider?.max_completion_tokens ?? undefined,
    intelligenceIndex: numOrUndef(aa?.intelligence_index),
    codingIndex: numOrUndef(aa?.coding_index),
    agenticIndex: numOrUndef(aa?.agentic_index),
    reasoning: m.reasoning
      ? {
          mandatory: m.reasoning.mandatory,
          defaultEnabled: m.reasoning.default_enabled,
          supportedEfforts: m.reasoning.supported_efforts?.length
            ? m.reasoning.supported_efforts
            : undefined,
          defaultEffort: m.reasoning.default_effort,
        }
      : undefined,
    baseId,
    variant,
    modality: m.architecture?.modality,
  };
}

async function fetchOpenRouter(apiKey: string, kind: ModelKind, q?: string): Promise<ModelInfo[]> {
  const url = new URL('https://openrouter.ai/api/v1/models');
  if (kind === 'image') url.searchParams.set('output_modalities', 'image');
  if (q && q.trim().length >= 2) url.searchParams.set('q', q.trim());
  const res = await zdrFetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://reverie.local',
      'X-Title': 'Reverie',
    },
  });
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json() as { data?: OpenRouterModelRaw[] };
  const list = (json.data ?? []).map((m) => mapOpenRouterModel(m, kind));
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
}

function numOrUndef(n: unknown): number | undefined {
  const v = Number(n);
  return Number.isFinite(v) ? v : undefined;
}

async function fetchOpenAI(apiKey: string, kind: ModelKind): Promise<ModelInfo[]> {
  const res = await zdrFetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenAI models ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json() as { data?: Array<{ id: string }> };
  let ids = (json.data ?? []).map((m) => m.id);
  if (kind === 'image') {
    ids = ids.filter((id) => /gpt-image|dall-e/i.test(id));
  } else {
    ids = ids.filter((id) => {
      const lower = id.toLowerCase();
      if (/embedding|whisper|tts|realtime|audio|transcribe|moderation|dall-e|gpt-image|sora|codex-mini/i.test(lower)) return false;
      return /gpt|o[1-9]|chatgpt|omni/i.test(lower);
    });
  }
  ids.sort();
  return toInfos(ids);
}

async function fetchAnthropic(apiKey: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL('https://api.anthropic.com/v1/models');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after_id', after);
    const res = await zdrFetch(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) throw new Error(`Anthropic models ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as {
      data?: Array<{ id: string; display_name?: string }>;
      has_more?: boolean;
      last_id?: string;
    };
    for (const m of json.data ?? []) {
      out.push(withGuessedContext({ id: m.id, name: m.display_name ?? m.id }));
    }
    if (!json.has_more || !json.last_id) break;
    after = json.last_id;
  }
  return out;
}

async function fetchGoogle(apiKey: string, kind: ModelKind): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 30; page++) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await zdrFetch(url);
    if (!res.ok) throw new Error(`Google models ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as {
      models?: Array<{
        name: string;
        displayName?: string;
        description?: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
        outputTokenLimit?: number;
      }>;
      nextPageToken?: string;
    };
    for (const m of json.models ?? []) {
      const methods = m.supportedGenerationMethods ?? [];
      if (!methods.includes('generateContent')) continue;
      const id = m.name.replace(/^models\//, '');
      const lower = id.toLowerCase();
      if (/embedding|aqa|imagen-/.test(lower) && kind === 'text') continue;
      if (kind === 'image') {
        if (!/image/i.test(id)) continue;
      } else if (/image/i.test(id) && !/vision/i.test(id)) {
        // skip pure image-output models from text picker
        continue;
      }
      out.push(withGuessedContext({
        id,
        name: m.displayName ?? id,
        description: m.description?.slice(0, 160),
        // Google publishes the window on the model itself — no table needed.
        contextTokens: numOrUndef(m.inputTokenLimit),
        maxOutputTokens: numOrUndef(m.outputTokenLimit),
      }));
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function fetchFal(apiKey: string, q?: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    const url = new URL('https://api.fal.ai/v1/models');
    url.searchParams.set('category', 'text-to-image');
    url.searchParams.set('limit', '50');
    if (q && q.trim().length >= 2) url.searchParams.set('q', q.trim());
    if (cursor) url.searchParams.set('cursor', cursor);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Key ${apiKey}`;
    const res = await zdrFetch(url, { headers });
    if (!res.ok) throw new Error(`fal models ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json() as {
      models?: Array<{ endpoint_id?: string; id?: string; name?: string; title?: string; description?: string }>;
      next_cursor?: string | null;
    };
    const rows = json.models ?? (Array.isArray(json) ? json as any[] : []);
    for (const m of rows) {
      const id = m.endpoint_id ?? m.id;
      if (!id) continue;
      out.push({
        id,
        name: m.name ?? m.title ?? id,
        description: m.description?.slice(0, 160),
      });
    }
    cursor = json.next_cursor ?? undefined;
    if (!cursor) break;
    // When searching remotely, one page is enough
    if (q && q.trim().length >= 2) break;
  }
  return out;
}

async function fetchOpenAICompat(baseUrl: string, apiKey: string, kind: ModelKind): Promise<ModelInfo[]> {
  const root = baseUrl.replace(/\/$/, '');
  const url = root.endsWith('/v1') ? `${root}/models` : `${root}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await zdrFetch(url, { headers });
  if (!res.ok) throw new Error(`Custom models ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json() as { data?: Array<{ id: string }> };
  let ids = (json.data ?? []).map((m) => m.id);
  if (kind === 'image') ids = ids.filter((id) => /image|dall-e|flux|sdxl|stable/i.test(id));
  ids.sort();
  return toInfos(ids);
}
