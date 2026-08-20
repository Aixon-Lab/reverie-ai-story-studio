/**
 * Experience → person: relationship models and bounded personality drift.
 *
 * Traits are substantially stable but genuinely movable (§9.3). The card
 * defines a **disposition** that acts as a permanent anchor; lived experience
 * drifts the current traits around it, slowly, within a hard bound, and
 * regresses toward the anchor when the evidence stops arriving.
 */
import { clamp01, clampSigned } from './activation';
import { TRAIT_AXES } from './defaults';
import { resolvePerson } from './entities';
import type {
  Affect, BrainParams, BrainState, MemoryNode, RelationModel, TraitAxis, TraitVector,
} from './types';

/**
 * The trait pressure one memory exerts.
 *
 * Pressure is scaled by arousal and goal relevance — a mild event nudges
 * nothing. It is deliberately small: personality moves under *accumulated*
 * evidence, not single scenes (§9.3), except where the event is traumatic or
 * identity-defining.
 */
export function traitPressure(node: MemoryNode): Partial<TraitVector> {
  const a = node.appraisal;
  const f = node.affect;
  const weight =
    (0.4 + 0.6 * clamp01(f.arousal)) *
    (0.4 + 0.6 * clamp01(a.goalRelevance)) *
    (node.kind === 'identity' ? 1.8 : node.kind === 'schema' ? 1.5 : node.kind === 'sensory' ? 1.6 : 1);

  const out: Partial<TraitVector> = {};
  const add = (axis: TraitAxis, v: number) => {
    out[axis] = (out[axis] ?? 0) + v * weight;
  };

  // Betrayal and kept faith are the trust axis, asymmetric by nature.
  if (a.agency === 'other') {
    if (a.intent < -0.2 && a.goalConduciveness < 0) add('trust', -0.09 * Math.abs(a.intent));
    if (a.intent > 0.2 && a.goalConduciveness > 0) add('trust', 0.04 * a.intent);
    if (f.valence > 0.2) add('warmth', 0.035);
    if (f.valence < -0.3) add('warmth', -0.03);
  }

  // Facing something with power builds courage; being overwhelmed erodes it.
  if (a.goalConduciveness < -0.2) {
    if (a.copingPotential > 0.6) { add('courage', 0.05); add('selfWorth', 0.03); }
    else if (a.copingPotential < 0.3) { add('courage', -0.045); add('volatility', 0.04); }
  }
  if (a.goalConduciveness > 0.4 && a.agency === 'self') { add('selfWorth', 0.05); add('dominance', 0.03); }

  // Shame and guilt sit on self-worth and conscientiousness.
  if (a.agency === 'self' && a.norms < -0.25) { add('selfWorth', -0.06); add('conscientiousness', 0.03); }
  if (a.agency === 'self' && a.norms > 0.25) { add('selfWorth', 0.04); add('conscientiousness', 0.025); }

  // Novelty tolerated well opens a person up; novelty that hurt closes them.
  if (a.novelty > 0.55) {
    add('openness', f.valence >= 0 ? 0.035 : -0.03);
  }

  // High arousal without control is the destabilising pattern.
  if (f.arousal > 0.7 && a.copingPotential < 0.4) add('volatility', 0.05);
  if (f.arousal > 0.6 && a.copingPotential > 0.7) add('volatility', -0.025);

  if (node.intrusive) { add('volatility', 0.06); add('trust', -0.03); add('courage', -0.02); }

  return out;
}

/**
 * Apply accumulated pressure with a hard bound around the disposition.
 *
 * Returns the *net* change per axis so the audit log can show exactly how the
 * character moved and why.
 */
export function applyDrift(
  brain: BrainState,
  pressures: Partial<TraitVector>[],
  p: BrainParams,
): Partial<TraitVector> {
  const changes: Partial<TraitVector> = {};
  const total: TraitVector = { ...zeroTraits() };
  for (const pr of pressures) {
    for (const axis of TRAIT_AXES) total[axis] += pr[axis] ?? 0;
  }

  for (const axis of TRAIT_AXES) {
    const before = brain.traits[axis];
    const anchor = brain.disposition[axis];

    // Drive from evidence…
    let next = before + p.driftRate * total[axis];
    // …then regress toward disposition. The pull is stronger the further out we are.
    const displacement = next - anchor;
    const pull = 0.06 * Math.sign(displacement) * Math.pow(Math.abs(displacement) / Math.max(0.05, p.maxDrift), 2);
    next -= pull;

    // Hard bound: a character never stops being themselves.
    const lo = Math.max(-1, anchor - p.maxDrift);
    const hi = Math.min(1, anchor + p.maxDrift);
    next = Math.min(hi, Math.max(lo, next));

    if (Math.abs(next - before) > 1e-6) {
      brain.traits[axis] = clampSigned(next);
      changes[axis] = Number((next - before).toFixed(5));
    }
  }
  return changes;
}

function zeroTraits(): TraitVector {
  return {
    warmth: 0, dominance: 0, volatility: 0, trust: 0,
    courage: 0, openness: 0, conscientiousness: 0, selfWorth: 0,
  };
}

// ---------- relationship models (§9.2) ----------

export function personKey(name: string): string {
  return name.trim().toLowerCase();
}

export function ensureRelation(brain: BrainState, name: string, now: number): RelationModel {
  const key = resolvePerson(brain, name);
  const existing = brain.people[key];
  if (existing) return existing;
  const fresh: RelationModel = {
    key,
    displayName: name.trim(),
    // Start from disposition: a trusting person extends trust to strangers.
    trust: clampSigned(brain.disposition.trust * 0.4),
    affection: clampSigned(brain.disposition.warmth * 0.25),
    fear: 0,
    respect: 0,
    resentment: 0,
    debt: 0,
    familiarity: 0,
    model: '',
    interactions: 0,
    firstMetAt: now,
    lastSeenAt: now,
  };
  brain.people[key] = fresh;
  return fresh;
}

/**
 * Update the internal working model of one person from one memory.
 *
 * Asymmetry is the point: trust erodes several times faster than it accrues,
 * fear is quick to learn and slow to unlearn, resentment accumulates unless
 * something explicitly resolves it.
 */
export function updateRelation(
  brain: BrainState,
  name: string,
  node: MemoryNode,
  now: number,
): RelationModel {
  const r = ensureRelation(brain, name, now);
  const a = node.appraisal;
  const f = node.affect;
  const intensity = 0.3 + 0.7 * clamp01(f.arousal);

  if (a.agency === 'other') {
    if (a.intent < -0.15 && a.goalConduciveness < 0) {
      r.trust = clampSigned(r.trust - 0.22 * intensity * Math.abs(a.intent));
      r.resentment = clampSigned(r.resentment + 0.16 * intensity);
    } else if (a.intent > 0.15 && a.goalConduciveness > 0) {
      r.trust = clampSigned(r.trust + 0.06 * intensity * a.intent);
      r.resentment = clampSigned(r.resentment - 0.05 * intensity);
      r.debt = clampSigned(r.debt - 0.08 * intensity);
    }
    if (a.copingPotential < 0.3 && f.valence < -0.3) {
      r.fear = clampSigned(r.fear + 0.18 * intensity);
    } else if (f.valence > 0.2 && a.copingPotential > 0.6) {
      r.fear = clampSigned(r.fear - 0.04 * intensity);
    }
    if (a.norms > 0.3 || (a.goalConduciveness > 0.5 && a.copingPotential < 0.5)) {
      r.respect = clampSigned(r.respect + 0.10 * intensity);
    }
    if (a.norms < -0.4) r.respect = clampSigned(r.respect - 0.12 * intensity);
  }

  r.affection = clampSigned(r.affection + 0.09 * intensity * f.valence);
  if (a.agency === 'self' && a.goalConduciveness > 0.3) r.debt = clampSigned(r.debt + 0.06 * intensity);

  r.interactions++;
  r.lastSeenAt = now;
  // Familiarity saturates — you learn most about someone early. The scale is
  // in *encoded* interactions, which are already the memorable ones, so a
  // handful of them means you know someone reasonably well.
  r.familiarity = clamp01(1 - Math.exp(-r.interactions / 8));
  return r;
}

/** One-line rendering of a relationship for the prompt block. */
export function describeRelation(r: RelationModel): string {
  const bits: string[] = [];
  const level = (v: number, hi: string, lo: string) =>
    v > 0.55 ? `deeply ${hi}` : v > 0.2 ? hi : v < -0.55 ? `deeply ${lo}` : v < -0.2 ? lo : '';

  const t = level(r.trust, 'trusts', 'distrusts');
  if (t) bits.push(t);
  const aff = level(r.affection, 'is fond of', 'is cold toward');
  if (aff) bits.push(aff);
  if (r.fear > 0.3) bits.push(r.fear > 0.6 ? 'is afraid of' : 'is wary of');
  if (r.respect > 0.35) bits.push('respects');
  if (r.resentment > 0.35) bits.push('resents');
  if (r.debt > 0.4) bits.push('feels indebted to');
  if (r.debt < -0.4) bits.push('feels owed by');

  const rel = bits.length ? bits.join(', ') : 'has no strong feeling about';
  const known = r.familiarity > 0.7 ? 'knows them well' : r.familiarity > 0.3 ? 'is getting to know them' : 'barely knows them';
  return `${r.displayName}: ${rel} them; ${known} (${r.interactions} shared moments).`;
}

// ---------- disposition from the card ----------

const TRAIT_LEXICON: Record<TraitAxis, { pos: string[]; neg: string[] }> = {
  warmth: {
    pos: ['warm', 'kind', 'caring', 'gentle', 'affectionate', 'nurturing', 'friendly', 'compassionate', 'loving', 'motherly'],
    neg: ['cold', 'aloof', 'distant', 'cruel', 'callous', 'detached', 'ruthless', 'unfeeling', 'icy'],
  },
  dominance: {
    pos: ['dominant', 'commanding', 'assertive', 'authoritative', 'leader', 'controlling', 'imperious', 'alpha', 'strong-willed', 'headstrong'],
    neg: ['submissive', 'meek', 'deferential', 'timid', 'obedient', 'passive', 'yielding', 'docile'],
  },
  volatility: {
    pos: ['volatile', 'temperamental', 'impulsive', 'hot-headed', 'unstable', 'erratic', 'anxious', 'neurotic', 'moody', 'explosive'],
    neg: ['calm', 'composed', 'steady', 'unflappable', 'serene', 'patient', 'even-tempered', 'stoic'],
  },
  trust: {
    pos: ['trusting', 'open-hearted', 'naive', 'earnest', 'credulous', 'faithful', 'loyal'],
    neg: ['paranoid', 'suspicious', 'guarded', 'cynical', 'jaded', 'wary', 'distrustful', 'secretive'],
  },
  courage: {
    pos: ['brave', 'fearless', 'bold', 'daring', 'courageous', 'valiant', 'reckless', 'defiant', 'unafraid'],
    neg: ['timid', 'cowardly', 'fearful', 'skittish', 'nervous', 'shy', 'hesitant', 'frightened'],
  },
  openness: {
    pos: ['curious', 'imaginative', 'inventive', 'creative', 'adventurous', 'eccentric', 'philosophical', 'artistic'],
    neg: ['rigid', 'conventional', 'traditional', 'dogmatic', 'closed-minded', 'stubborn', 'incurious'],
  },
  conscientiousness: {
    pos: ['disciplined', 'meticulous', 'dutiful', 'principled', 'honorable', 'diligent', 'precise', 'responsible', 'punctual'],
    neg: ['reckless', 'careless', 'sloppy', 'lazy', 'unreliable', 'chaotic', 'irresponsible', 'hedonistic'],
  },
  selfWorth: {
    pos: ['confident', 'proud', 'self-assured', 'vain', 'arrogant', 'poised', 'dignified'],
    neg: ['insecure', 'self-loathing', 'worthless', 'ashamed', 'broken', 'unworthy', 'self-doubting', 'guilt-ridden'],
  },
};

/**
 * Heuristic disposition from card text. Used as the fallback (and as the prior
 * the LLM pass refines), so a brain is never born blank even offline.
 */
export function dispositionFromText(text: string): TraitVector {
  const hay = ` ${(text || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  const out = zeroTraits();
  for (const axis of TRAIT_AXES) {
    const { pos, neg } = TRAIT_LEXICON[axis];
    let score = 0;
    for (const w of pos) if (hay.includes(` ${w} `) || hay.includes(`${w}ness`)) score += 1;
    for (const w of neg) if (hay.includes(` ${w} `) || hay.includes(`${w}ness`)) score -= 1;
    // Saturating: three hits is already a strong signal, ten is not three times stronger.
    out[axis] = clampSigned(Math.tanh(score / 2.2));
  }
  return out;
}

/** Clamp an LLM-produced trait vector into range and fill gaps from a prior. */
export function normalizeTraits(raw: unknown, prior: TraitVector): TraitVector {
  const out = { ...prior };
  if (raw && typeof raw === 'object') {
    for (const axis of TRAIT_AXES) {
      const v = (raw as Record<string, unknown>)[axis];
      if (typeof v === 'number' && Number.isFinite(v)) out[axis] = clampSigned(v);
    }
  }
  return out;
}

/** Human-readable trait summary for the prompt block. */
export function describeTraits(traits: TraitVector, disposition: TraitVector): string {
  const notes: string[] = [];
  const say = (axis: TraitAxis, hi: string, lo: string) => {
    const v = traits[axis];
    if (v > 0.35) notes.push(hi);
    else if (v < -0.35) notes.push(lo);
  };
  say('warmth', 'warm', 'cold');
  say('dominance', 'commanding', 'deferential');
  say('volatility', 'volatile', 'even-tempered');
  say('trust', 'trusting', 'guarded');
  say('courage', 'bold', 'fearful');
  say('openness', 'curious', 'set in their ways');
  say('conscientiousness', 'disciplined', 'careless');
  say('selfWorth', 'self-assured', 'insecure');

  const drifted = TRAIT_AXES
    .map((axis) => ({ axis, delta: traits[axis] - disposition[axis] }))
    .filter((d) => Math.abs(d.delta) > 0.12)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3);

  const drift = drifted.length
    ? ` Changed by what they have lived through: ${drifted
        .map((d) => `${d.delta > 0 ? 'more' : 'less'} ${axisWord(d.axis)}`)
        .join(', ')}.`
    : '';

  return `${notes.length ? notes.join(', ') : 'balanced'}.${drift}`;
}

function axisWord(axis: TraitAxis): string {
  switch (axis) {
    case 'warmth': return 'warm';
    case 'dominance': return 'assertive';
    case 'volatility': return 'reactive';
    case 'trust': return 'trusting';
    case 'courage': return 'courageous';
    case 'openness': return 'open to new things';
    case 'conscientiousness': return 'disciplined';
    case 'selfWorth': return 'sure of themselves';
  }
}
