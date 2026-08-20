/**
 * The maintenance tail, and who it belongs to.
 *
 * Decay, drift and mood regression model *time passing*. They used to run once
 * per `consolidate()` call, which was the same thing right up until a long
 * history started being read one chunk at a time — at which point a single
 * "Re-read all" aged a character by twenty rounds of forgetting in three
 * seconds and wiped their mood on the way through.
 *
 * These pin the separation: events always count, the clock only counts once.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { consolidate, isSelf, MAINTENANCE_MIN_GAP_MS } from './consolidation';
import { emptyBrain } from './defaults';
import { estimateBrainTokens } from './budget';
import type { AppraisedEvent, BrainState } from './types';

function brainWith(name = 'Wren Ashby'): BrainState {
  return emptyBrain('chat-1', 'char-1', name);
}

function event(gist: string, over: Partial<AppraisedEvent> = {}): AppraisedEvent {
  return {
    gist,
    actors: [],
    tags: [],
    appraisal: {
      novelty: 0.6, pleasantness: -0.5, goalRelevance: 0.7, goalConduciveness: -0.6,
      agency: 'other', intent: 0.5, copingPotential: 0.4, norms: -0.4, urgency: 0.5,
    },
    salience: 0.8,
    identityRelevant: false,
    ...over,
  };
}

function run(
  brain: BrainState,
  events: AppraisedEvent[],
  now: number,
  opts: { maintenance?: boolean; cast?: string[] } = {},
) {
  return consolidate(brain, { events, now, makeId: () => randomUUID(), ...opts });
}

describe('maintenance runs on the clock, not on the call', () => {
  it('does not re-age memories when a long history is read as many chunks', () => {
    const brain = brainWith();
    const t0 = 1_000_000;
    run(brain, [event('Rooke shut the greenhouse door and left her inside')], t0);
    const nodeId = Object.keys(brain.nodes)[0];
    const afterFirst = brain.nodes[nodeId].fidelity;

    // Twenty chunks of a re-read, seconds apart — one moment of elapsed time.
    for (let i = 1; i <= 20; i++) {
      run(brain, [event(`a further beat number ${i} in the same scene`)], t0 + i * 100);
    }

    expect(brain.nodes[nodeId].fidelity).toBe(afterFirst);
  });

  it('still ages them once the clock has genuinely moved', () => {
    const brain = brainWith();
    const t0 = 1_000_000;
    run(brain, [event('Rooke shut the greenhouse door and left her inside')], t0);
    const nodeId = Object.keys(brain.nodes)[0];
    const afterFirst = brain.nodes[nodeId].fidelity;

    run(brain, [], t0 + MAINTENANCE_MIN_GAP_MS + 1);
    expect(brain.nodes[nodeId].fidelity).toBeLessThan(afterFirst);
  });

  it('does not erase the mood across a burst of eventless passes', () => {
    const brain = brainWith();
    const t0 = 1_000_000;
    run(brain, [event('He hurt her badly and meant every second of it')], t0);
    const moved = { ...brain.mood };

    // The encoder returning nothing usable, repeatedly, must not regress the
    // mood to baseline once per failure.
    for (let i = 1; i <= 15; i++) run(brain, [], t0 + i * 200);

    expect(brain.mood.valence).toBeCloseTo(moved.valence, 10);
    expect(brain.mood.arousal).toBeCloseTo(moved.arousal, 10);
  });

  it('leaves edges alone across a burst, and decays them once time passes', () => {
    const brain = brainWith();
    const t0 = 1_000_000;
    // Same people in the same place, which is what `autoLink` binds on.
    run(brain, [
      event('Rooke locked the greenhouse door behind him', {
        actors: ['Rooke', 'Nadia'], place: 'the greenhouse',
      }),
      event('She counted the panes of glass until the light went', {
        actors: ['Rooke', 'Nadia'], place: 'the greenhouse',
      }),
    ], t0);
    const weights = () => brain.edges.map((e) => e.weight);
    const before = weights();
    expect(before.length).toBeGreaterThan(0);

    for (let i = 1; i <= 10; i++) run(brain, [], t0 + i * 100);
    expect(weights()).toEqual(before);

    run(brain, [], t0 + MAINTENANCE_MIN_GAP_MS + 1);
    expect(weights().every((w, i) => w < before[i])).toBe(true);
  });

  it('records when the clock last moved, so a restart cannot re-run the tail', () => {
    const brain = brainWith();
    run(brain, [event('Something worth keeping happened in the dark')], 1_000_000);
    expect(brain.stats.lastMaintenanceAt).toBe(1_000_000);
  });
});

describe('a repeated event is still an event', () => {
  it('moves the relationship every time, not only the first', () => {
    const brain = brainWith();
    const gist = 'Rooke promised to come back for her and did not';
    const t0 = 1_000_000;
    // A deliberate injury: `intent` negative is what moves trust.
    const betrayal = () => event(gist, {
      actors: ['Rooke'],
      appraisal: { ...event('x').appraisal, intent: -0.7, goalConduciveness: -0.7 },
    });

    run(brain, [betrayal()], t0);
    const first = brain.people.rooke;
    expect(first).toBeTruthy();
    const trustAfterFirst = first.trust;
    const interactionsAfterFirst = first.interactions;
    expect(trustAfterFirst).toBeLessThan(0);

    // The same event again: an echo, not a new memory — but it still happened.
    run(brain, [betrayal()], t0 + 1000);
    expect(brain.people.rooke.interactions).toBeGreaterThan(interactionsAfterFirst);
    expect(brain.people.rooke.trust).toBeLessThan(trustAfterFirst);
  });
});

describe('a part of my name is not necessarily me', () => {
  it('treats a shortened self-name as the character', () => {
    const brain = brainWith('Scarlet Wren');
    expect(isSelf(brain, 'Wren')).toBe(true);
    expect(isSelf(brain, 'Scarlet Wren')).toBe(true);
  });

  it('yields the name to a cast member who actually answers to it', () => {
    const brain = brainWith('Scarlet Wren');
    expect(isSelf(brain, 'Wren', ['Scarlet Wren', 'Wren', 'Rooke'])).toBe(false);
    expect(isSelf(brain, 'Scarlet Wren', ['Scarlet Wren', 'Wren'])).toBe(true);
  });

  it('keeps that person’s relationship instead of filing it as self-regard', () => {
    const brain = brainWith('Scarlet Wren');
    run(brain, [event('Wren handed her the shears without being asked', {
      actors: ['Wren'],
      appraisal: { ...event('x').appraisal, pleasantness: 0.6, goalConduciveness: 0.5 },
    })], 1_000_000, { cast: ['Scarlet Wren', 'Wren'] });
    expect(Object.keys(brain.people)).toContain('wren');
  });

  it('still retires a genuine self-entry once the cast is known', () => {
    const brain = brainWith('Scarlet Wren');
    brain.people.wren = {
      key: 'wren', displayName: 'Wren', trust: 0.2, affection: 0, fear: 0, respect: 0,
      resentment: 0, debt: 0, familiarity: 0.4, model: '', interactions: 3,
      firstMetAt: 1, lastSeenAt: 2,
    };
    run(brain, [], 1_000_000);
    expect(Object.keys(brain.people)).not.toContain('wren');
  });
});

describe('the active footprint cap actually reaches the cap', () => {
  it('gets under a tight cap instead of demoting everything and giving up', () => {
    const brain = brainWith();
    const t0 = 1_000_000;
    for (let i = 0; i < 12; i++) {
      run(brain, [event(
        `A long and quotable exchange number ${i} that goes on at some length`,
        { verbatim: 'x'.repeat(400) },
      )], t0 + i * (MAINTENANCE_MIN_GAP_MS + 1));
    }
    const cap = 200;
    consolidate(brain, {
      events: [], now: t0 + 10_000_000, makeId: () => randomUUID(),
      activeTokenCap: cap, countTokens: estimateBrainTokens,
    });

    const footprint = Object.values(brain.nodes)
      .filter((n) => n.status === 'active')
      .reduce((s, n) => s + estimateBrainTokens(`${n.gist} ${n.verbatim ?? ''}`) + 6, 0);

    // Pins, identity, trauma and schemas are exempt, so the cap is a target and
    // not a guarantee — but the episodic bulk must be gone.
    expect(footprint).toBeLessThan(cap * 3);
  });
});
