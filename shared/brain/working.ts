/**
 * Working memory — the within-scene buffer (§B.2 #5).
 *
 * Durable nodes are what survive the night. Working memory is what the
 * character is holding *right now*: the last few beats of the scene, whether
 * or not they were memorable enough to encode. Without it, within-scene
 * continuity rests entirely on the transcript the model can already see, and
 * the brain has nothing to say about "what they just heard".
 *
 * Cerememory's working store is the shape: volatile, tiny, high decay. Cowan's
 * 4±1 is the capacity. Items are *slots*, not nodes — they do not enter the
 * associative graph, they do not get reconstructed, and they evaporate when
 * the scene moves on. A slot may point at an encoded node when the two
 * coincide, but it does not have to.
 *
 * Pure. Time is passed in.
 */
import { similarity } from './activation';
import { TIME_UNIT_MS } from './defaults';
import type { AppraisedEvent, BrainState, WorkingSlot } from './types';

/** Cowan's 4±1 — the number of items a person can actually hold. */
export const WORKING_CAPACITY = 4;

/**
 * How long a slot lives if nothing refreshes it.
 *
 * Two hours of real time is a long scene and a short absence. A slot that
 * survives a night would be a memory, and we already have those.
 */
export const WORKING_TTL_MS = 2 * 60 * 60 * 1000;

export function ensureWorking(brain: BrainState): WorkingSlot[] {
  if (!brain.working) brain.working = [];
  return brain.working;
}

/**
 * Hold something in mind.
 *
 * A near-duplicate (same gist, same people) refreshes the existing slot
 * rather than taking a second seat — working memory is not a log.
 */
export function holdInMind(
  brain: BrainState,
  slot: Omit<WorkingSlot, 'id'> & { id?: string },
  makeId: () => string,
): WorkingSlot {
  const buf = ensureWorking(brain);
  const gist = slot.gist.trim();
  if (!gist) {
    return buf[0] ?? { id: makeId(), gist: '', actors: [], heldAt: slot.heldAt, salience: 0 };
  }

  const existing = buf.find(
    (s) => similarity(s.gist, gist) >= 0.72
      || (slot.nodeId && s.nodeId === slot.nodeId),
  );
  if (existing) {
    existing.gist = gist;
    existing.actors = slot.actors;
    existing.heldAt = slot.heldAt;
    existing.salience = Math.max(existing.salience, slot.salience);
    if (slot.nodeId) existing.nodeId = slot.nodeId;
    return existing;
  }

  const next: WorkingSlot = {
    id: slot.id ?? makeId(),
    gist,
    actors: slot.actors,
    heldAt: slot.heldAt,
    salience: slot.salience,
    nodeId: slot.nodeId,
  };
  buf.push(next);
  evictWorking(brain, slot.heldAt);
  return next;
}

/** Push every newly encoded event into the buffer. */
export function holdEvents(
  brain: BrainState,
  events: { gist: string; actors: string[]; salience: number; nodeId?: string }[],
  now: number,
  makeId: () => string,
): void {
  for (const event of events) {
    holdInMind(brain, {
      gist: event.gist,
      actors: event.actors,
      heldAt: now,
      salience: event.salience,
      nodeId: event.nodeId,
    }, makeId);
  }
}

/** Hold the last few transcript beats that have not been encoded yet. */
export function holdRecentTurns(
  brain: BrainState,
  turns: { speaker: string; text: string }[],
  now: number,
  makeId: () => string,
): void {
  const recent = turns.slice(-WORKING_CAPACITY);
  for (const turn of recent) {
    const gist = `${turn.speaker}: ${turn.text.replace(/\s+/g, ' ').trim()}`.slice(0, 220);
    if (gist.length < 12) continue;
    holdInMind(brain, {
      gist,
      actors: [turn.speaker],
      heldAt: now,
      salience: 0.2,
    }, makeId);
  }
}

/**
 * Drop what has gone cold, then what there is no room for.
 *
 * Expired first (they are no longer in mind), then the lowest-salience
 * oldest slot. Doing nothing when the buffer is already small is the common
 * and correct outcome.
 */
export function evictWorking(brain: BrainState, now: number): WorkingSlot[] {
  const buf = ensureWorking(brain);
  const kept = buf.filter((s) => now - s.heldAt <= WORKING_TTL_MS && (now - s.heldAt) < TIME_UNIT_MS);
  kept.sort((a, b) => {
    if (b.salience !== a.salience) return b.salience - a.salience;
    return b.heldAt - a.heldAt;
  });
  brain.working = kept.slice(0, WORKING_CAPACITY);
  return brain.working;
}

/** Slots still alive at `now`, strongest first. */
export function liveWorking(brain: BrainState, now: number): WorkingSlot[] {
  evictWorking(brain, now);
  return brain.working ?? [];
}

/** Prompt line. Empty when they are holding nothing. */
export function describeWorking(brain: BrainState, name: string, now: number): string {
  const slots = liveWorking(brain, now);
  if (!slots.length) return '';
  const lines = slots.map((s) => `- ${s.gist}`);
  return `**Just now, still holding** (this is what ${name} has in mind from the last few beats — not yet a memory, just the scene):\n${lines.join('\n')}`;
}

/** Cheap events → hold payloads. */
export function slotsFromEvents(events: AppraisedEvent[], now: number): Omit<WorkingSlot, 'id'>[] {
  return events.map((e) => ({
    gist: e.gist,
    actors: e.actors,
    heldAt: now,
    salience: e.salience,
  }));
}
