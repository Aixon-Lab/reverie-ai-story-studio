/** Text LLM provider adapters with unified streaming. */
import type { BuiltMessage, TextConnection } from '../../shared/types';
import { getSecret } from '../storage';
import { currentPurpose, logRequest } from '../lib/sessionLog';
import { zdrFetch } from './zdr';

export interface GenParams {
  temperature: number;
  top_p: number;
  top_k?: number;
  min_p?: number;
  max_tokens: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  stops?: string[];
  stream: boolean;
}

export interface StreamHandle {
  /** async iterator of text deltas */
  deltas: AsyncGenerator<string, void, unknown>;
  abort: () => void;
}

function secretKeyFor(provider: string): string {
  return `text.${provider}.apiKey`;
}

export async function hasKey(provider: string): Promise<boolean> {
  return !!(await getSecret(secretKeyFor(provider)));
}

export async function generateText(
  conn: TextConnection,
  messages: BuiltMessage[],
  params: GenParams,
): Promise<StreamHandle> {
  const tap = logRequest({
    purpose: currentPurpose('generate'),
    provider: conn.provider,
    model: conn.model,
    messages: messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
    params: { ...params },
    streamed: true,
  });
  let handle: StreamHandle;
  try {
    handle = await generateTextInner(conn, messages, params);
  } catch (err) {
    tap.fail(err);
    throw err;
  }
  // The reply is not known until the stream is drained, so the response entry is
  // written when the consumer finishes reading - including on abort, where the
  // partial text is exactly what the user saw.
  return {
    abort: handle.abort,
    deltas: (async function* tapped() {
      let acc = '';
      try {
        for await (const d of handle.deltas) {
          acc += d;
          yield d;
        }
        tap.ok(acc);
      } catch (err) {
        if (acc) tap.ok(acc);
        tap.fail(err);
        throw err;
      }
    })(),
  };
}

async function generateTextInner(
  conn: TextConnection,
  messages: BuiltMessage[],
  params: GenParams,
): Promise<StreamHandle> {
  const apiKey = (await getSecret(secretKeyFor(conn.provider))) ?? '';
  if (!apiKey && conn.provider !== 'custom') {
    throw new Error(`No API key configured for ${conn.provider}. Add one in Connections.`);
  }
  const controller = new AbortController();

  switch (conn.provider) {
    case 'anthropic':
      return anthropicStream(conn, messages, params, apiKey, controller);
    case 'google':
      return googleStream(conn, messages, params, apiKey, controller);
    case 'openai':
    case 'openrouter':
    case 'custom':
    default:
      return openaiCompatStream(conn, messages, params, apiKey, controller);
  }
}

/** Pull visible text from provider stream/complete payloads (handles several model shapes). */
export function extractDeltaText(json: any): string | undefined {
  const choice = json?.choices?.[0];
  const d = choice?.delta ?? choice?.message;
  if (!d) return undefined;
  if (typeof d.content === 'string' && d.content.length) return d.content;
  if (typeof d.text === 'string' && d.text.length) return d.text;
  if (Array.isArray(d.content)) {
    const joined = d.content
      .map((p: any) => (typeof p === 'string' ? p : p?.text ?? p?.content ?? ''))
      .join('');
    if (joined) return joined;
  }
  // some reasoning models put the visible reply here after thinking
  if (typeof d.reasoning_content === 'string' && !d.content) {
    // do not yield raw chain-of-thought as chat — only if there is no content ever
    return undefined;
  }
  return undefined;
}

export function extractCompleteText(json: any): string {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? choice;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p: any) => {
        if (typeof p === 'string') return p;
        // Never surface structured thinking/reasoning parts as chat text
        const t = String(p?.type ?? '').toLowerCase();
        if (t === 'thinking' || t === 'reasoning' || t === 'thought') return '';
        if (p?.thought === true) return '';
        return p?.text ?? p?.content ?? '';
      })
      .join('');
  }
  if (typeof choice?.text === 'string') return choice.text;
  // Do not fall back to reasoning_content — that is hidden CoT, not the reply
  return '';
}

async function readSse(
  res: Response,
  onData: (json: any) => string | undefined,
  signal?: AbortSignal,
): Promise<AsyncGenerator<string>> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Provider error ${res.status}: ${body.slice(0, 500)}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    // Swallow cancel rejections so Stop never crashes the Node process
    try {
      void reader.cancel('aborted').catch(() => undefined);
    } catch { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  async function* gen(): AsyncGenerator<string> {
    let buffer = '';
    try {
      while (true) {
        if (signal?.aborted) return;
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err: any) {
          if (signal?.aborted || err?.name === 'AbortError' || /abort/i.test(String(err?.message ?? ''))) return;
          throw err;
        }
        const { done, value } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (signal?.aborted) return;
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const delta = onData(JSON.parse(payload));
            if (delta) yield delta;
          } catch {
            // partial/keepalive lines are fine to skip
          }
        }
      }
      if (signal?.aborted) return;
      // flush trailing data line if stream closed without final newline
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try {
            const delta = onData(JSON.parse(payload));
            if (delta) yield delta;
          } catch { /* ignore */ }
        }
      }
    } catch (err: any) {
      if (signal?.aborted || err?.name === 'AbortError' || /abort/i.test(String(err?.message ?? ''))) return;
      throw err;
    }
  }
  return gen();
}

/** Abort without letting undici AbortError become an uncaughtException. */
function safeAbort(controller: AbortController): void {
  try {
    if (!controller.signal.aborted) controller.abort();
  } catch {
    /* ignore */
  }
}

/**
 * Reasoning effort, in whichever spelling the endpoint speaks.
 *
 * OpenRouter takes a `reasoning` object and normalises it per upstream model;
 * OpenAI-compatible endpoints take the flat `reasoning_effort`. Sending both is
 * safe (each ignores the other's field) and is what makes one stored setting
 * work across a direct OpenAI key and the same model proxied through OpenRouter.
 * Omitted entirely when unset, so the model keeps its own default rather than
 * being pinned to a level the user never chose.
 */
function reasoningBody(conn: TextConnection): Record<string, unknown> {
  const effort = conn.reasoningEffort?.trim();
  if (!effort) return {};
  if (conn.provider === 'openrouter') return { reasoning: { effort } };
  return { reasoning_effort: effort };
}

async function openaiCompatStream(
  conn: TextConnection, messages: BuiltMessage[], params: GenParams, apiKey: string, controller: AbortController,
): Promise<StreamHandle> {
  const base = conn.baseUrl?.replace(/\/$/, '')
    || (conn.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
  const res = await zdrFetch(`${base}/chat/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(conn.provider === 'openrouter' ? { 'HTTP-Referer': 'http://localhost', 'X-Title': 'Reverie' } : {}),
    },
    body: JSON.stringify({
      model: conn.model,
      messages,
      temperature: params.temperature,
      top_p: params.top_p,
      max_tokens: params.max_tokens,
      frequency_penalty: params.frequency_penalty,
      presence_penalty: params.presence_penalty,
      // Extended samplers — ignored by providers that don't support them
      ...(params.top_k && params.top_k > 0 ? { top_k: params.top_k } : {}),
      ...(params.min_p && params.min_p > 0 ? { min_p: params.min_p } : {}),
      ...(params.repetition_penalty && params.repetition_penalty !== 1
        ? { repetition_penalty: params.repetition_penalty }
        : {}),
      stop: params.stops?.length ? params.stops : undefined,
      ...reasoningBody(conn),
      stream: true,
    }),
  });
  const deltas = await readSse(res, extractDeltaText, controller.signal);
  return { deltas, abort: () => safeAbort(controller) };
}

/** Non-streaming completion — used when stream returns empty (common with some models/providers). */
export async function generateTextComplete(
  conn: TextConnection,
  messages: BuiltMessage[],
  params: GenParams & { jsonMode?: boolean },
): Promise<string> {
  /**
   * Session terminal (in-memory only). Wraps rather than sprinkles: this and
   * `generateText` are the two places an HTTP call to a provider is actually
   * made, so logging here catches every feature without any of them knowing.
   */
  const tap = logRequest({
    purpose: currentPurpose(),
    provider: conn.provider,
    model: conn.model,
    messages: messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
    params: { ...params },
    streamed: false,
  });
  try {
    const out = await generateTextCompleteInner(conn, messages, params);
    tap.ok(out);
    return out;
  } catch (err) {
    tap.fail(err);
    throw err;
  }
}

async function generateTextCompleteInner(
  conn: TextConnection,
  messages: BuiltMessage[],
  params: GenParams & { jsonMode?: boolean },
): Promise<string> {
  const apiKey = (await getSecret(secretKeyFor(conn.provider))) ?? '';
  if (!apiKey && conn.provider !== 'custom') {
    throw new Error(`No API key configured for ${conn.provider}. Add one in Connections.`);
  }

  if (conn.provider === 'google') {
    return googleComplete(conn, messages, params, apiKey);
  }

  if (conn.provider === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
    const res = await zdrFetch(`${conn.baseUrl?.replace(/\/$/, '') || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: conn.model,
        system: system || undefined,
        messages: rest.length ? rest : [{ role: 'user', content: '[Begin.]' }],
        temperature: Math.min(params.temperature, 1),
        max_tokens: params.max_tokens,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`Provider error ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const json = (await res.json()) as { content?: { text?: string }[] };
    return (json.content ?? []).map((b) => b.text ?? '').join('').trim();
  }

  const base = conn.baseUrl?.replace(/\/$/, '')
    || (conn.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
  const body: Record<string, unknown> = {
    model: conn.model,
    messages,
    temperature: params.temperature,
    top_p: params.top_p,
    // Honor caller budget (chat Max Tokens); do not floor upward — soft length guidance is in the prompt
    max_tokens: Math.max(1, params.max_tokens),
    frequency_penalty: params.frequency_penalty,
    presence_penalty: params.presence_penalty,
    ...reasoningBody(conn),
    stream: false,
  };
  // OpenAI / OpenRouter JSON mode when requested
  if (params.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  const res = await zdrFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(conn.provider === 'openrouter' ? { 'HTTP-Referer': 'http://localhost', 'X-Title': 'Reverie' } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Some models reject response_format — retry without it
    if (params.jsonMode && res.status === 400) {
      delete body.response_format;
      const retry = await zdrFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(conn.provider === 'openrouter' ? { 'HTTP-Referer': 'http://localhost', 'X-Title': 'Reverie' } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!retry.ok) throw new Error(`Provider error ${retry.status}: ${(await retry.text()).slice(0, 400)}`);
      return extractCompleteText(await retry.json()).trim();
    }
    throw new Error(`Provider error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const json = await res.json();
  return extractCompleteText(json).trim();
}

async function anthropicStream(
  conn: TextConnection, messages: BuiltMessage[], params: GenParams, apiKey: string, controller: AbortController,
): Promise<StreamHandle> {
  // Anthropic: system messages go to `system`, history must alternate-ish (API tolerates same-role runs)
  const system = messages.filter((m) => m.role === 'system' && messages.indexOf(m) < firstNonSystem(messages)).map((m) => m.content).join('\n\n');
  const rest = messages.slice(firstNonSystem(messages)).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.role === 'system' ? `[System note]\n${m.content}` : m.content,
  }));
  if (rest.length === 0) rest.push({ role: 'user', content: '[Begin.]' });
  const res = await zdrFetch(`${conn.baseUrl?.replace(/\/$/, '') || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: conn.model,
      system: system || undefined,
      messages: mergeConsecutive(rest),
      temperature: Math.min(params.temperature, 1),
      top_p: params.top_p < 1 ? params.top_p : undefined,
      max_tokens: params.max_tokens,
      stop_sequences: params.stops?.length ? params.stops : undefined,
      stream: true,
    }),
  });
  const deltas = await readSse(res, (json) => (json.type === 'content_block_delta' ? json.delta?.text : undefined), controller.signal);
  return { deltas, abort: () => safeAbort(controller) };
}

/** Gemini sometimes returns thought parts (Flash thinking) with no user-visible text. */
function googlePartsText(parts: any[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

/** Relaxed safety for creative RP utility (character cards / vision analysis). */
const GOOGLE_RELAXED_SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

function googleFinishError(json: any, kind: string): string | null {
  const block = json?.promptFeedback?.blockReason || json?.promptFeedback?.block_reason;
  if (block) return `Google ${kind} blocked by safety (${block}). Try a different crop or model.`;
  const cand = json?.candidates?.[0];
  if (!cand) return `Google ${kind} returned no candidates.`;
  const fr = cand.finishReason || cand.finish_reason;
  if (fr && fr !== 'STOP' && fr !== 'MAX_TOKENS' && fr !== 'END_TURN') {
    return `Google ${kind} finished with ${fr}.`;
  }
  return null;
}

async function googleStream(
  conn: TextConnection, messages: BuiltMessage[], params: GenParams, apiKey: string, controller: AbortController,
): Promise<StreamHandle> {
  const sysParts = messages.filter((m) => m.role === 'system' && messages.indexOf(m) < firstNonSystem(messages));
  const rest = messages.slice(firstNonSystem(messages));
  const contents = mergeConsecutive(
    rest.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      content: m.role === 'system' ? `[System note]\n${m.content}` : m.content,
    })),
  ).map((m) => ({ role: m.role === 'assistant' ? 'model' : m.role, parts: [{ text: m.content }] }));
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '[Begin.]' }] });
  const base = conn.baseUrl?.replace(/\/$/, '') || 'https://generativelanguage.googleapis.com';
  const res = await zdrFetch(
    `${base}/v1beta/models/${encodeURIComponent(conn.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: sysParts.length ? { parts: [{ text: sysParts.map((m) => m.content).join('\n\n') }] } : undefined,
        contents,
        safetySettings: GOOGLE_RELAXED_SAFETY,
        generationConfig: {
          temperature: params.temperature,
          topP: params.top_p,
          ...(params.top_k && params.top_k > 0 ? { topK: params.top_k } : {}),
          maxOutputTokens: params.max_tokens,
          stopSequences: params.stops?.length ? params.stops.slice(0, 5) : undefined,
        },
      }),
    },
  );
  const deltas = await readSse(res, (json) => googlePartsText(json.candidates?.[0]?.content?.parts), controller.signal);
  return { deltas, abort: () => safeAbort(controller) };
}

async function googleComplete(
  conn: TextConnection,
  messages: BuiltMessage[],
  params: GenParams & { jsonMode?: boolean },
  apiKey: string,
): Promise<string> {
  const sysParts = messages.filter((m) => m.role === 'system' && messages.indexOf(m) < firstNonSystem(messages));
  const rest = messages.slice(firstNonSystem(messages));
  const contents = mergeConsecutive(
    rest.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      content: m.role === 'system' ? `[System note]\n${m.content}` : m.content,
    })),
  ).map((m) => ({ role: m.role === 'assistant' ? 'model' : m.role, parts: [{ text: m.content }] }));
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '[Begin.]' }] });
  const base = conn.baseUrl?.replace(/\/$/, '') || 'https://generativelanguage.googleapis.com';
  const generationConfig: Record<string, unknown> = {
    temperature: params.temperature,
    topP: params.top_p,
    maxOutputTokens: Math.max(1, params.max_tokens),
  };
  if (params.top_k && params.top_k > 0) generationConfig.topK = params.top_k;
  if (params.jsonMode) generationConfig.responseMimeType = 'application/json';

  const res = await zdrFetch(
    `${base}/v1beta/models/${encodeURIComponent(conn.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: sysParts.length ? { parts: [{ text: sysParts.map((m) => m.content).join('\n\n') }] } : undefined,
        contents,
        safetySettings: GOOGLE_RELAXED_SAFETY,
        generationConfig,
      }),
    },
  );
  if (!res.ok) throw new Error(`Google error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json: any = await res.json();
  const hard = googleFinishError(json, 'text');
  const text = googlePartsText(json.candidates?.[0]?.content?.parts).trim();
  if (!text) {
    throw new Error(hard || 'Google returned empty text (safety or thinking-only). Try a non-thinking Flash model or raise max tokens.');
  }
  return text;
}

function firstNonSystem(messages: BuiltMessage[]): number {
  const i = messages.findIndex((m) => m.role !== 'system');
  return i === -1 ? messages.length : i;
}

function mergeConsecutive<T extends { role: string; content: string }>(msgs: T[]): T[] {
  const out: T[] = [];
  for (const m of msgs) {
    const last = out.at(-1);
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ ...m });
  }
  return out;
}

export interface GenerateOnceOpts {
  maxTokens?: number;
  temperature?: number;
  /** Prefer provider JSON mode (Gemini responseMimeType / OpenAI response_format). */
  jsonMode?: boolean;
  /**
   * Wall-clock ceiling for the whole call. A provider that accepts the socket and
   * then never sends a byte otherwise hangs this promise forever — and any caller
   * holding a lock around it (background consolidation) stops working until the
   * process restarts, silently. Every unattended call must set this.
   */
  timeoutMs?: number;
}

/**
 * Reject after `ms`, running `onTimeout` so the underlying request is torn down
 * rather than left streaming into a promise nobody is awaiting.
 */
function deadline<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  if (!ms || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* teardown is best-effort */ }
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s with no usable response`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Non-streaming convenience for agent / structured calls. */
export async function generateOnce(
  conn: TextConnection,
  system: string,
  user: string,
  maxTokensOrOpts: number | GenerateOnceOpts = 800,
): Promise<string> {
  const opts: GenerateOnceOpts = typeof maxTokensOrOpts === 'number'
    ? { maxTokens: maxTokensOrOpts }
    : maxTokensOrOpts;
  const maxTokens = opts.maxTokens ?? 800;
  const budget = opts.timeoutMs ?? 0;
  const started = Date.now();
  /** Time left in the budget, so retries cannot each take the full allowance. */
  const remaining = () => (budget ? Math.max(1000, budget - (Date.now() - started)) : 0);
  const temperature = opts.temperature ?? (opts.jsonMode ? 0.4 : 0.7);
  const messages: BuiltMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const params: GenParams & { jsonMode?: boolean } = {
    temperature,
    top_p: 1,
    max_tokens: maxTokens,
    stream: false,
    jsonMode: opts.jsonMode,
  };

  // Structured / Google: non-stream complete is far more reliable than SSE (Flash thinking, empty streams)
  if (opts.jsonMode || conn.provider === 'google') {
    try {
      const complete = await deadline(
        generateTextComplete(conn, messages, params), remaining(), 'Model call',
      );
      if (complete.trim()) return complete;
    } catch (e) {
      // Some Gemini model ids reject responseMimeType — retry without JSON mode once
      if (opts.jsonMode) {
        try {
          const retry = await deadline(
            generateTextComplete(conn, messages, { ...params, jsonMode: false }),
            remaining(), 'Model call (retry)',
          );
          if (retry.trim()) return retry;
        } catch {
          throw e;
        }
      }
      // fall through to stream for non-json
    }
  }

  const handle = await generateText(conn, messages, { ...params, stream: true });
  const drain = (async () => {
    let acc = '';
    for await (const d of handle.deltas) acc += d;
    return acc;
  })();
  // A stalled stream is aborted, not merely abandoned.
  let out = await deadline(drain, remaining(), 'Model stream', () => handle.abort());
  if (!out.trim() && conn.provider !== 'google') {
    // last-chance non-stream fallback
    out = await deadline(generateTextComplete(conn, messages, params), remaining(), 'Model call');
  }
  return out;
}

// ---------- Vision (non-streaming, for Style Analyst etc.) ----------

export interface VisionImage { mime: string; b64: string }

export interface VisionOnceOpts {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

/**
 * One-shot multimodal call: system + user text + images.
 * Supports openai/openrouter/custom (image_url), anthropic (source blocks), google (inlineData).
 */
export async function generateOnceVision(
  conn: TextConnection,
  system: string,
  user: string,
  images: VisionImage[],
  maxTokensOrOpts: number | VisionOnceOpts = 600,
): Promise<string> {
  const opts: VisionOnceOpts = typeof maxTokensOrOpts === 'number'
    ? { maxTokens: maxTokensOrOpts }
    : maxTokensOrOpts;
  const maxTokens = opts.maxTokens ?? 600;
  const temperature = opts.temperature ?? 0.3;
  const jsonMode = opts.jsonMode ?? false;

  const apiKey = (await getSecret(secretKeyFor(conn.provider))) ?? '';
  if (!apiKey && conn.provider !== 'custom') {
    throw new Error(`No API key configured for ${conn.provider}.`);
  }

  if (conn.provider === 'anthropic') {
    const res = await zdrFetch(`${conn.baseUrl?.replace(/\/$/, '') || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: conn.model,
        system,
        max_tokens: maxTokens,
        temperature: Math.min(temperature, 1),
        messages: [{
          role: 'user',
          content: [
            ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } })),
            { type: 'text', text: user },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic vision error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json: any = await res.json();
    const text = (json.content ?? []).map((c: any) => c.text ?? '').join('').trim();
    if (!text) throw new Error('Anthropic vision returned empty text.');
    return text;
  }

  if (conn.provider === 'google') {
    const base = conn.baseUrl?.replace(/\/$/, '') || 'https://generativelanguage.googleapis.com';
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: Math.max(maxTokens, 512),
      temperature,
    };
    if (jsonMode) generationConfig.responseMimeType = 'application/json';

    const res = await zdrFetch(`${base}/v1beta/models/${encodeURIComponent(conn.model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{
          role: 'user',
          parts: [
            ...images.map((img) => ({ inlineData: { mimeType: img.mime || 'image/png', data: img.b64 } })),
            { text: user },
          ],
        }],
        safetySettings: GOOGLE_RELAXED_SAFETY,
        generationConfig,
      }),
    });
    if (!res.ok) throw new Error(`Google vision error ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const json: any = await res.json();
    const hard = googleFinishError(json, 'vision');
    let text = googlePartsText(json.candidates?.[0]?.content?.parts).trim();
    // Some thinking models put output only in a later part or as a single string field
    if (!text && typeof json.candidates?.[0]?.content?.parts?.[0]?.text === 'string') {
      text = String(json.candidates[0].content.parts.map((p: any) => p.text || '').join('')).trim();
    }
    if (!text) {
      throw new Error(
        hard
        || 'Google vision returned no text (common on Gemini Flash with safety or thinking-only turns). Try Gemini Flash-Lite / Pro, or a smaller crop.',
      );
    }
    return text;
  }

  // openai / openrouter / custom — OpenAI-compatible content parts
  const base = conn.baseUrl?.replace(/\/$/, '')
    || (conn.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
  const body: Record<string, unknown> = {
    model: conn.model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } })),
          { type: 'text', text: user },
        ],
      },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await zdrFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (jsonMode && res.status === 400) {
      delete body.response_format;
      const retry = await zdrFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!retry.ok) throw new Error(`Vision error ${retry.status}: ${(await retry.text()).slice(0, 300)}`);
      const rj: any = await retry.json();
      const t = extractCompleteText(rj).trim();
      if (!t) throw new Error('Vision model returned empty content.');
      return t;
    }
    throw new Error(`Vision error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json: any = await res.json();
  const content = extractCompleteText(json).trim();
  if (!content) throw new Error('Vision model returned empty content.');
  return content;
}
