/**
 * Psyche defaults and factories.
 *
 * Rate constants are storytelling decisions wearing citations: they are tuned so
 * that visible change happens over tens of scenes rather than over the years real
 * change takes. Where a value is arbitrary, the comment says so.
 */
import type { TraitVector } from '../brain/types';
import { emptyTheoryOfMind } from './theoryOfMind';
import type {
  AttributionalStyle, Condition, PsycheParams, PsycheState,
} from './types';

export const DEFAULT_PSYCHE_PARAMS: PsycheParams = {
  loadPerArousal: 0.09,      // ~11 maximally arousing scenes to saturate from calm
  reliefRate: 0.07,          // recovery is slower than accumulation, as in life
  strainThreshold: 0.55,
  kindlingGain: 0.6,         // at full load, reactivity is 1.6× baseline
  granularityLoss: 0.45,
  granularityGain: 0.02,     // naming your feelings again takes a long time
  maturityRegression: 0.35,  // a loaded person can lose a third of their maturity
  maturityGain: 0.012,
  integrationRate: 0.12,     // facing it in safety, ~8 times, to substantially heal
  sensitisationRate: 0.06,   // avoidance makes it worse at half the speed
  sleepDebtRate: 0.06,
  dsoThreshold: 0.45,
};

export function neutralBody() {
  // An ordinary, unremarkable day: slightly short of sleep, basically safe.
  return { energy: 0.9, sleepDebt: 0.05, pain: 0, safety: 0.85, nourishment: 0.9 };
}

export function emptyCondition(): Condition {
  return {
    ptsd: { intrusion: 0, avoidance: 0, negativeAlterations: 0, arousal: 0, severity: 0 },
    dso: { affectDysregulation: 0, negativeSelfConcept: 0, relationalDisturbance: 0, severity: 0 },
    depression: { hopelessness: 0, anhedonia: 0, brooding: 0, overgeneralMemory: 0, severity: 0 },
    anxiety: { threatExpectancy: 0, hypervigilance: 0, severity: 0 },
    dissociation: { acute: 0, chronic: 0 },
    growth: { strength: 0, relating: 0, possibilities: 0, appreciation: 0, existential: 0, severity: 0 },
  };
}

/**
 * A fresh psyche, seeded from temperament.
 *
 * Disposition is the only information available at birth, so it sets the
 * starting attributional style, attachment and defense maturity — a low-trust,
 * low-selfWorth character starts closer to self-blame and to avoidant
 * attachment, which is how a card's personality becomes a *mechanism* rather
 * than a description.
 */
export function emptyPsyche(traits?: TraitVector, now = Date.now()): PsycheState {
  const t = traits;
  const selfWorth = t?.selfWorth ?? 0;
  const trust = t?.trust ?? 0;
  const volatility = t?.volatility ?? 0;
  const conscientiousness = t?.conscientiousness ?? 0;

  return {
    version: 1,
    body: neutralBody(),
    load: { level: 0.15, sustainedScenes: 0, scenesSinceRelief: 0, peak: 0.15 },
    dynamics: {
      // Volatile characters swing further and settle less.
      inertia: clamp01(0.45 + 0.1 * volatility),
      reactivity: clamp(0.8 + 0.4 * volatility, 0.4, 2),
      instability: 0,
      // Self-aware, conscientious characters start out better at naming feelings.
      granularity: clamp01(0.55 + 0.2 * conscientiousness - 0.15 * volatility),
      lastValence: 0,
      samples: 0,
    },
    attribution: {
      // Low self-worth is the classic depressogenic style: my fault, always, everywhere.
      internal: clampSigned(-0.15 - 0.45 * selfWorth),
      stable: clampSigned(-0.2 - 0.35 * selfWorth),
      global: clampSigned(-0.25 - 0.3 * selfWorth),
    },
    defenseMaturity: clamp01(0.5 + 0.2 * conscientiousness + 0.15 * selfWorth - 0.2 * volatility),
    attachment: {
      anxiety: clamp01(0.35 - 0.25 * selfWorth),
      avoidance: clamp01(0.35 - 0.3 * trust),
    },
    condition: emptyCondition(),
    traumas: [],
    copingHistory: [],
    theoryOfMind: emptyTheoryOfMind(),
    scenes: 0,
    updatedAt: now,
  };
}

/** Fill in anything a stored psyche is missing after a version upgrade. */
export function normalizePsyche(raw: Partial<PsycheState> | null | undefined, traits?: TraitVector): PsycheState {
  const base = emptyPsyche(traits, raw?.updatedAt);
  if (!raw) return base;
  const cond = raw.condition ?? {};
  return {
    ...base,
    ...raw,
    version: 1,
    body: { ...base.body, ...(raw.body ?? {}) },
    load: { ...base.load, ...(raw.load ?? {}) },
    dynamics: { ...base.dynamics, ...(raw.dynamics ?? {}) },
    attribution: { ...base.attribution, ...(raw.attribution ?? {}) },
    attachment: { ...base.attachment, ...(raw.attachment ?? {}) },
    condition: {
      ptsd: { ...base.condition.ptsd, ...((cond as Condition).ptsd ?? {}) },
      dso: { ...base.condition.dso, ...((cond as Condition).dso ?? {}) },
      depression: { ...base.condition.depression, ...((cond as Condition).depression ?? {}) },
      anxiety: { ...base.condition.anxiety, ...((cond as Condition).anxiety ?? {}) },
      dissociation: { ...base.condition.dissociation, ...((cond as Condition).dissociation ?? {}) },
      growth: { ...base.condition.growth, ...((cond as Condition).growth ?? {}) },
    },
    traumas: raw.traumas ?? [],
    copingHistory: (raw.copingHistory ?? []).slice(-60),
    theoryOfMind: raw.theoryOfMind ?? emptyTheoryOfMind(),
  };
}

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

export function clampSigned(v: number): number {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}
