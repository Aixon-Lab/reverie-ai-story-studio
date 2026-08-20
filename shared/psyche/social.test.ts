/**
 * Theory of mind and stance (§N.2.1, §N.2.3).
 *
 * These are the two changes aimed squarely at the seam. Every test below pins a
 * failure a reader would actually notice: a character revealing what the other
 * person was never told, or being agreeable to someone they have every reason
 * not to be agreeable to.
 */
import { describe, expect, it } from 'vitest';
import { neutralTraits } from '../brain/defaults';
import { emptyPsyche, DEFAULT_PSYCHE_PARAMS as P } from './defaults';
import {
  describeTheoryOfMind, doesKnow, emptyTheoryOfMind, guardedTopics,
  recordDeception, recordTold, recordWithheld, recordWitnessed,
} from './theoryOfMind';
import { computeStance, stanceValence, wouldRefuse } from './stance';
import type { Affect, RelationModel } from '../brain/types';
import type { PsycheState } from './types';

const NOW = 1_700_000_000_000;

function rel(over: Partial<RelationModel> = {}): RelationModel {
  return {
    key: 'rooke', displayName: 'Rooke', trust: 0.4, affection: 0.3, fear: 0,
    respect: 0.2, resentment: 0, debt: 0, familiarity: 0.6, model: '',
    interactions: 10, firstMetAt: NOW, lastSeenAt: NOW, ...over,
  };
}

const calm: Affect = { valence: 0, arousal: 0.2, dominance: 0, label: 'neutral' };
const furious: Affect = { valence: -0.8, arousal: 0.85, dominance: 0.5, label: 'anger' };

// ------------------------------------------------------------- theory of mind

describe('a character knows who was there (§N.2.1)', () => {
  it('records presence as near-certain knowledge, and absence as nothing', () => {
    let tom = emptyTheoryOfMind();
    tom = recordWitnessed(tom, {
      nodeId: 'n1',
      gist: 'Rooke held up the vial and said who he worked for',
      present: ['Rooke'],
      cast: ['Rooke', 'Tessa'],
      now: NOW,
    });

    expect(doesKnow(tom, 'Rooke', { nodeId: 'n1' })).toMatchObject({ knows: true, source: 'witnessed' });
    // Tessa was in the cast but not in the event. That silence is the point.
    expect(doesKnow(tom, 'Tessa', { nodeId: 'n1' }).knows).toBe(false);
  });

  it('matches a fact told in different words', () => {
    let tom = emptyTheoryOfMind();
    tom = recordTold(tom, 'Tessa', {
      nodeId: 'n1', gist: 'Rooke works for Kessler', at: NOW,
    }, NOW);
    const verdict = doesKnow(tom, 'Tessa', { gist: 'Rooke is Kessler\'s man' });
    expect(verdict.knows).toBe(true);
  });

  it('distinguishes "never came up" from "deliberately kept from them"', () => {
    let tom = emptyTheoryOfMind();
    tom = recordWithheld(tom, 'Tessa', {
      nodeId: 'n2', gist: 'She made a deal with Kessler to get out', at: NOW,
    }, NOW);
    const hidden = doesKnow(tom, 'Tessa', { gist: 'She made a deal with Kessler to get out' });
    expect(hidden.knows).toBe(false);
    expect(hidden.source).toBe('withheld');
    expect(hidden.certainty).toBeGreaterThan(0.85);
  });

  it('THE FAILURE THIS PREVENTS: flags what would be a revelation, not a reference', () => {
    let tom = emptyTheoryOfMind();
    tom = recordWitnessed(tom, {
      nodeId: 'shared', gist: 'The ruins collapsed', present: ['Tessa'], cast: ['Tessa'], now: NOW,
    });
    const guarded = guardedTopics(tom, ['Tessa'], [
      { nodeId: 'shared', gist: 'The ruins collapsed' },
      { nodeId: 'secret', gist: 'Rooke works for Kessler' },
    ]);
    expect(guarded).toHaveLength(1);
    expect(guarded[0].gist).toMatch(/Kessler/);
    expect(guarded[0].hiddenFrom).toEqual(['Tessa']);
  });

  it('says nothing when everything recalled is shared', () => {
    let tom = emptyTheoryOfMind();
    tom = recordWitnessed(tom, {
      nodeId: 'a', gist: 'They walked to the greenhouse', present: ['Tessa'], cast: ['Tessa'], now: NOW,
    });
    const guarded = guardedTopics(tom, ['Tessa'], [{ nodeId: 'a', gist: 'They walked to the greenhouse' }]);
    expect(guarded).toEqual([]);
    expect(describeTheoryOfMind(tom, ['Tessa'], guarded)).toEqual([]);
  });

  it('tells the writer to keep a deliberate secret, and to keep a lie straight', () => {
    let tom = emptyTheoryOfMind();
    tom = recordWithheld(tom, 'Tessa', { nodeId: 's', gist: 'the deal she made', at: NOW }, NOW);
    tom = recordDeception(tom, 'Tessa', { nodeId: 'd', gist: 'where she was that night', at: NOW }, NOW);
    const lines = describeTheoryOfMind(
      tom, ['Tessa'],
      guardedTopics(tom, ['Tessa'], [{ nodeId: 's', gist: 'the deal she made' }]),
    );
    expect(lines.join(' ')).toMatch(/deliberately keeping/);
    expect(lines.join(' ')).toMatch(/lied to Tessa/);
  });

  it('does not let being told twice inflate certainty past witnessing', () => {
    let tom = emptyTheoryOfMind();
    tom = recordWitnessed(tom, { nodeId: 'n', gist: 'it happened', present: ['Tessa'], cast: [], now: NOW });
    tom = recordTold(tom, 'Tessa', { nodeId: 'n', gist: 'it happened', at: NOW, certainty: 0.5 }, NOW);
    expect(doesKnow(tom, 'Tessa', { nodeId: 'n' }).certainty).toBeGreaterThan(0.9);
  });
});

// ------------------------------------------------------------------- stance

describe('the character is not obliged to be agreeable (§N.2.3)', () => {
  const base = emptyPsyche(neutralTraits());

  it('always states the anti-sycophancy clause, whatever the mood', () => {
    const warm = computeStance({ psyche: base, relation: rel({ trust: 0.9, affection: 0.9 }), felt: calm });
    expect(warm.line).toMatch(/no obligation to be agreeable/);
    expect(warm.line).toMatch(/unless their state and their history/);
  });

  it('warmth is earned, not granted — a stranger gets less', () => {
    const known = computeStance({ psyche: base, relation: rel({ trust: 0.8, affection: 0.7 }), felt: calm });
    const stranger = computeStance({ psyche: base, felt: calm });
    expect(known.openness).toBeGreaterThan(stranger.openness);
    expect(stranger.reasons.join(' ')).toMatch(/has not earned/);
  });

  it('resentment produces friction; fear suppresses it', () => {
    const resentful = computeStance({
      psyche: base, relation: rel({ resentment: 0.8, fear: 0 }), felt: furious,
    });
    const afraid = computeStance({
      psyche: base, relation: rel({ resentment: 0.8, fear: 0.8 }), felt: furious,
    });
    expect(resentful.friction).toBeGreaterThan(afraid.friction);
    expect(resentful.line).toMatch(/contradict, refuse/);
  });

  it('depletion costs patience before it costs warmth', () => {
    const spent: PsycheState = {
      ...base,
      load: { level: 0.9, sustainedScenes: 18, scenesSinceRelief: 18, peak: 0.9 },
      body: { energy: 0.1, sleepDebt: 0.9, pain: 0.5, safety: 0.4, nourishment: 0.4 },
    };
    const s = computeStance({ psyche: spent, relation: rel({ trust: 0.8, affection: 0.8 }), felt: calm });
    expect(s.impatience).toBeGreaterThan(0.7);
    // Still fond of them — just with nothing left.
    expect(s.openness).toBeGreaterThan(0.25);
    expect(s.line).toMatch(/no patience/);
  });

  it('avoidant attachment closes them down even toward someone trusted', () => {
    const closed: PsycheState = { ...base, attachment: { anxiety: 0.4, avoidance: 0.95 } };
    const open: PsycheState = { ...base, attachment: { anxiety: 0.4, avoidance: 0.05 } };
    const a = computeStance({ psyche: closed, relation: rel({ trust: 0.7, affection: 0.6 }), felt: calm });
    const b = computeStance({ psyche: open, relation: rel({ trust: 0.7, affection: 0.6 }), felt: calm });
    expect(a.openness).toBeLessThan(b.openness);
  });

  it('an intrusion closes them further', () => {
    const quiet = computeStance({ psyche: base, relation: rel(), felt: calm });
    const hit = computeStance({ psyche: base, relation: rel(), felt: calm, intruded: true });
    expect(hit.openness).toBeLessThan(quiet.openness);
    expect(hit.reasons.join(' ')).toMatch(/just surfaced/);
  });

  it('refuses only when the state genuinely warrants it', () => {
    const willing = computeStance({ psyche: base, relation: rel({ trust: 0.8 }), felt: calm });
    expect(wouldRefuse(willing, { intimate: true })).toBe(false);

    const shut: PsycheState = {
      ...base,
      attachment: { anxiety: 0.5, avoidance: 0.95 },
      condition: {
        ...base.condition,
        ptsd: { ...base.condition.ptsd, avoidance: 0.9 },
      },
    };
    const hostile = computeStance({
      psyche: shut, relation: rel({ trust: -0.9, resentment: 0.9, affection: -0.4 }), felt: furious,
    });
    expect(wouldRefuse(hostile, { intimate: true })).toBe(true);
  });

  it('summarises to a signed valence for the inspector', () => {
    const warm = computeStance({ psyche: base, relation: rel({ trust: 0.9, affection: 0.9 }), felt: calm });
    const cold = computeStance({
      psyche: base, relation: rel({ trust: -0.9, resentment: 0.9 }), felt: furious,
    });
    expect(stanceValence(warm)).toBeGreaterThan(stanceValence(cold));
    for (const v of [stanceValence(warm), stanceValence(cold)]) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
