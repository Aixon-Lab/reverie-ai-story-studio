/**
 * Model context-window resolution.
 *
 * The brain's budget is defined as a fraction of the *model's* context, so we
 * need a real number, not a guess. Resolution order:
 *
 *   1. OpenRouter  /models → `context_length`     (live; covers most models)
 *   2. Google      /models → `inputTokenLimit`    (live)
 *   3. Curated table                              (Anthropic/OpenAI do not publish it)
 *   4. Family-prefix heuristics                   (unknown but recognisable ids)
 *   5. Conservative default
 *
 * Results are cached in-process. Failure never throws — an unknown model simply
 * resolves to the conservative default with `source: 'default'`.
 */
import { getSecret } from '../storage';
import type { TextConnection } from '../../shared/types';
import { zdrFetch } from './zdr';

export interface ContextLimit {
  /** Total context window in tokens. */
  contextTokens: number;
  /** Max output tokens the model will emit, when known. */
  maxOutputTokens?: number;
  source: 'openrouter' | 'google' | 'table' | 'heuristic' | 'default' | 'cache';
  model: string;
  provider: string;
}

const DEFAULT_CONTEXT = 32_768;
const CACHE_TTL_MS = 30 * 60 * 1000;
/**
 * A guess is not an answer, so it is not cached like one.
 *
 * When the live lookup fails the table/heuristic/default fallback used to be
 * cached for the full half hour, which turned one network blip into thirty
 * minutes of a 1M-context model being treated as 32k — and the brain's share is
 * a fraction of that number, so memory quietly shrank to a twentieth of its
 * budget with nothing to show why. A short TTL retries soon without hammering.
 */
const FALLBACK_TTL_MS = 60 * 1000;
/**
 * Ceiling on a model-catalogue lookup.
 *
 * This runs on the hot path: `buildBrainContext` awaits it for every single
 * message. Node's `fetch` has no default response timeout, so an endpoint that
 * accepts the connection and then says nothing used to block every send in the
 * app indefinitely — the classic "the app is frozen and there is nothing on
 * screen" failure. The fallback table is always there, so giving up early costs
 * only precision.
 */
const LOOKUP_TIMEOUT_MS = 4_000;
const cache = new Map<string, { at: number; value: ContextLimit; ttl: number }>();

/** `AbortSignal.timeout`, but without assuming a Node that has it. */
function timeoutSignal(ms: number): AbortSignal {
  const anyAbort = AbortSignal as unknown as { timeout?: (n: number) => AbortSignal };
  if (typeof anyAbort.timeout === 'function') return anyAbort.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms).unref?.();
  return c.signal;
}

/**
 * Curated windows for providers whose APIs do not expose context length.
 * Keys are matched as case-insensitive substrings against the model id, longest
 * key first, so `claude-opus-4-1-20250805` matches `claude-opus-4`.
 */
const TABLE: Record<string, { context: number; output?: number }> = {
  // --- Anthropic ---
  'claude-opus-4': { context: 200_000, output: 32_000 },
  'claude-sonnet-4': { context: 200_000, output: 64_000 },
  'claude-haiku-4': { context: 200_000, output: 32_000 },
  'claude-3-7-sonnet': { context: 200_000, output: 64_000 },
  'claude-3-5-sonnet': { context: 200_000, output: 8_192 },
  'claude-3-5-haiku': { context: 200_000, output: 8_192 },
  'claude-3-opus': { context: 200_000, output: 4_096 },
  'claude-3-sonnet': { context: 200_000, output: 4_096 },
  'claude-3-haiku': { context: 200_000, output: 4_096 },
  'claude-2.1': { context: 200_000, output: 4_096 },
  'claude-2': { context: 100_000, output: 4_096 },
  claude: { context: 200_000, output: 8_192 },

  // --- OpenAI ---
  'gpt-5': { context: 400_000, output: 128_000 },
  'gpt-4.1': { context: 1_047_576, output: 32_768 },
  'gpt-4o': { context: 128_000, output: 16_384 },
  'gpt-4-turbo': { context: 128_000, output: 4_096 },
  'gpt-4-32k': { context: 32_768, output: 4_096 },
  'gpt-4': { context: 8_192, output: 4_096 },
  'gpt-3.5-turbo': { context: 16_385, output: 4_096 },
  o4: { context: 200_000, output: 100_000 },
  o3: { context: 200_000, output: 100_000 },
  'o1-mini': { context: 128_000, output: 65_536 },
  o1: { context: 200_000, output: 100_000 },
  chatgpt: { context: 128_000, output: 16_384 },

  // --- Google ---
  'gemini-3': { context: 1_048_576, output: 65_536 },
  'gemini-2.5-pro': { context: 1_048_576, output: 65_536 },
  'gemini-2.5-flash': { context: 1_048_576, output: 65_536 },
  'gemini-2.0-flash': { context: 1_048_576, output: 8_192 },
  'gemini-1.5-pro': { context: 2_097_152, output: 8_192 },
  'gemini-1.5-flash': { context: 1_048_576, output: 8_192 },
  gemini: { context: 1_048_576, output: 8_192 },

  // --- common open models seen via OpenRouter / custom endpoints ---
  'deepseek-v3': { context: 163_840 },
  'deepseek-r1': { context: 163_840 },
  deepseek: { context: 65_536 },
  'llama-4': { context: 1_048_576 },
  'llama-3.3': { context: 131_072 },
  'llama-3.1': { context: 131_072 },
  'llama-3': { context: 8_192 },
  'mistral-large': { context: 131_072 },
  'mixtral-8x22b': { context: 65_536 },
  mixtral: { context: 32_768 },
  mistral: { context: 32_768 },
  'qwen3': { context: 131_072 },
  'qwen2.5': { context: 131_072 },
  qwen: { context: 32_768 },
  'command-r-plus': { context: 128_000 },
  'command-r': { context: 128_000 },
  'grok-4': { context: 256_000 },
  'grok-3': { context: 131_072 },
  grok: { context: 131_072 },
  'glm-4': { context: 131_072 },
  'kimi-k2': { context: 131_072 },
  yi: { context: 200_000 },
};

const TABLE_KEYS = Object.keys(TABLE).sort((a, b) => b.length - a.length);

function fromTable(model: string): { context: number; output?: number; key: string } | null {
  const id = model.toLowerCase();
  for (const key of TABLE_KEYS) {
    if (id.includes(key)) return { ...TABLE[key], key };
  }
  return null;
}

/** Last-resort pattern read: many ids literally carry their window ("-128k", "32b-32k"). */
function fromHeuristic(model: string): number | null {
  const m = model.toLowerCase().match(/(\d{2,4})k(?![a-z0-9])/);
  if (m) {
    const k = Number(m[1]);
    if (k >= 4 && k <= 4096) return k * 1024;
  }
  if (/1m|1000k/.test(model.toLowerCase())) return 1_048_576;
  return null;
}

/**
 * Offline best guess for a model id — the table, then the "-128k" pattern.
 *
 * Exposed for the model catalog, where a row needs a context number without a
 * network round trip per model. Never guesses the conservative default: a
 * catalog would rather show nothing than show 32k against a 1M model.
 */
export function guessContextForModel(model: string): { context: number; output?: number } | null {
  const t = fromTable(model ?? '');
  if (t) return { context: t.context, output: t.output };
  const h = fromHeuristic(model ?? '');
  return h ? { context: h } : null;
}

export async function resolveContextLimit(conn: TextConnection): Promise<ContextLimit> {
  const provider = conn.provider;
  const model = conn.model ?? '';
  const key = `${provider}:${model}`;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < cached.ttl) {
    return { ...cached.value, source: 'cache' };
  }

  let value: ContextLimit | null = null;
  try {
    if (provider === 'openrouter') value = await fromOpenRouter(model);
    else if (provider === 'google') value = await fromGoogle(model);
  } catch {
    // Live lookup is best-effort; the table below is always available.
  }

  if (!value) {
    const t = fromTable(model);
    if (t) {
      value = {
        contextTokens: t.context,
        maxOutputTokens: t.output,
        source: 'table',
        model,
        provider,
      };
    }
  }
  if (!value) {
    const h = fromHeuristic(model);
    if (h) value = { contextTokens: h, source: 'heuristic', model, provider };
  }
  if (!value) {
    value = { contextTokens: DEFAULT_CONTEXT, source: 'default', model, provider };
  }

  // Only a live answer is authoritative enough to hold for the full TTL.
  const live = value.source === 'openrouter' || value.source === 'google';
  cache.set(key, { at: Date.now(), value, ttl: live ? CACHE_TTL_MS : FALLBACK_TTL_MS });
  return value;
}

async function fromOpenRouter(model: string): Promise<ContextLimit | null> {
  const apiKey = (await getSecret('text.openrouter.apiKey')) ?? '';
  const res = await zdrFetch('https://openrouter.ai/api/v1/models', {
    signal: timeoutSignal(LOOKUP_TIMEOUT_MS),
    headers: apiKey
      ? { Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://reverie.local', 'X-Title': 'Reverie' }
      : { 'HTTP-Referer': 'https://reverie.local', 'X-Title': 'Reverie' },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: Array<{
      id: string;
      context_length?: number;
      top_provider?: { context_length?: number; max_completion_tokens?: number };
    }>;
  };
  const row = (json.data ?? []).find((m) => m.id === model)
    ?? (json.data ?? []).find((m) => m.id.toLowerCase() === model.toLowerCase());
  if (!row) return null;
  const context = row.top_provider?.context_length ?? row.context_length;
  if (!context || !Number.isFinite(context)) return null;
  return {
    contextTokens: Math.floor(context),
    maxOutputTokens: row.top_provider?.max_completion_tokens,
    source: 'openrouter',
    model,
    provider: 'openrouter',
  };
}

async function fromGoogle(model: string): Promise<ContextLimit | null> {
  const apiKey = (await getSecret('text.google.apiKey')) ?? '';
  if (!apiKey) return null;
  const id = model.startsWith('models/') ? model : `models/${model}`;
  const res = await zdrFetch(
    `https://generativelanguage.googleapis.com/v1beta/${id}?key=${encodeURIComponent(apiKey)}`,
    { signal: timeoutSignal(LOOKUP_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { inputTokenLimit?: number; outputTokenLimit?: number };
  if (!json.inputTokenLimit) return null;
  return {
    contextTokens: Math.floor(json.inputTokenLimit),
    maxOutputTokens: json.outputTokenLimit,
    source: 'google',
    model,
    provider: 'google',
  };
}

/** Drop cached limits — used when the user changes keys or base URLs. */
export function clearContextLimitCache(): void {
  cache.clear();
}
