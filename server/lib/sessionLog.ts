/**
 * Session terminal — an in-memory record of every model call this process made.
 *
 * Deliberately **not persisted**. It lives and dies with the server process, is
 * never written to disk, and therefore never touches the vault. That is a
 * feature, not a limitation: a full transcript of prompts is the most sensitive
 * artefact this app can produce — it contains the assembled system prompt, the
 * character's private memory, the user's persona and the raw replies — and the
 * safest place for it is nowhere.
 *
 * The buffer is bounded twice over: a cap on entries, and a cap on the bytes of
 * any single field. An app that quietly grows a gigabyte of prompt history in RAM
 * while the user roleplays for six hours is a bug, not an inspector.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Entries retained. Oldest are dropped first. */
const MAX_ENTRIES = 300;
/** Per-field character cap, so one runaway prompt cannot dominate the buffer. */
const MAX_FIELD = 40_000;

export type LogPhase = 'request' | 'response' | 'error';

export interface LogMessage {
  role: string;
  content: string;
}

export interface SessionLogEntry {
  id: string;
  /** Wall clock, for the timestamp column. */
  at: number;
  /** Monotonic sequence so the UI can order entries that share a millisecond. */
  seq: number;
  phase: LogPhase;
  /** What this call was for — `generate`, `brain.encoder`, `proofread`… */
  purpose: string;
  provider: string;
  model: string;
  /** Set on response/error entries, linking back to the request. */
  requestId?: string;
  /** Full assembled prompt, exactly as sent. */
  messages?: LogMessage[];
  /** Sampling parameters actually used. */
  params?: Record<string, unknown>;
  /** Model output. */
  text?: string;
  error?: string;
  /** Milliseconds from request to this entry. */
  durationMs?: number;
  /** Rough character counts, so cost is visible without a tokeniser. */
  chars?: { prompt: number; completion: number };
  /** True when the call was streamed. */
  streamed?: boolean;
}

const buffer: SessionLogEntry[] = [];
let seq = 0;
/** Bumped whenever the buffer is cleared, so clients can detect a reset. */
let epoch = Date.now();

type Listener = (entry: SessionLogEntry) => void;
const listeners = new Set<Listener>();

function truncate(s: string): string {
  if (s.length <= MAX_FIELD) return s;
  return `${s.slice(0, MAX_FIELD)}\n… [${s.length - MAX_FIELD} more characters not retained]`;
}

/**
 * Strip anything that must never appear in a transcript the user can copy.
 *
 * Keys are supplied via headers, not message content, so this is belt-and-braces
 * — but a single leaked key in a log someone pastes into a bug report is
 * unrecoverable, so the guard stays.
 */
function scrub(s: string): string {
  return s
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})/g, 'sk-…redacted')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1…redacted');
}

function push(entry: Omit<SessionLogEntry, 'id' | 'at' | 'seq'>): SessionLogEntry {
  const full: SessionLogEntry = {
    ...entry,
    id: randomUUID(),
    at: Date.now(),
    seq: ++seq,
  };
  buffer.push(full);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  for (const fn of listeners) {
    try { fn(full); } catch { /* a broken listener must not break generation */ }
  }
  return full;
}

export interface RequestInput {
  purpose: string;
  provider: string;
  model: string;
  messages: LogMessage[];
  params?: Record<string, unknown>;
  streamed?: boolean;
}

/**
 * Record an outgoing call. Returns a handle for closing it out.
 *
 * Every method on the handle swallows its own errors: the terminal is an
 * observer, and an observer that can break the thing it observes is worse than
 * no observer at all.
 */
export function logRequest(input: RequestInput) {
  const started = Date.now();
  let entry: SessionLogEntry | null = null;
  try {
    const messages = input.messages.map((m) => ({
      role: m.role,
      content: truncate(scrub(String(m.content ?? ''))),
    }));
    entry = push({
      phase: 'request',
      purpose: input.purpose,
      provider: input.provider,
      model: input.model,
      messages,
      params: input.params,
      streamed: input.streamed,
      chars: {
        prompt: input.messages.reduce((n, m) => n + String(m.content ?? '').length, 0),
        completion: 0,
      },
    });
  } catch { /* logging must never throw into the call path */ }

  return {
    id: entry?.id,
    ok(text: string) {
      try {
        push({
          phase: 'response',
          requestId: entry?.id,
          purpose: input.purpose,
          provider: input.provider,
          model: input.model,
          text: truncate(scrub(String(text ?? ''))),
          durationMs: Date.now() - started,
          chars: { prompt: entry?.chars?.prompt ?? 0, completion: String(text ?? '').length },
          streamed: input.streamed,
        });
      } catch { /* ignore */ }
    },
    fail(err: unknown) {
      try {
        push({
          phase: 'error',
          requestId: entry?.id,
          purpose: input.purpose,
          provider: input.provider,
          model: input.model,
          error: scrub(err instanceof Error ? err.message : String(err)),
          durationMs: Date.now() - started,
          streamed: input.streamed,
        });
      } catch { /* ignore */ }
    },
  };
}

export function readSessionLog(sinceSeq = 0): { epoch: number; entries: SessionLogEntry[] } {
  return { epoch, entries: buffer.filter((e) => e.seq > sinceSeq) };
}

export function clearSessionLog(): void {
  buffer.length = 0;
  seq = 0;
  epoch = Date.now();
}

export function subscribeSessionLog(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function sessionLogStats() {
  return {
    epoch,
    entries: buffer.length,
    max: MAX_ENTRIES,
    /** Approximate retained size, so the cost of the inspector is visible. */
    bytes: buffer.reduce(
      (n, e) => n + (e.text?.length ?? 0)
        + (e.messages?.reduce((m, x) => m + x.content.length, 0) ?? 0),
      0,
    ),
  };
}

// ---------- ambient purpose ----------

/**
 * Which feature a model call belongs to, tracked ambiently.
 *
 * The alternative is threading a `purpose` parameter through twenty call sites
 * and every provider adapter, which is a lot of churn for a label. An async
 * context keeps the provider layer unaware that the terminal exists.
 */
const purposeStore = new AsyncLocalStorage<string>();

export function runWithPurpose<T>(purpose: string, fn: () => T): T {
  return purposeStore.run(purpose, fn);
}

export function currentPurpose(fallback = 'model call'): string {
  return purposeStore.getStore() ?? fallback;
}
