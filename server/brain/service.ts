/**
 * Brain orchestration: the only place that combines the pure engine with I/O
 * and model calls.
 *
 *   initBrain           card → dispositional anchor (one LLM call, once)
 *   runConsolidation    transcript → appraised events → consolidate (one LLM call per pass)
 *   buildBrainContext   live recall → budgeted prompt block (no LLM call at all)
 *
 * Everything degrades: no key, rate limit, or bad JSON falls back to the
 * offline heuristic encoder so the brain keeps growing regardless.
 */
import { randomUUID } from 'node:crypto';
import type { CharacterCard, ChatMessage, DirectorState, TextConnection } from '../../shared/types';
import {
  brainDispositionPrompt, brainEncoderPrompt, type EncoderCharacterContext,
} from '../../shared/brain/prompts';
import { consolidate } from '../../shared/brain/consolidation';
import { composeBrainContext, brainDemandTokens } from '../../shared/brain/compose';
import { cueFromContext, recall, applyRetrievalEffects } from '../../shared/brain/retrieval';
import { planContext, estimateBrainTokens, type ContextPlan } from '../../shared/brain/budget';
import { dispositionFromText, normalizeTraits } from '../../shared/brain/personality';
import { heuristicEncode, type TranscriptTurn } from '../../shared/brain/heuristics';
import { clamp01, clampSigned } from '../../shared/brain/activation';
import {
  formIntention, setSteer, spendIntention, spendSteer, ttlFromIntensity,
  type IntentionKind,
} from '../../shared/brain/volition';
import { gateChunk } from '../../shared/brain/admission';
import { holdEvents, holdRecentTurns } from '../../shared/brain/working';
import { learnAliasGroups, resolvePerson } from '../../shared/brain/entities';
import { mergeGenerationEffects } from '../../shared/brain/persist';
import { MAX_BRAIN_SHARE, TRAIT_AXES } from '../../shared/brain/defaults';
import type {
  AppraisedEvent, BrainState, ConsolidationReport, Goal, MemoryNode,
} from '../../shared/brain/types';
import { generateOnce } from '../providers/text';
import { runWithPurpose } from '../lib/sessionLog';
import { resolveContextLimit } from '../providers/contextLimits';
import { parseModelJson } from '../lib/parseModelJson';
import { appendAudit, loadBrain, loadBrainIfExists, saveBrain, summarizeReport, withBrainLock } from './store';
import type { BrainConfigFields } from '../../shared/brain/config';
import { advancePsyche, readIdentity } from './psycheStep';
import {
  DEFAULT_PSYCHE_PARAMS, actionTendency, checkIntrusions, composePsycheBlock,
  computeStance, describeBond, describeLifeStory, describeSelfConcept,
  describeTheoryOfMind, express, guardedTopics,
} from '../../shared/psyche';

/**
 * Ceiling on any single brain model call.
 *
 * Background work must fail fast and fall back rather than hang: these calls run
 * while the user is chatting, and a stalled one used to freeze all future memory
 * formation for the conversation until the server restarted.
 */
const BRAIN_CALL_TIMEOUT_MS = 90_000;

// ---------- init ----------

export function cardContext(card: CharacterCard): EncoderCharacterContext {
  return {
    name: card.name,
    description: card.description ?? '',
    personality: card.personality ?? '',
    scenario: card.scenario ?? '',
  };
}

/**
 * Derive the dispositional anchor from the card, for this character *in this
 * chat*. Two conversations with the same character start from the same
 * temperament and diverge from there — which is exactly how meeting the same
 * person under different circumstances works.
 *
 * The heuristic lexicon runs first and always — so a brain is never blank —
 * and the model then refines it. If the model is unavailable the heuristic
 * result stands on its own.
 */
export async function initBrain(
  chatId: string,
  card: CharacterCard,
  conn: TextConnection,
  opts: { force?: boolean; seed?: Partial<BrainConfigFields> } = {},
): Promise<BrainState> {
  return withBrainLock(chatId, card.id, async () => {
    const existed = !!(await loadBrainIfExists(chatId, card.id));
    const brain = await loadBrain(chatId, card.id, card.name);
    /**
     * A mind is born with the settings in force where it is born: the app's
     * defaults, overridden by this conversation's. Applied only at birth — once
     * a mind exists, its own page owns its config and nothing may overwrite it
     * behind the user's back.
     */
    if (!existed && opts.seed) Object.assign(brain.config, opts.seed);
    // Only a model-derived anchor is final. A lexicon-only or missing anchor is
    // retried on the next pass, so a brain that was created by consolidation —
    // or whose baseline call failed once — heals itself instead of sitting at
    // dead zero forever.
    if (brain.dispositionSource === 'model' && !opts.force) return brain;

    const prior = dispositionFromText(
      [card.description, card.personality, card.creator_notes, card.tags?.join(' ')].filter(Boolean).join('\n'),
    );
    // Preserve any drift already earned: re-anchoring must not reset who they
    // have become, only where they started.
    const drift = TRAIT_AXES.map((axis) => brain.traits[axis] - brain.disposition[axis]);
    brain.disposition = prior;
    brain.dispositionSource = 'lexicon';
    brain.traits = { ...prior };

    try {
      const p = brainDispositionPrompt(cardContext(card));
      const raw = await runWithPurpose('brain.disposition', () => generateOnce(conn, p.system, p.user, {
        maxTokens: 900, temperature: 0.3, jsonMode: true, timeoutMs: BRAIN_CALL_TIMEOUT_MS,
      }));
      const parsed = parseModelJson(raw, 'Brain baseline');
      brain.disposition = normalizeTraits(parsed.traits, prior);
      brain.dispositionSource = 'model';
      brain.traits = { ...brain.disposition };
      // Keep whatever the working self already learned in this chat.
      const selfImages = toStrings(parsed.selfImages).slice(0, 5);
      const concerns = toStrings(parsed.concerns).slice(0, 6);
      if (selfImages.length) brain.workingSelf.selfImages = selfImages;
      if (concerns.length) brain.workingSelf.concerns = concerns;
      if (!brain.workingSelf.goals.length) brain.workingSelf.goals = toGoals(parsed.goals);
      await appendAudit(chatId, card.id, {
        kind: 'init',
        chatId,
        summary: 'Baseline from card (model-refined)',
        detail: brain.disposition,
      });
    } catch (err: any) {
      await appendAudit(chatId, card.id, {
        kind: 'init',
        chatId,
        summary: `Baseline from card text only — will retry (model unavailable: ${err?.message ?? 'unknown'})`,
        detail: prior,
      });
    }

    // Re-apply earned drift on top of the new anchor, still inside its bounds.
    const max = brain.config.params.maxDrift;
    TRAIT_AXES.forEach((axis, i) => {
      const d = Math.max(-max, Math.min(max, drift[i] ?? 0));
      brain.traits[axis] = clampSigned(brain.disposition[axis] + d);
    });

    brain.characterName = card.name;
    await saveBrain(brain);
    return brain;
  });
}

// ---------- consolidation ----------

export interface ConsolidateOptions {
  chatId: string;
  /** Full message list for the chat. */
  messages: ChatMessage[];
  card: CharacterCard;
  /** First attempt - the cheap model when routing is configured. */
  conn: TextConnection;
  /** Where to retry when the first model fails its own validity check. */
  escalationConn?: TextConnection;
  /** Names present in the scene. */
  cast: string[];
  isGroup: boolean;
  /** Ignore the message cursor and re-read the whole tail. */
  force?: boolean;
  /**
   * Read exactly `[start, end)` of the message list instead of "everything
   * unread". One chunk of a chunked pass — the cursor lands on `end`, so a run
   * that is stopped or crashes resumes from the last finished chunk.
   */
  window?: { start: number; end: number };
  /** Token cap for the brain's active footprint, from the current model. */
  activeTokenCap?: number;
  now?: number;
}

export interface ConsolidateOutcome {
  brain: BrainState;
  report: ConsolidationReport | null;
  /** How the events were produced. */
  encoder: 'model' | 'heuristic' | 'none';
  consumed: number;
  reason?: string;
}

/** Where the next pass should start reading, and whether the stored cursor lied. */
export interface BrainCursor {
  /** Index of the first unread message. */
  start: number;
  /** Messages waiting to be read. */
  pending: number;
  /**
   * The stored cursor did not survive the transcript it points into (branch
   * restore, deleted message, deep-swipe fork) and was recomputed.
   */
  repaired: boolean;
  /** Human-readable note when `repaired`, for the audit log. */
  note?: string;
  /**
   * Why the position moved. `rewritten` is ordinary housekeeping — the user
   * swiped or edited and the mind is re-reading — while the other two mean the
   * stored cursor had genuinely broken and memory had stopped forming. Only the
   * latter deserve an error in the log.
   */
  reason?: 'rewritten' | 'deleted' | 'clamped';
}

/**
 * Resolve the read cursor for one chat.
 *
 * History is not append-only: swipes, edits, deletions, branch restores and
 * deep-swipe forks all rewrite it, and any of them can leave a bare message
 * *count* pointing past the end of a now-shorter transcript. When that happened
 * the old gate computed a negative number of pending messages, which is smaller
 * than any cadence, so consolidation stopped for that chat permanently and
 * silently — the "memory never updates again" failure.
 *
 * The last consumed message *id* is authoritative, because it survives every one
 * of those edits as long as the message itself does. The count is only a
 * fallback for brains written before the id existed, and it is always clamped
 * into the transcript.
 */
export function resolveCursor(
  brain: BrainState,
  chatId: string,
  messages: ChatMessage[],
): BrainCursor {
  const lastId = brain.stats.cursorMessageId?.[chatId];
  if (lastId) {
    const at = messages.findIndex((m) => m.id === lastId);
    if (at >= 0) {
      /**
       * The anchor survived — but did its *text*?
       *
       * A swipe, a Continue and an edit all keep the id and replace the words.
       * An id-only cursor therefore reported "nothing new" forever, and the
       * character went on remembering the swipe the user rejected. Rewinding by
       * one re-reads the message as it now stands; consolidation's own echo
       * detection (`findEcho`) folds the unchanged parts back onto the memory
       * that already exists rather than duplicating them.
       */
      const storedRev = brain.stats.cursorRevision?.[chatId] ?? 0;
      const liveRev = messages[at].revision ?? 0;
      if (liveRev !== storedRev) {
        return {
          start: at,
          pending: messages.length - at,
          repaired: true,
          note: `message ${at + 1}/${messages.length} was rewritten in place (swipe, continue or edit); re-reading it`,
          reason: 'rewritten',
        };
      }
      const start = at + 1;
      return { start, pending: messages.length - start, repaired: false };
    }
    /**
     * The message we stopped at no longer exists on this branch.
     *
     * The stored *count* is the wrong answer here: deleting a message shifts
     * every later index down by one, so resuming at the old number steps over
     * exactly one message that was never read. The trail of recently consumed
     * ids gives an exact resume point whenever any of them survived — which is
     * every ordinary deletion, since only one message went away.
     */
    const trail = brain.stats.cursorTrail?.[chatId] ?? [];
    for (let i = trail.length - 1; i >= 0; i--) {
      const at2 = messages.findIndex((m) => m.id === trail[i]);
      if (at2 < 0) continue;
      const start = at2 + 1;
      return {
        start,
        pending: messages.length - start,
        repaired: true,
        note: `last consumed message was deleted; resumed exactly after "${trail[i]}" at ${start}/${messages.length}`,
        reason: 'deleted',
      };
    }
    const stored = brain.stats.cursor[chatId] ?? 0;
    const start = Math.min(Math.max(0, stored), messages.length);
    return {
      start,
      pending: messages.length - start,
      repaired: true,
      note: `last consumed message is no longer in this conversation (branch or deletion); resuming at ${start}/${messages.length}`,
      reason: 'deleted',
    };
  }

  const stored = brain.stats.cursor[chatId] ?? 0;
  const start = Math.min(Math.max(0, stored), messages.length);
  return {
    start,
    pending: messages.length - start,
    repaired: start !== stored,
    note: start !== stored
      ? `cursor pointed at message ${stored} of a ${messages.length}-message conversation; clamped to ${start}`
      : undefined,
    reason: start !== stored ? 'clamped' : undefined,
  };
}

/**
 * One audit line for a cursor that moved on its own.
 *
 * A rewind after a swipe or an edit is the system working — logging it as an
 * error taught the log's reader to ignore exactly the entries that matter. A
 * cursor that had actually broken still gets one.
 */
function cursorAudit(chatId: string, cursor: BrainCursor) {
  if (cursor.reason === 'rewritten') {
    return {
      kind: 'consolidate' as const,
      chatId,
      summary: `Re-reading a rewritten message — ${cursor.note}.`,
    };
  }
  return {
    kind: 'error' as const,
    chatId,
    summary: `Read position repaired — ${cursor.note}. Memory had stopped forming; it resumes now.`,
  };
}

/**
 * Persist a healed read position without running a pass.
 *
 * Used when the cadence says "wait" but the stored cursor was nonsense: the bad
 * number has to be corrected on disk immediately, or it blocks the next turn's
 * gate exactly as it blocked this one — and costing the user a model call just
 * to fix bookkeeping would be worse than the bug.
 */
export async function repairCursor(
  chatId: string,
  characterId: string,
  characterName: string,
  messages: ChatMessage[],
): Promise<void> {
  await withBrainLock(chatId, characterId, async () => {
    const brain = await loadBrain(chatId, characterId, characterName);
    const cursor = resolveCursor(brain, chatId, messages);
    if (!cursor.repaired) return;
    /**
     * Write the healed position through the same helper the real pass uses, so
     * the id, the revision and the trail can never disagree with each other —
     * a repair that fixed the id but left a stale revision would re-trigger the
     * rewind on every single turn.
     */
    rememberCursor(brain, chatId, messages, cursor.start);
    await saveBrain(brain);
    await appendAudit(chatId, characterId, cursorAudit(chatId, cursor));
  });
}

/**
 * Mark the transcript as read up to `upTo` (default: all of it), by id *and* by
 * count. The id is what survives a branch or a deletion; the count is the
 * fallback when that message is gone.
 */
function rememberCursor(
  brain: BrainState,
  chatId: string,
  messages: ChatMessage[],
  upTo?: number,
): void {
  const at = Math.max(0, Math.min(upTo ?? messages.length, messages.length));
  brain.stats.cursor[chatId] = at;
  if (!brain.stats.cursorMessageId) brain.stats.cursorMessageId = {};
  if (!brain.stats.cursorRevision) brain.stats.cursorRevision = {};
  if (!brain.stats.cursorTrail) brain.stats.cursorTrail = {};
  const last = messages[at - 1];
  if (last) {
    brain.stats.cursorMessageId[chatId] = last.id;
    brain.stats.cursorRevision[chatId] = last.revision ?? 0;
    // Enough history to survive an ordinary run of deletions, and small enough
    // that it costs nothing to carry in every brain file.
    brain.stats.cursorTrail[chatId] = messages.slice(Math.max(0, at - CURSOR_TRAIL), at).map((m) => m.id);
  } else {
    delete brain.stats.cursorMessageId[chatId];
    delete brain.stats.cursorRevision[chatId];
    delete brain.stats.cursorTrail[chatId];
  }
}

/** How many consumed message ids to keep as deletion-proof resume points. */
const CURSOR_TRAIL = 8;

/**
 * Run one consolidation pass over everything said since this brain last looked.
 *
 * Group chats: `card` is the character whose head we are in, and the transcript
 * is rendered with speaker labels so the encoder can honour "only what they
 * witnessed".
 */
export async function runConsolidation(opts: ConsolidateOptions): Promise<ConsolidateOutcome> {
  return withBrainLock(opts.chatId, opts.card.id, async () => {
    const now = opts.now ?? Date.now();
    const brain = await loadBrain(opts.chatId, opts.card.id, opts.card.name);
    if (!brain.config.enabled) {
      return { brain, report: null, encoder: 'none', consumed: 0, reason: 'brain disabled' };
    }

    const cursor = resolveCursor(brain, opts.chatId, opts.messages);
    if (cursor.repaired) {
      await appendAudit(opts.chatId, opts.card.id, cursorAudit(opts.chatId, cursor));
    }
    // A chunked run says exactly what to read; otherwise it is everything unread
    // (or, when forced, everything there is).
    const from = opts.window ? Math.max(0, opts.window.start) : (opts.force ? 0 : cursor.start);
    const to = opts.window
      ? Math.min(opts.window.end, opts.messages.length)
      : opts.messages.length;
    const fresh = opts.messages.slice(from, to);
    if (!fresh.length) {
      // Still record the id cursor: a repaired count must not stay wrong.
      rememberCursor(brain, opts.chatId, opts.messages, to);
      await saveBrain(brain);
      return { brain, report: null, encoder: 'none', consumed: 0, reason: 'nothing new' };
    }

    const turns: TranscriptTurn[] = fresh
      .filter((m) => !m.hiddenFromPrompt && m.text?.trim())
      .map((m) => ({
        id: m.id,
        speaker: m.speaker.displayName,
        text: m.text,
        isUser: m.speaker.type === 'user' || m.controlledBy === 'human',
      }));

    if (!turns.length) {
      rememberCursor(brain, opts.chatId, opts.messages, to);
      await saveBrain(brain);
      return { brain, report: null, encoder: 'none', consumed: fresh.length, reason: 'no usable turns' };
    }

    const transcript = turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    const candidates = candidateNodes(brain);

    let events: AppraisedEvent[] = [];
    let encoder: ConsolidateOutcome['encoder'] = 'heuristic';
    let goalUpdates: unknown;
    let chapterTitle = '';

    /**
     * Two-band admission (§B.2 #29). Cheap-score the stretch *before* paying
     * for a model call. Uniformly forgettable stretches skip the encoder
     * entirely; uniformly loud ones keep the heuristic events; only the
     * borderline band escalates.
     */
    const cheap = heuristicEncode(turns, opts.card.name);
    const gate = gateChunk(cheap);

    const p = brainEncoderPrompt({
      character: cardContext(opts.card),
      brain,
      transcript,
      candidates,
      cast: opts.cast,
      isGroup: opts.isGroup,
    });

    /**
     * Two attempts, then heuristics.
     *
     * A utility model that answers in the wrong *shape* — a bare array, a
     * `{"memories":[…]}` wrapper, `summary` where the contract says `gist` — used
     * to cost the whole pass: valid JSON, no exception, zero events, and a log
     * line reading "nothing worth keeping" that blamed the conversation instead
     * of the model. `extractEvents` now accepts the shapes models actually
     * produce, and a single corrective retry catches the rest.
     */
    let lastRaw = '';
    let failure = '';

    if (gate.action === 'drop') {
      events = [];
      encoder = 'none';
      await appendAudit(opts.chatId, opts.card.id, {
        kind: 'consolidate',
        chatId: opts.chatId,
        summary: `Admission gate dropped ${turns.length} turn(s) — ${gate.reason}.`,
        detail: { gate },
      });
    } else if (gate.action === 'admit') {
      events = gate.admitted;
      encoder = 'heuristic';
      await appendAudit(opts.chatId, opts.card.id, {
        kind: 'consolidate',
        chatId: opts.chatId,
        summary: `Admission gate admitted ${events.length} event(s) without a model call — ${gate.reason}.`,
        detail: { gate },
      });
    }

    /**
     * Attempt 0 runs on the cheap model when one is configured, attempt 1 on the
     * strong one. The retry already existed for shape failures, so making it a
     * cascade costs nothing extra: encoding is structured extraction, exactly the
     * task class small models handle well, and the validity check that triggers
     * escalation is the same one that was already there.
     */
    const encoderConns = [opts.conn, opts.escalationConn ?? opts.conn];
    for (let attempt = 0; attempt < 2 && !events.length && gate.action === 'escalate'; attempt++) {
      try {
        const raw = await runWithPurpose(
          attempt === 0 ? 'brain.encoder' : 'brain.encoder (escalated)',
          () => generateOnce(
          encoderConns[attempt],
          p.system,
          attempt === 0 ? p.user : `${p.user}\n\n${ENCODER_RETRY_NOTE}`,
          {
            maxTokens: 3500,
            temperature: attempt === 0 ? 0.35 : 0.2,
            jsonMode: true,
            timeoutMs: BRAIN_CALL_TIMEOUT_MS,
          },
        ));
        lastRaw = String(raw ?? '');
        const parsed = parseModelJson(raw, 'Brain encoder');
        events = normalizeEvents(extractEvents(parsed), brain);
        // Worth keeping even from an eventless response: the story may have moved
        // on and the goals may have changed regardless.
        goalUpdates = pluck(parsed, 'goalUpdates') ?? goalUpdates;
        chapterTitle = String(pluck(parsed, 'chapterTitle') ?? chapterTitle ?? '').trim();
        if (events.length) encoder = 'model';
        else failure = `returned no usable events (attempt ${attempt + 1})`;
      } catch (err: any) {
        failure = err?.message ?? 'unknown error';
      }
    }

    /**
     * Last resort: the offline encoder. Applied at *any* transcript length —
     * a two-turn stretch that the model dropped is still two turns of story, and
     * "the model was useless so nothing happened" is never the right outcome.
     *
     * Not applied when the admission gate already dropped the stretch: that
     * decision is the cost saving, and undoing it here would pay in disk
     * writes for events we just agreed were forgettable.
     */
    if (!events.length && gate.action === 'escalate') {
      events = heuristicEncode(turns, opts.card.name);
      encoder = events.length ? 'heuristic' : 'none';
      await appendAudit(opts.chatId, opts.card.id, {
        kind: 'error',
        chatId: opts.chatId,
        summary:
          `Utility model gave the encoder nothing usable for ${turns.length} turn(s) — ${failure}. `
          + (events.length
            ? 'Fell back to offline heuristics, so memory still formed. If this repeats, point Settings → Connections → utility model at a model that follows a JSON contract.'
            : 'Offline heuristics found nothing either, so this stretch encoded no memories.'),
        detail: { rawPreview: lastRaw.slice(0, 400) || '(no text returned)' },
      });
    }

    const chapterId = chapterTitle ? ensureChapter(brain, chapterTitle, opts.chatId, now) : currentChapterId(brain);

    const report = consolidate(brain, {
      events,
      now,
      chatId: opts.chatId,
      chapterId,
      makeId: () => randomUUID(),
      activeTokenCap: opts.activeTokenCap,
      countTokens: estimateBrainTokens,
      cast: opts.cast,
    });

    applyGoalUpdates(brain, goalUpdates, now);
    for (const event of events) learnAliasGroups(brain, event.aliases, opts.cast);

    /**
     * The mind lives through what the memory pass just recorded: the body pays,
     * load accumulates, a regulation move is chosen and costs something, any new
     * trauma becomes a live trace, and the condition is re-read from the graph.
     * Never allowed to break a consolidation — memory must survive the psyche
     * failing, the same way it survives the encoder failing.
     */
    try {
      brain.psyche = advancePsyche({
        brain, events, report, cast: opts.cast, transcript, now,
      });
    } catch (err: any) {
      await appendAudit(opts.chatId, opts.card.id, {
        kind: 'error',
        chatId: opts.chatId,
        summary: `Psyche step failed, memory kept: ${err?.message ?? 'unknown'}`,
      });
    }

    rememberCursor(brain, opts.chatId, opts.messages, to);
    brain.characterName = opts.card.name;
    await saveBrain(brain);
    await appendAudit(opts.chatId, opts.card.id, {
      kind: 'consolidate',
      chatId: opts.chatId,
      // Yield is spelled out so "why do I only have one memory?" is answerable
      // from the log alone: proposed → gate → merged → kept.
      summary:
        `${encoder} encoder read ${turns.length} turns, proposed ${events.length} event(s) — `
        + summarizeReport(report),
      detail: { ...report, proposed: events.length, turns: turns.length },
    });

    return { brain, report, encoder, consumed: fresh.length };
  });
}

/**
 * Memories the encoder should be shown so it can flag contradictions and
 * extensions. Strongest and most recent first; capped so the prompt stays cheap.
 */
function candidateNodes(brain: BrainState, limit = 24): MemoryNode[] {
  return Object.values(brain.nodes)
    .filter((n) => n.status !== 'dormant')
    .sort((a, b) => (b.lastRetrievedAt ?? b.encodedAt) - (a.lastRetrievedAt ?? a.encodedAt))
    .slice(0, limit);
}

// ---------- live recall for generation ----------

export interface BrainContextInput {
  brains: { card: CharacterCard; brain: BrainState }[];
  history: ChatMessage[];
  /** Names in the scene, used both as cues and to pick which relations to emit. */
  cast: string[];
  place?: string;
  conn: TextConnection;
  /** preset.max_tokens — reserved for the reply. */
  reservedOutput: number;
  /**
   * preset.max_context. The effective window is the smaller of this and the
   * model's real window: the user's own context slider must never be exceeded
   * just because the model could take more.
   */
  presetMaxContext?: number;
  /** Tokens the rest of the prompt scaffolding already costs, if known. */
  fixedPromptTokens?: number;
  now?: number;
  /**
   * Live director state. When a nudge or scene goal is set and this mind
   * has no active steer, the directive is planted here so story direction
   * actually reaches volition rather than only the prompt.
   */
  director?: DirectorState;
}

export interface BrainContextResult {
  text: string;
  tokens: number;
  plan: ContextPlan;
  /** Per-character detail for the prompt inspector / Mind page. */
  perCharacter: {
    characterId: string;
    characterName: string;
    tokens: number;
    recalled: number;
    intrusions: number;
    includedIds: string[];
  }[];
  /** Brains whose retrieval side effects still need persisting. */
  dirty: BrainState[];
}

/**
 * Build the brain block for one generation.
 *
 * No model call. Cost is one graph pass per participating character, which is
 * milliseconds even at thousands of nodes.
 */
export async function buildBrainContext(input: BrainContextInput): Promise<BrainContextResult | null> {
  /**
   * A brain with no memories can still have a *state*: exhausted, frightened,
   * carrying a load, expecting the worst of the person in front of them. Gating
   * the whole block on node count meant none of that reached the model until the
   * character happened to remember something, which is backwards — who they are
   * right now matters to the next line more than what they once knew.
   */
  const active = input.brains.filter((b) => b.brain.config.enabled
    && (Object.keys(b.brain.nodes).length > 0 || hasLivePsyche(b.brain)));
  if (!active.length) return null;

  const now = input.now ?? Date.now();
  const limit = await resolveContextLimit(input.conn);

  // Share is taken from the first participating brain (they are configured
  // together in settings); the ceiling is enforced regardless.
  const share = Math.min(MAX_BRAIN_SHARE, Math.max(0, active[0].brain.config.shareOfContext));
  const demand = active.reduce((s, b) => s + brainDemandTokens(b.brain, estimateBrainTokens), 0);

  const effectiveContext = input.presetMaxContext && input.presetMaxContext > 0
    ? Math.min(limit.contextTokens, input.presetMaxContext)
    : limit.contextTokens;

  const plan = planContext({
    modelContext: effectiveContext,
    reservedOutput: input.reservedOutput,
    share,
    brainDemand: demand,
    fixedPromptTokens: input.fixedPromptTokens,
  });
  if (plan.brainBudget <= 0) return null;

  const recentText = input.history
    .filter((m) => !m.hiddenFromPrompt)
    .slice(-8)
    .map((m) => `${m.speaker.displayName}: ${m.text}`)
    .join('\n');

  // Split the budget across participating brains, weighted by how much each wants.
  const weights = active.map((b) => Math.max(1, brainDemandTokens(b.brain, estimateBrainTokens)));
  const weightTotal = weights.reduce((a, b) => a + b, 0);

  const blocks: string[] = [];
  const perCharacter: BrainContextResult['perCharacter'] = [];
  const dirty: BrainState[] = [];
  let usedTotal = 0;

  active.forEach((entry, i) => {
    const budget = Math.floor((plan.brainBudget * weights[i]) / weightTotal);
    if (budget < 60) return;

    /**
     * Volition, before recall (`shared/brain/volition.ts`).
     *
     * Order matters. Spending comes first so an objective that has run out of
     * turns lapses *before* a new one is chosen, which is what lets a scene
     * change what it is about. Forming comes next, and only then is the cue
     * built — because what a character is trying to do is one of the strongest
     * things determining what comes to mind, and building the cue first would
     * have recall answer a question nobody was asking yet.
     */
    spendIntention(entry.brain);
    spendSteer(entry.brain);
    applyDirectorSteer(entry.brain, input.director, now);
    holdRecentTurns(
      entry.brain,
      input.history.filter((m) => !m.hiddenFromPrompt && m.text?.trim()).slice(-8)
        .map((m) => ({ speaker: m.speaker.displayName, text: m.text })),
      now,
      () => randomUUID(),
    );
    entry.brain.intention = formIntention(entry.brain, {
      present: input.cast.filter((c) => c !== entry.card.name),
      now,
      makeId: () => randomUUID(),
    });

    const cue = cueFromContext({
      recentText,
      actors: input.cast.filter((c) => c !== entry.card.name),
      place: input.place,
      brain: entry.brain,
      now,
      // An active objective is a standing retrieval cue: someone trying to get
      // an admission remembers different things than someone trying to leave.
      extraKeywords: entry.brain.intention?.text
        ? [entry.brain.intention.text, entry.brain.intention.target ?? ''].filter(Boolean)
        : undefined,
    });
    const result = recall(entry.brain, cue, { limit: 60 });
    /**
     * The psyche block is built first and paid for out of the same budget.
     *
     * Ordering is deliberate: *who is in the room* matters more to the next reply
     * than *what they once knew*, so when the budget is tight the state survives
     * and the oldest memories are what fall out.
     */
    const state = composeStateBlock(
      entry.brain,
      recentText,
      input.cast,
      now,
      result.hits.slice(0, 12).map((h) => h.node.id),
    );
    const stateTokens = state ? estimateBrainTokens(state) + 4 : 0;

    const composed = composeBrainContext(entry.brain, result.hits, {
      budget: Math.max(0, budget - stateTokens),
      now,
      presentActors: input.cast,
      countTokens: estimateBrainTokens,
      withHeader: true,
    });
    if (!composed.text.trim() && !state) return;

    // Only what actually reached the prompt counts as retrieved (§7.4).
    const usedHits = result.hits.filter((h) => composed.includedIds.includes(h.node.id));
    applyRetrievalEffects(entry.brain, usedHits, result.competitors, now);
    holdEvents(entry.brain, usedHits.slice(0, 4).map((h) => ({
      gist: h.node.gist,
      actors: h.node.actors,
      salience: 0.45,
      nodeId: h.node.id,
    })), now, () => randomUUID());
    dirty.push(entry.brain);

    blocks.push([state, composed.text].filter(Boolean).join('\n\n'));
    usedTotal += composed.tokens + stateTokens;
    perCharacter.push({
      characterId: entry.card.id,
      characterName: entry.card.name,
      tokens: composed.tokens + stateTokens,
      recalled: usedHits.length,
      intrusions: usedHits.filter((h) => h.intrusion).length,
      includedIds: composed.includedIds,
    });
  });

  if (!blocks.length) return null;
  return { text: blocks.join('\n\n---\n\n'), tokens: usedTotal, plan, perCharacter, dirty };
}

/**
 * Does this psyche have anything worth telling the model?
 *
 * Deliberately strict: a freshly seeded psyche at baseline says nothing useful,
 * and emitting a block that always fires is how a model learns to skip it.
 */
function hasLivePsyche(brain: BrainState): boolean {
  const p = brain.psyche;
  if (!p) return false;
  const c = p.condition;
  return p.scenes > 0
    || p.load.level > 0.4
    || p.traumas.length > 0
    || c.ptsd.severity > 0.1
    || c.depression.severity > 0.15
    || c.anxiety.severity > 0.2
    || p.body.safety < 0.5
    || p.body.pain > 0.3;
}

/**
 * The "who is in the room" block (§P.8).
 *
 * Intrusions are recomputed *here* rather than reused from the last consolidation
 * pass, because what is surfacing depends on what is being said right now — the
 * whole point of a cue is that it is present-tense. Everything else (body, load,
 * condition, what they will not go near) is standing state.
 */
function composeStateBlock(
  brain: BrainState,
  recentText: string,
  cast: string[],
  now: number,
  /** Node ids actually reaching the prompt this turn — only those can be leaked. */
  recalledIds: string[] = [],
): string {
  const psyche = brain.psyche;
  if (!psyche) return '';

  const last = psyche.lastMoment;
  // With no appraised moment yet, fall back to the standing mood: a character who
  // has not been consolidated still has a body, a load and a condition.
  const affect = last?.affect ?? express(brain.mood, IDLE_REGULATION, psyche.dynamics.granularity);
  const regulation = last?.regulation ?? IDLE_REGULATION;
  const pull = last?.pull ?? actionTendency(brain.mood);

  const intrusions = psyche.condition.ptsd.intrusion > 0.05 && brain.config.intrusionsEnabled
    ? checkIntrusions(psyche, recentText, cast, (id) => brain.nodes[id]?.gist ?? '')
      .filter((c) => c.probability > 0.3)
      .slice(0, 1)
      .map((c) => ({
        nodeId: c.trauma.nodeId,
        text: brain.nodes[c.trauma.nodeId]?.gist ?? '',
        probability: c.probability,
      }))
    : [];

  // Beliefs they are acting on, and what they expect from the people here.
  const beliefs = Object.values(brain.nodes)
    .filter((n) => n.kind === 'schema' && n.status === 'active')
    .sort((a, b) => b.permanentBoost - a.permanentBoost)
    .slice(0, 3)
    .map((n) => n.gist);

  // Expectancy, rupture and transference all show up here — this is the line that
  // makes a character treat a specific person the way their history says to.
  const expectations = cast
    .map((c) => brain.people[resolvePerson(brain, c)] ?? brain.people[c.toLowerCase()])
    .filter((r): r is NonNullable<typeof r> => !!r && r.interactions > 2)
    .slice(0, 3)
    .map((r) => describeBond(r, psyche));

  const identity = readIdentity(brain, now);

  /**
   * Theory of mind, computed against what was actually recalled this turn: only
   * memories about to be used can be leaked, so only those need guarding.
   */
  const others = cast.filter((c) => c.toLowerCase() !== brain.characterName.toLowerCase());
  const tom = psyche.theoryOfMind;
  const tomLines = tom
    ? describeTheoryOfMind(
      tom,
      others,
      guardedTopics(
        tom,
        others,
        recalledIds.map((id) => ({ nodeId: id, gist: brain.nodes[id]?.gist ?? '' })).filter((n) => n.gist),
      ),
    )
    : [];

  // Stance toward whoever is actually in front of them.
  const speaking = others[0] ? brain.people[others[0].toLowerCase()] : undefined;
  const stance = computeStance({
    psyche,
    relation: speaking,
    felt: affect.felt,
    intruded: intrusions.length > 0,
  });

  return composePsycheBlock({
    psyche,
    name: brain.characterName,
    affect,
    regulation,
    pull,
    intrusions,
    beliefs,
    expectations,
    selfConcept: describeSelfConcept(identity.self, brain.characterName),
    lifeStory: identity.arcs.length >= 2 ? describeLifeStory(identity.arcs) : '',
    tomLines,
    stance: stance.line,
    params: DEFAULT_PSYCHE_PARAMS,
  });
}

/**
 * If the director has a live nudge or scene goal and this mind has no
 * active steer, plant one. Replaces only when the director text changed —
 * so a standing goal keeps colouring the scene without resetting the TTL
 * every turn.
 */
function applyDirectorSteer(
  brain: BrainState,
  director: DirectorState | undefined,
  now: number,
): void {
  const text = director?.nudge?.text?.trim() || director?.sceneGoal?.text?.trim() || '';
  if (!text) return;
  const prefer = isIntentionKind(director?.prefer) ? director!.prefer : undefined;
  const existing = brain.steer;
  if (existing && existing.ttl > 0 && existing.text === text && existing.prefer === prefer) return;
  setSteer(brain, {
    text,
    prefer,
    now,
    ttl: ttlFromIntensity(director?.nudge?.intensity),
  });
}

const INTENTION_KINDS = new Set([
  'pursue', 'repair', 'confront', 'conceal', 'withdraw', 'test', 'endure', 'enjoy',
]);

function isIntentionKind(v: unknown): v is IntentionKind {
  return typeof v === 'string' && INTENTION_KINDS.has(v);
}

/** Stand-in for "no regulation attempted", used before the first pass. */
const IDLE_REGULATION = {
  move: 'none' as const,
  level: 'mature' as const,
  relief: 0,
  loadDelta: 0,
  description: 'letting themselves feel it',
  rationale: 'no appraised moment yet',
  alternatives: [],
};

/**
 * Persist retrieval side effects without clobbering concurrent consolidation.
 *
 * The bug this replaces destroyed data. `buildBrainContext` loads a brain at the
 * *start* of a request; generation then streams for tens of seconds, during which
 * the previous turn's background consolidation finishes and writes new memories,
 * a repaired disposition and an advanced psyche. Writing the whole in-memory
 * object back afterwards silently reverted all of it — which is why a character
 * could consolidate seven times and still have `dispositionSource: 'none'`, zero
 * traits and an untouched psyche.
 *
 * Retrieval only ever mutates four things per node (a use timestamp, the use
 * count, suppression and last-retrieved), so we re-read inside the lock and
 * re-apply exactly those. Anything consolidation wrote in the meantime survives.
 */
export async function flushBrains(brains: BrainState[]): Promise<void> {
  for (const stale of brains) {
    await withBrainLock(stale.chatId, stale.characterId, async () => {
      const fresh = await loadBrain(stale.chatId, stale.characterId, stale.characterName);
      mergeGenerationEffects(fresh, stale);
      await saveBrain(fresh);
    }).catch(() => undefined);
  }
}

// ---------- normalisation of model output ----------

/** Appended to the second attempt: name the failure rather than repeating the ask. */
const ENCODER_RETRY_NOTE = [
  'IMPORTANT — your previous response could not be used.',
  'Return a single JSON object whose "events" key is an ARRAY of event objects.',
  'Not a bare array. Not a different key name. Not prose, not markdown fences.',
  'Every event object must have a non-empty "gist" string of at least 8 characters.',
  'If this stretch genuinely contains nothing memorable, return {"events":[]} — but a long, eventful stretch returning nothing is wrong.',
].join('\n');

/** Keys models reach for when they ignore the contract, in order of likelihood. */
const EVENT_KEYS = [
  'events', 'memories', 'memoryEvents', 'appraisedEvents', 'items',
  'results', 'data', 'output', 'encoded', 'event',
];

/** Aliases for `gist` — what the model called the one field that must exist. */
const GIST_KEYS = ['gist', 'summary', 'text', 'memory', 'description', 'content'];

function gistOf(e: Record<string, any>): string {
  for (const key of GIST_KEYS) {
    const v = e[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Does this look like the array of events, whatever it happens to be called? */
function isEventArray(v: unknown): v is Record<string, any>[] {
  if (!Array.isArray(v) || !v.length) return false;
  return v.some(
    (x) => !!x && typeof x === 'object' && !Array.isArray(x)
      && (!!gistOf(x as Record<string, any>) || 'appraisal' in (x as object)),
  );
}

/**
 * Find the events array in whatever the model actually sent.
 *
 * Order: the response *is* the array → the contract key → a known alias → a
 * depth-first hunt for any array of event-shaped objects. The last step is what
 * rescues `{"result":{"memory":{"events":[…]}}}` and friends.
 */
export function extractEvents(parsed: unknown): Record<string, any>[] {
  if (isEventArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];

  const root = parsed as Record<string, any>;
  for (const key of EVENT_KEYS) {
    const v = root[key];
    if (isEventArray(v)) return v;
    // A single event returned bare, not wrapped in an array.
    if (v && typeof v === 'object' && !Array.isArray(v) && gistOf(v)) return [v];
  }

  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): Record<string, any>[] => {
    if (depth > 5 || !node || typeof node !== 'object' || seen.has(node)) return [];
    seen.add(node);
    if (isEventArray(node)) return node as Record<string, any>[];
    for (const v of Object.values(node as Record<string, unknown>)) {
      const found = walk(v, depth + 1);
      if (found.length) return found;
    }
    return [];
  };
  return walk(root, 0);
}

/** Read a top-level key, tolerating one layer of wrapping. */
function pluck(parsed: unknown, key: string): unknown {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const root = parsed as Record<string, any>;
  if (root[key] !== undefined) return root[key];
  for (const v of Object.values(root)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, any>)[key] !== undefined) {
      return (v as Record<string, any>)[key];
    }
  }
  return undefined;
}

function normalizeEvents(raw: unknown, brain: BrainState): AppraisedEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: AppraisedEvent[] = [];
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, any>;
    const gist = gistOf(e);
    if (gist.length < 8) continue;

    const a = (e.appraisal ?? {}) as Record<string, any>;
    const agency = ['self', 'other', 'circumstance'].includes(a.agency) ? a.agency : 'circumstance';

    out.push({
      gist: gist.slice(0, 600),
      verbatim: str(e.verbatim, 400),
      detail: str(e.detail, 400),
      actors: toStrings(e.actors).slice(0, 8),
      place: str(e.place, 80),
      tags: toStrings(e.tags).map((t) => t.toLowerCase()).slice(0, 12),
      appraisal: {
        novelty: clamp01(num(a.novelty, 0.3)),
        pleasantness: clampSigned(num(a.pleasantness, 0)),
        goalRelevance: clamp01(num(a.goalRelevance, 0.3)),
        goalConduciveness: clampSigned(num(a.goalConduciveness, 0)),
        agency,
        intent: clampSigned(num(a.intent, 0)),
        copingPotential: clamp01(num(a.copingPotential, 0.5)),
        norms: clampSigned(num(a.norms, 0)),
        urgency: clamp01(num(a.urgency, 0.2)),
      },
      salience: clamp01(num(e.salience, 0.3)),
      identityRelevant: e.identityRelevant === true,
      updates: toUpdates(e.updates, brain),
      links: toLinks(e.links, brain),
      sourceMessageIds: toStrings(e.sourceMessageIds).slice(0, 24),
      aliases: toAliasGroups(e.aliases),
    });
  }
  return out;
}

const EDGE_KINDS = new Set([
  'caused', 'led_to', 'contradicts', 'reminds_of', 'about_person', 'at_place',
  'during', 'instance_of', 'co_occurred', 'resolved', 'broke_promise', 'kept_promise',
  'derived_from', 'motivated_by', 'supports', 'chose_over',
]);

function toUpdates(raw: unknown, brain: BrainState): AppraisedEvent['updates'] {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((u): u is Record<string, any> => !!u && typeof u === 'object')
    .filter((u) => typeof u.nodeId === 'string' && brain.nodes[u.nodeId])
    .map((u) => ({
      nodeId: String(u.nodeId),
      kind: u.kind === 'contradicts' ? ('contradicts' as const) : ('extends' as const),
      newGist: str(u.newGist, 600),
    }))
    .slice(0, 6);
  return out.length ? out : undefined;
}

function toLinks(raw: unknown, brain: BrainState): AppraisedEvent['links'] {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((l): l is Record<string, any> => !!l && typeof l === 'object')
    .filter((l) => typeof l.nodeId === 'string' && brain.nodes[l.nodeId] && EDGE_KINDS.has(l.kind))
    .map((l) => ({ nodeId: String(l.nodeId), kind: l.kind }))
    .slice(0, 8);
  return out.length ? out : undefined;
}

function toAliasGroups(raw: unknown): AppraisedEvent['aliases'] {
  if (!Array.isArray(raw)) return undefined;
  const out: { canonical: string; also: string[] }[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const g = item as Record<string, any>;
    const canonical = String(g.canonical ?? g.name ?? '').trim();
    const also = toStrings(g.also ?? g.aliases ?? g.aka).slice(0, 6);
    if (!canonical || !also.length) continue;
    out.push({ canonical, also });
  }
  return out.length ? out : undefined;
}

function applyGoalUpdates(brain: BrainState, raw: unknown, now: number): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const g = item as Record<string, any>;
    const text = String(g.text ?? '').trim();
    if (!text) continue;
    const status = ['active', 'achieved', 'abandoned', 'blocked'].includes(g.status) ? g.status : 'active';
    const existing = brain.workingSelf.goals.find(
      (x) => x.text.toLowerCase() === text.toLowerCase(),
    );
    if (existing) {
      existing.status = status;
      existing.priority = clamp01(num(g.priority, existing.priority));
      existing.updatedAt = now;
    } else {
      brain.workingSelf.goals.push({
        id: randomUUID(),
        text: text.slice(0, 200),
        priority: clamp01(num(g.priority, 0.5)),
        status,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  // Keep the working self small — it is *working* memory, not an archive.
  brain.workingSelf.goals = brain.workingSelf.goals
    .sort((a, b) => rankGoal(b) - rankGoal(a))
    .slice(0, 12);
}

function rankGoal(g: Goal): number {
  return (g.status === 'active' ? 10 : 0) + g.priority + g.updatedAt / 1e13;
}

function ensureChapter(brain: BrainState, title: string, chatId: string, now: number): string {
  const existing = brain.chapters.find((c) => c.title.toLowerCase() === title.toLowerCase());
  if (existing) {
    if (!existing.chatIds.includes(chatId)) existing.chatIds.push(chatId);
    return existing.id;
  }
  // Close the previous chapter — a new title means the story moved on.
  const open = brain.chapters.find((c) => !c.endedAt);
  if (open) open.endedAt = now;
  const chapter = {
    id: randomUUID(),
    title: title.slice(0, 120),
    theme: '',
    startedAt: now,
    tone: { ...brain.mood },
    chatIds: [chatId],
  };
  brain.chapters.push(chapter);
  return chapter.id;
}

function currentChapterId(brain: BrainState): string | undefined {
  return brain.chapters.find((c) => !c.endedAt)?.id;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function toStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? '').trim()).filter(Boolean);
}

function toGoals(raw: unknown): Goal[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw
    .slice(0, 6)
    .filter((g): g is Record<string, any> => !!g && typeof g === 'object' && !!String(g.text ?? '').trim())
    .map((g) => ({
      id: randomUUID(),
      text: String(g.text).trim().slice(0, 200),
      priority: clamp01(num(g.priority, 0.5)),
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    }));
}
