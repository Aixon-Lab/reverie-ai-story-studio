/**
 * Model routing (§N.3.3).
 *
 * Almost every call this app makes that is *not* the roleplay reply is structured
 * extraction: transcript to appraised events, card to trait vector, scene to a
 * speaker decision, draft to corrected draft. The routing literature is
 * consistent that classification, structured extraction and summarisation run on
 * small models with no perceptible quality loss, and that moving 60-70% of
 * traffic there is worth roughly 40% of spend.
 *
 * The design constraint here is that it must be **free to ignore**. If the user
 * has not configured a cheap model, every task resolves exactly as it did before
 * — `utilityConnection ?? textConnection` — so routing can never silently
 * downgrade someone who did not ask for it.
 *
 * Escalation is not a separate mechanism. The callers that matter already detect
 * their own failure (the brain encoder validates that it got usable events, the
 * proofreader validates length), and they already retry. Routing simply makes the
 * *first* attempt cheap and the retry strong, which turns an existing retry into
 * a cascade for free.
 */
import type { AppSettings, TextConnection } from '../../shared/types';

/**
 * What kind of work a call is, which is what decides where it can safely run.
 *
 * Deliberately about the *shape* of the output rather than the feature, because
 * the shape is what predicts whether a small model can do it.
 */
export type TaskKind =
  /** JSON against a fixed schema. Small models are reliable here. */
  | 'extract'
  /** Short, constrained prose where voice does not matter (summaries, labels). */
  | 'summarise'
  /** Prose a human will read as authored — needs the good model. */
  | 'write'
  /** The roleplay reply itself. Never routed. */
  | 'perform';

export interface RoutedConnections {
  /** First attempt. */
  primary: TextConnection;
  /**
   * Where to go when the primary fails its own validity check. Null when the
   * primary is already the strongest option, so callers can skip a pointless
   * second attempt against the same model.
   */
  escalation: TextConnection | null;
}

/** The strong utility model — what everything used before routing existed. */
export function utilityConnection(settings: AppSettings): TextConnection {
  return settings.utilityConnection ?? settings.textConnection;
}

function sameModel(a: TextConnection, b: TextConnection): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/**
 * Resolve where a task should run.
 *
 * `extract` and `summarise` start cheap and escalate. `write` and `perform` never
 * route: a proofreader that mangles someone's voice or a reply that reads as
 * cheap costs far more than the tokens saved.
 */
export function route(settings: AppSettings, kind: TaskKind): RoutedConnections {
  const strong = utilityConnection(settings);
  const cheap = settings.cheapConnection;

  if (kind === 'perform' || kind === 'write') {
    return { primary: kind === 'perform' ? settings.textConnection : strong, escalation: null };
  }
  if (!cheap?.model?.trim() || sameModel(cheap, strong)) {
    return { primary: strong, escalation: null };
  }
  return { primary: cheap, escalation: strong };
}

/**
 * Run `attempt` against the routed models, cheapest first.
 *
 * `attempt` must throw, or return a value `accept` rejects, for escalation to
 * happen — the caller owns the definition of "this answer is unusable", because
 * only the caller knows what it asked for.
 */
export async function runRouted<T>(
  settings: AppSettings,
  kind: TaskKind,
  attempt: (conn: TextConnection, isEscalation: boolean) => Promise<T>,
  accept: (value: T) => boolean,
): Promise<{ value: T; conn: TextConnection; escalated: boolean }> {
  const { primary, escalation } = route(settings, kind);

  let firstError: unknown;
  try {
    const value = await attempt(primary, false);
    if (accept(value)) return { value, conn: primary, escalated: false };
    firstError = new Error('primary produced an unusable result');
  } catch (err) {
    firstError = err;
  }

  if (!escalation) {
    if (firstError instanceof Error) throw firstError;
    throw new Error('Model produced an unusable result and there is nothing to escalate to.');
  }

  const value = await attempt(escalation, true);
  return { value, conn: escalation, escalated: true };
}

/** Human-readable, for audit lines that explain which model did the work. */
export function describeConnection(conn: TextConnection): string {
  return `${conn.provider}:${conn.model || '(default)'}`;
}
