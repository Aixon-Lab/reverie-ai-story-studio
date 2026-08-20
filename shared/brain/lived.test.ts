/**
 * Lived-behaviour walk of a scene through the full local engine.
 *
 * Units prove the equations. This file proves the *character*: that a stretch
 * of dialogue, left to encode, recall, idle and want, produces the specific
 * ways a person differs from a ranked-recall bot — priming then habituation,
 * a mind that runs between turns, an objective that forms, a name that stays
 * one person, a belief that can collapse, a stretch that is too quiet to
 * spend a model call on.
 *
 * No I/O, no model. The transcript is the one we cannot run against `data/`.
 */
import { describe, expect, it } from 'vitest';
import { TIME_UNIT_MS, emptyBrain } from './defaults';
import { encodeEvent } from './encoding';
import { consolidate } from './consolidation';
import { cueFromContext, recall, applyRetrievalEffects } from './retrieval';
import { heuristicEncode } from './heuristics';
import { mentate } from './mentation';
import { formIntention, setSteer } from './volition';
import { gateChunk } from './admission';
import { liveWorking } from './working';
import { registerAlias, resolvePerson } from './entities';
import { recomputeWarrants } from './warrant';
import { mergeGenerationEffects } from './persist';
import { emptyPsyche } from '../psyche/defaults';
import type { BrainState } from './types';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const DAY = TIME_UNIT_MS;
let n = 0;
const makeId = () => `live-${++n}`;

function wren(now = T0): BrainState {
  const b = emptyBrain('dock', 'wren', 'Scarlet Wren', now);
  b.psyche = emptyPsyche(b.traits, now);
  b.psyche.scenes = 4;
  return b;
}

const TRANSCRIPT = [
  { id: 'm1', speaker: 'Rooke', text: 'Miss Vale. You came.', isUser: true },
  { id: 'm2', speaker: 'Scarlet Wren', text: 'Wren is fine. You said you had the ledger.', isUser: false },
  { id: 'm3', speaker: 'Rooke', text: 'I lied. I burned it. I was never going to give it to you.', isUser: true },
  { id: 'm4', speaker: 'Scarlet Wren', text: 'You promised me. You stood here and you promised.', isUser: false },
  { id: 'm5', speaker: 'Rooke', text: 'And I would do it again. You were never going to let this go.', isUser: true },
];

const SMALL_TALK = [
  { id: 's1', speaker: 'Rooke', text: 'Anyway I should get back to the office I guess, nothing much going on.', isUser: true },
  { id: 's2', speaker: 'Scarlet Wren', text: 'Sure, see you around then, maybe later this week if you are free.', isUser: false },
];

/**
 * A long stretch the cheap scorer *did* read: it recognises words in every
 * segment and judges all of them flat. This is the only shape the gate is now
 * allowed to discard unread — see `admission.ts`.
 */
const QUIET_ERRANDS = [
  { id: 'q1', speaker: 'Rooke', text: 'She stood by the counter while the clerk counted out the change.', isUser: true },
  { id: 'q2', speaker: 'Scarlet Wren', text: 'I stood where the awning held the drizzle off my shoulders and waited.', isUser: false },
  { id: 'q3', speaker: 'Rooke', text: 'Then the door opened and he stood aside to let the delivery through.', isUser: true },
  { id: 'q4', speaker: 'Scarlet Wren', text: 'I stood the crate upright against the wall and dusted my palms.', isUser: false },
  { id: 'q5', speaker: 'Rooke', text: 'Outside she stood reading the notice board without much interest.', isUser: true },
  { id: 'q6', speaker: 'Scarlet Wren', text: 'I stood there long enough to memorise the timetable, then moved on.', isUser: false },
  { id: 'q7', speaker: 'Rooke', text: 'Morning traffic stood still on the bridge as usual.', isUser: true },
  { id: 'q8', speaker: 'Scarlet Wren', text: 'I stood in the queue and let the minutes go by unremarked.', isUser: false },
];

describe('lived scene — a betrayal at the docks', () => {
  it('encodes the betrayal, not the small talk', () => {
    const scene = heuristicEncode(TRANSCRIPT, 'Scarlet Wren');
    const errands = heuristicEncode(QUIET_ERRANDS, 'Scarlet Wren');
    expect(gateChunk(errands).action).toBe('drop');
    expect(gateChunk(scene).action).not.toBe('drop');

    /**
     * Two turns the lexicon recognised nothing in are *not* droppable, however
     * dull they look. A silent lexicon means no evidence either way, and the
     * cadence hands the gate stretches this small every few messages — dropping
     * them on a floor score is what stopped memory forming a few dozen messages
     * into every conversation.
     */
    expect(gateChunk(heuristicEncode(SMALL_TALK, 'Scarlet Wren')).action).toBe('escalate');

    const b = wren();
    const report = consolidate(b, {
      events: scene,
      now: T0,
      makeId,
      cast: ['Scarlet Wren', 'Rooke'],
      maintenance: true,
    });
    expect(report.encoded.length).toBeGreaterThan(0);
    const gists = Object.values(b.nodes).map((n) => n.gist.toLowerCase()).join(' ');
    expect(gists).toMatch(/lied|burned|promised|ledger/);
  });

  /**
   * The regression that stopped memory forming a few dozen messages in.
   *
   * A scene can be devastating and still use none of the lexicon's ~120 trigger
   * words. Scored at the 0.05 floor and handed to a gate that could drop a whole
   * chunk, every ordinary six-message pass was discarded before the encoder ever
   * saw it — while the *first* pass, which reads the entire backlog at once, had
   * enough segments that one of them nearly always tripped a trigger word. That
   * asymmetry is what produced "it made memories at first and then stopped".
   */
  it('does not discard a heavy scene written without any trigger words', () => {
    const SUBTLE = [
      { id: 'p1', speaker: 'Rooke', text: 'I ask her what happened in the cellar that winter.', isUser: true },
      { id: 'p2', speaker: 'Scarlet Wren', text: 'My hands go still on the cup. I do not answer for a long moment. You should not have asked me that.', isUser: false },
      { id: 'p3', speaker: 'Rooke', text: 'I wait. I let the silence do the work.', isUser: true },
      { id: 'p4', speaker: 'Scarlet Wren', text: 'Three of us went down there. Two came back up. I have never once said which one I was.', isUser: false },
      { id: 'p5', speaker: 'Rooke', text: 'I reach across the table for her hand.', isUser: true },
      { id: 'p6', speaker: 'Scarlet Wren', text: 'I pull away before she can reach me. Not unkindly, but absolutely. Not tonight.', isUser: false },
    ];
    const events = heuristicEncode(SUBTLE, 'Scarlet Wren');
    // The lexicon genuinely has nothing to say about this — which is the point.
    expect(events.every((e) => (e.lexiconHits ?? 0) === 0)).toBe(true);
    expect(gateChunk(events).action).toBe('escalate');
  });

  /**
   * The offline encoder has to keep the brain growing when the utility model is
   * unreachable — that is its entire reason to exist. It could not: with no
   * trigger word anywhere in the stretch, every affect term was zero and the
   * score was a constant 0.05, under `encodeThreshold`, so a model outage during
   * a quietly-written scene encoded nothing at all and said nothing about it.
   */
  it('encodes substantial prose offline, with no model and no trigger words', () => {
    const SUBSTANTIAL = [
      { id: 'o1', speaker: 'Rooke', text: 'I tell her the ledger names her brother.', isUser: true },
      { id: 'o2', speaker: 'Scarlet Wren', text: 'The page trembles once before I steady it. Then the ledger is wrong, or my brother is not the man I buried.', isUser: false },
      { id: 'o3', speaker: 'Rooke', text: 'I say nothing. She reads it again.', isUser: true },
      { id: 'o4', speaker: 'Scarlet Wren', text: 'Whoever signed this knew where we slept. That is the part you should be frightened of.', isUser: false },
    ];
    const CHATTER = [
      { id: 'o5', speaker: 'Rooke', text: 'Anyway I should get back to the office I guess, nothing much going on.', isUser: true },
      { id: 'o6', speaker: 'Scarlet Wren', text: 'Sure, see you around then, maybe later this week if you are free.', isUser: false },
    ];

    const events = heuristicEncode(SUBSTANTIAL, 'Scarlet Wren');
    expect(events.every((e) => (e.lexiconHits ?? 0) === 0)).toBe(true);

    const b = wren();
    const report = consolidate(b, {
      events, now: T0, makeId, cast: ['Scarlet Wren', 'Rooke'], maintenance: true,
    });
    expect(report.encoded.length).toBeGreaterThan(0);
    expect(Object.values(b.nodes).map((n) => n.gist).join(' ')).toMatch(/ledger|brother|signed/);

    // Substance is not a licence to encode everything: thin chatter still is not
    // a memory, which is the property that keeps the fallback from filling a
    // brain with small talk the moment the network hiccups.
    const quiet = wren();
    const quietReport = consolidate(quiet, {
      events: heuristicEncode(CHATTER, 'Scarlet Wren'),
      now: T0,
      makeId,
      cast: ['Scarlet Wren', 'Rooke'],
      maintenance: true,
    });
    expect(quietReport.encoded).toHaveLength(0);
    expect(quietReport.skipped).toBeGreaterThan(0);
  });

  it('primes a just-recalled memory, then wears it out if flogged', () => {
    const b = wren();
    consolidate(b, { events: heuristicEncode(TRANSCRIPT, 'Scarlet Wren'), now: T0, makeId, cast: ['Rooke'] });
    const cue = cueFromContext({
      recentText: 'the ledger, the promise',
      actors: ['Rooke'],
      brain: b,
      now: T0 + MIN,
    });
    const first = recall(b, cue, { limit: 6, mutate: true, rng: () => 0.5 });
    expect(first.hits.length).toBeGreaterThan(0);
    const id = first.hits[0].node.id;
    const warm = recall(b, cue, { limit: 6, mutate: false, rng: () => 0.5 });
    const warmHit = warm.hits.find((h) => h.node.id === id);
    expect(warmHit).toBeTruthy();

    for (let i = 0; i < 6; i++) {
      applyRetrievalEffects(b, [first.hits[0]], [], T0 + (i + 2) * 4 * MIN, undefined, () => 0.5);
    }
    const tired = recall(b, { ...cue, now: T0 + 30 * MIN }, { limit: 8, mutate: false, rng: () => 0.5 });
    const tiredHit = tired.hits.find((h) => h.node.id === id);
    if (warmHit && tiredHit) {
      expect(tiredHit.breakdown.availability).toBeLessThan(warmHit.breakdown.availability);
    }
  });

  it('keeps running between turns', () => {
    const b = wren();
    consolidate(b, { events: heuristicEncode(TRANSCRIPT, 'Scarlet Wren'), now: T0, makeId, cast: ['Rooke'] });
    // Mentation refuses a nearly-empty head. Seed a couple of extra traces
    // so there is something to wander through.
    encodeEvent(b, {
      gist: 'the docks always smell of wet iron after rain',
      actors: [], tags: ['docks'],
      appraisal: { novelty: 0.3, pleasantness: -0.2, goalRelevance: 0.2, goalConduciveness: 0, agency: 'circumstance', intent: 0, copingPotential: 0.6, norms: 0, urgency: 0.1 },
      salience: 0.5,
    }, { now: T0 - DAY, makeId });
    encodeEvent(b, {
      gist: 'she used to trust him with the keys to the greenhouse',
      actors: ['Rooke'], tags: ['trust'],
      appraisal: { novelty: 0.2, pleasantness: 0.3, goalRelevance: 0.5, goalConduciveness: 0.2, agency: 'other', intent: 0.4, copingPotential: 0.7, norms: 0.2, urgency: 0.1 },
      salience: 0.6,
    }, { now: T0 - 2 * DAY, makeId });
    const report = mentate(b, { now: T0 + 20 * MIN, makeId, rng: () => 0.3, force: true });
    expect(report.quiet).toBe(false);
    expect(b.stats.lastMentationAt ?? report.at).toBeTruthy();
  });

  it('forms an objective, and steering only biases it', () => {
    const b = wren();
    consolidate(b, { events: heuristicEncode(TRANSCRIPT, 'Scarlet Wren'), now: T0, makeId, cast: ['Rooke'] });
    // Give the relationship some teeth so confront/repair have something to score.
    const rel = b.people['rooke'];
    if (rel) {
      rel.resentment = 0.7;
      rel.affection = 0.4;
      rel.trust = -0.5;
    }
    setSteer(b, { text: 'get him to admit he burned it', prefer: 'confront', now: T0, ttl: 8 });
    const intention = formIntention(b, { present: ['Rooke'], now: T0, makeId });
    expect(intention.status).toBe('active');
    expect(intention.ttl).toBeGreaterThan(0);
    // Steering made confront cheaper, but only if she can hold it.
    expect(['confront', 'repair', 'pursue', 'endure', 'withdraw', 'test', 'conceal', 'enjoy']).toContain(intention.kind);
  });

  it('treats Wren and Miss Vale as one person', () => {
    const b = wren();
    registerAlias(b, 'Miss Vale', 'Wren');
    expect(resolvePerson(b, 'Miss Vale')).toBe(resolvePerson(b, 'Wren'));
    consolidate(b, {
      events: heuristicEncode(TRANSCRIPT, 'Scarlet Wren').map((e) => ({
        ...e,
        aliases: [{ canonical: 'Wren', also: ['Miss Vale'] }],
      })),
      now: T0,
      makeId,
      cast: ['Scarlet Wren', 'Rooke'],
    });
    const keys = Object.keys(b.people).filter((k) => k !== 'rooke');
    // At most one record for Wren / Miss Vale.
    const ivyKeys = keys.filter((k) => /wren|vale/.test(k));
    expect(ivyKeys.length).toBeLessThanOrEqual(1);
  });

  it('holds the last beats in working memory', () => {
    const b = wren();
    consolidate(b, { events: heuristicEncode(TRANSCRIPT, 'Scarlet Wren'), now: T0, makeId, cast: ['Rooke'] });
    expect(liveWorking(b, T0).length).toBeGreaterThan(0);
    expect(liveWorking(b, T0).length).toBeLessThanOrEqual(4);
  });

  it('lets a belief collapse when the evidence is gone', () => {
    const b = wren();
    consolidate(b, { events: heuristicEncode(TRANSCRIPT, 'Scarlet Wren'), now: T0, makeId, cast: ['Rooke'] });
    // Force a schema with a warrant, then delete its evidence.
    const episodes = Object.values(b.nodes).filter((n) => n.kind === 'episodic');
    if (episodes.length) {
      const schema = {
        ...episodes[0],
        id: makeId(),
        kind: 'schema' as const,
        gist: 'Rooke cannot be relied on the way I once assumed — this keeps turning out to be true.',
        confidence: 0.9,
        warrant: { rationale: 'he keeps lying', evidence: episodes.map((e) => e.id), support: 1 },
      };
      b.nodes[schema.id] = schema;
      for (const e of episodes) delete b.nodes[e.id];
      const r = recomputeWarrants(b);
      expect(r.collapsed).toContain(schema.id);
    }
  });

  it('does not lose intention or synapse when a generation is flushed onto a newer brain', () => {
    const stale = wren();
    consolidate(stale, { events: heuristicEncode(TRANSCRIPT, 'Scarlet Wren'), now: T0, makeId, cast: ['Rooke'] });
    const node = Object.values(stale.nodes)[0];
    applyRetrievalEffects(stale, [{
      node,
      activation: 1,
      probability: 1,
      breakdown: {
        base: 1, spreading: 0, partialMatch: 0, boost: 0,
        suppression: 0, moodCongruence: 0, noise: 0, availability: 0.2, total: 1,
      },
      intrusion: false,
    }], [], T0 + MIN);
    const formed = formIntention(stale, { present: ['Rooke'], now: T0 + MIN, makeId });
    stale.intention = formed;
    setSteer(stale, { text: 'make him say it', prefer: 'confront', now: T0 + MIN, ttl: 6 });

    const fresh = wren(T0);
    // Simulate consolidation that landed while generation ran: copy nodes
    // but not the retrieval/volition writes.
    fresh.nodes = structuredClone(stale.nodes);
    for (const n of Object.values(fresh.nodes)) {
      n.useCount = 1;
      n.synapse = undefined;
      n.distortions = undefined;
    }
    mergeGenerationEffects(fresh, stale);
    expect(fresh.intention?.text).toBe(formed.text);
    expect(fresh.steer?.text).toBe('make him say it');
    const flushed = fresh.nodes[node.id];
    expect(flushed.useCount).toBeGreaterThan(1);
    expect(flushed.synapse).toBeTruthy();
  });
});
