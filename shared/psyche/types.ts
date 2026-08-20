/**
 * The Psyche layer — data model.
 *
 * Implements docs/research/psyche-architecture.md (cited as §P.n below).
 * Where the brain (`shared/brain`) is *what this character remembers*, the
 * psyche is *who is doing the remembering right now*: what they are carrying,
 * how depleted they are, what they cannot look at, and what that is costing.
 *
 * Design rule inherited from the brain: every field earns its place from a
 * finding in the research, and nothing in this layer calls an LLM. The model
 * appraises events; the psyche is pure arithmetic over state, so it is
 * deterministic, testable, explainable and free.
 */
import type { Affect, Appraisal, EmotionLabel, TraitVector } from '../brain/types';
import type { TheoryOfMind } from './theoryOfMind';

// ---------- the body (§P.2.3) ----------

/**
 * Bodily budget. Present because affect is, in Barrett's account, the read-out of
 * allostasis — and because one coupling earns the whole struct: coping potential
 * is scaled by bodily capacity, and coping potential is the axis that separates
 * fear from anger. An exhausted character does not merely say they are tired;
 * the provocation that would have produced fury produces fear instead.
 */
export interface Body {
  /** 0 collapsed … 1 fully rested. */
  energy: number;
  /** 0 slept well … 1 severely deprived. Recovers only by sleeping. */
  sleepDebt: number;
  /** 0 unhurt … 1 agony. */
  pain: number;
  /** 0 in danger … 1 secure. Gates recovery of everything else. */
  safety: number;
  /** 0 starving … 1 fed. Slow-moving; matters in captivity/survival arcs. */
  nourishment: number;
}

// ---------- accumulated cost (§P.2.4) ----------

/**
 * Allostatic load — the wear from repeated activation and from inefficient
 * shutting-off of the stress response (McEwen). This is the master gain on the
 * whole psyche: it raises reactivity, lowers bodily capacity, blurs emotional
 * granularity, and regresses defense maturity.
 */
export interface Load {
  /** 0 unstressed … 1 at the edge of what they can carry. */
  level: number;
  /**
   * Consecutive scenes spent above the strain threshold. Chronicity matters
   * independently of level: brief spikes are survivable, sustained load is what
   * does the damage.
   */
  sustainedScenes: number;
  /** Scenes since load was last low. Drives how long recovery takes. */
  scenesSinceRelief: number;
  /** Highest level ever reached — a scar marker, never decays. */
  peak: number;
}

// ---------- affect over time (§P.2.1, §P.2.2) ----------

/**
 * The shape of this character's emotional life, not its average.
 *
 * Affective-dynamics research is explicit that inertia, variability and
 * instability carry the psychopathology signal independently of intensity, and
 * that emotion differentiation (granularity) is itself a health marker. These
 * are state, not constants: they move with load and condition.
 */
export interface AffectDynamics {
  /**
   * ρ — emotional inertia, 0..1. How much of the previous mood survives into the
   * next moment. High inertia = feelings stick and will not shift; rises with
   * depression and load.
   */
  inertia: number;
  /**
   * κ — reactivity, typically 0.4..2. Multiplier on how far a given appraisal
   * moves emotion. Rises with hyperarousal (kindling), falls with numbing.
   */
  reactivity: number;
  /** Running mean squared successive difference of valence — dysregulation. */
  instability: number;
  /**
   * g — granularity 0..1. How finely they differentiate feeling. Low `g` collapses
   * the emotion label to a coarse family, which is a *prose* consequence: "a cold,
   * specific shame about having begged" versus "she feels bad and can't say why".
   * Drops under acute load and dissociation; rises slowly with reflection.
   */
  granularity: number;
  /** Last valence, for the successive-difference calculation. */
  lastValence: number;
  /** Samples taken, so early estimates are not over-confident. */
  samples: number;
}

// ---------- appraisal bias (§P.3) ----------

/** One stage of the bias pipeline, kept so the Mind page can explain a reading. */
export interface BiasStep {
  /** Which stage did this. */
  source:
    | 'trait' | 'mood' | 'threat' | 'relation' | 'schema'
    | 'attribution' | 'body' | 'numbing';
  /** Which appraisal check moved. */
  check: keyof Appraisal;
  before: number | string;
  after: number | string;
  /** Plain-language reason, shown in the UI verbatim. */
  why: string;
}

export interface AppraisalTrace {
  raw: Appraisal;
  biased: Appraisal;
  steps: BiasStep[];
}

/**
 * How this character explains bad outcomes to themselves (hopelessness theory).
 *
 * These three signed numbers are the difference between "he betrayed me" and
 * "I let this happen, I always do, everything I touch goes this way" — and
 * therefore between two entirely different memories being written from one event.
 */
export interface AttributionalStyle {
  /** -1 always someone else's fault … +1 always mine. */
  internal: number;
  /** -1 this was a one-off … +1 this is permanent and will not change. */
  stable: number;
  /** -1 this touched one thing … +1 this is true of my whole life. */
  global: number;
}

// ---------- regulation (§P.4) ----------

/**
 * What a person *does* about a feeling. Ordered roughly by Gross's process model:
 * where in the emotion cycle the move intervenes. Each carries relief now and a
 * consequence later — that trade is the engine of the whole character arc.
 */
export type RegulationMove =
  /** cognitive change — reinterpret the meaning. Effective now, healthy later. */
  | 'reappraise'
  /** attentional deployment — look at something else. */
  | 'distract'
  /** response modulation — feel it, show nothing. Relief is outward only. */
  | 'suppress'
  /** situation selection — do not go near it. Maximum relief, maximum cost. */
  | 'avoid'
  /** attentional — circle the wound without resolving it. */
  | 'ruminate_brood'
  /** cognitive change — work at the meaning deliberately. The growth pathway. */
  | 'ruminate_deliberate'
  /** response modulation — leave. Total relief, fragments the memory. */
  | 'dissociate'
  /** situation modification — reach for someone. Lowers load, builds security. */
  | 'seek_support'
  /** situation modification — meet it head-on. */
  | 'confront'
  /** no regulation attempted — the feeling is simply had. */
  | 'none';

/** Vaillant's four-tier hierarchy, as a maturity band. */
export type DefenseLevel = 'psychotic' | 'immature' | 'neurotic' | 'mature';

export interface RegulationChoice {
  move: RegulationMove;
  level: DefenseLevel;
  /** 0..1 — how much of the felt intensity this removed *now*. */
  relief: number;
  /** Signed — what it did to allostatic load. */
  loadDelta: number;
  /** Plain-language: what they did, for the prompt and the audit log. */
  description: string;
  /** Why this move and not another, for the Mind page. */
  rationale: string;
  /** Alternatives that were available but not taken, best-first. */
  alternatives: RegulationMove[];
}

/**
 * The split between the emotion had and the emotion displayed.
 *
 * Nearly free to compute and disproportionately powerful in prose: characters
 * become people when there is a gap between the face and the inside, and when
 * there are things they will not say.
 */
export interface ExpressedAffect {
  felt: Affect;
  shown: Affect;
  /** 0 transparent … 1 nothing reaches the surface. */
  opacity: number;
  /** What the body does anyway — the tell that leaks past the control. */
  leak?: string;
}

// ---------- condition (§P.5) ----------

/**
 * Emergent clinical read-out. **Nothing here is ever authored.** Every field is
 * computed from the memory graph plus the coping record, which is the commitment
 * that makes the character feel discovered rather than configured.
 */
export interface Condition {
  /** DSM-5-shaped PTSD clusters, each 0..1. */
  ptsd: {
    intrusion: number;
    avoidance: number;
    /** Negative alterations in cognition and mood. */
    negativeAlterations: number;
    /** Hyperarousal and reactivity. */
    arousal: number;
    /** Composite severity. */
    severity: number;
  };
  /** ICD-11 disturbances in self-organisation — CPTSD beyond PTSD. */
  dso: {
    affectDysregulation: number;
    negativeSelfConcept: number;
    relationalDisturbance: number;
    /** All three sustained alongside PTSD load. */
    severity: number;
  };
  depression: {
    hopelessness: number;
    anhedonia: number;
    brooding: number;
    /** CaR-FA-X: how much retrieval has lost specificity. */
    overgeneralMemory: number;
    severity: number;
  };
  anxiety: {
    threatExpectancy: number;
    hypervigilance: number;
    severity: number;
  };
  /** Acute (this scene) and chronic (accumulated) detachment. */
  dissociation: { acute: number; chronic: number };
  /** Post-traumatic growth across Tedeschi & Calhoun's five domains. */
  growth: {
    strength: number;
    relating: number;
    possibilities: number;
    appreciation: number;
    existential: number;
    severity: number;
  };
}

// ---------- trauma as a live process (§P.5.1) ----------

/**
 * The maintenance loop for one traumatic memory.
 *
 * v1 made trauma a *kind of node*. It is actually a *process*: chronic PTSD
 * persists because of a poorly elaborated memory, negative appraisals of it, and
 * what the person does when it surfaces. Approach in safety integrates it;
 * avoidance sensitises it. This struct is where that difference lives.
 */
export interface TraumaTrace {
  /** The `sensory` node in the brain graph this tracks. */
  nodeId: string;
  /** The weakly-bound contextual counterpart, if one was encoded. */
  contextNodeId?: string;
  /** 0 free-floating fragment … 1 fully placed in time and sequence. */
  contextBinding: number;
  /** 0 remembered as past … 1 happening right now. The core PTSD quality. */
  nowness: number;
  /** 0 wordless … 1 narrated, organised, tellable. */
  elaboration: number;
  /** The personal meanings that maintain it (Ehlers & Clark). */
  appraisals: {
    selfBlame: number;
    worldDanger: number;
    /** "I am permanently changed / damaged by this." */
    permanentChange: number;
    shame: number;
  };
  /** How the character is a witness to their own history. */
  avoidanceCount: number;
  approachCount: number;
  /** Which pathway formed it — they have different trajectories. */
  pathway: 'fear' | 'betrayal' | 'moral';
  /** Person at the centre of it, for cue matching and relational damage. */
  perpetrator?: string;
  encodedAt: number;
  lastIntrusionAt?: number;
  intrusionCount: number;
}

// ---------- the whole psyche ----------

export interface PsycheState {
  version: 1;
  body: Body;
  load: Load;
  dynamics: AffectDynamics;
  attribution: AttributionalStyle;
  /**
   * 0 acts out / dissociates … 1 humour, altruism, saying the hard thing.
   * Regresses acutely under load, grows slowly when a mature move is chosen and
   * survives. This is the arc every redemption story has.
   */
  defenseMaturity: number;
  /** Global attachment working model, revised slowly by disconfirming evidence. */
  attachment: { anxiety: number; avoidance: number };
  condition: Condition;
  traumas: TraumaTrace[];
  /** Last N regulation choices, newest last — the coping record §P.5 reads. */
  copingHistory: { at: number; move: RegulationMove; level: DefenseLevel }[];
  /**
   * What this character believes other people know (§N.2.1). Optional so brains
   * saved before it existed keep loading; seeded empty on first read.
   */
  theoryOfMind?: TheoryOfMind;
  /** Scene counter, so "sustained" and "since relief" mean something. */
  scenes: number;
  /**
   * The last appraised moment, kept so the prompt can carry felt-versus-shown
   * without re-running an appraisal it has no new event for. Intrusions are *not*
   * stored here — they are recomputed against the live scene, because what is
   * surfacing depends on what is happening now, not on what was last consolidated.
   */
  lastMoment?: {
    affect: ExpressedAffect;
    regulation: RegulationChoice;
    pull: string;
    at: number;
  };
  updatedAt: number;
}

/** Everything the psyche needs to know about the moment it is appraising. */
export interface MomentContext {
  /** Names present, so relational priors and perpetrator cues can fire. */
  actors: string[];
  /** What was just said/done, for trauma cue matching. */
  text: string;
  now: number;
  /** Active goals, for goal-relevance bias. */
  goals?: string[];
  /** Emotion this character is coming into the moment with. */
  mood: Affect;
  traits: TraitVector;
}

/** Tunables for the psyche, mirroring `BrainParams` in spirit. */
export interface PsycheParams {
  /** Load added per unit of arousal spent in a scene. */
  loadPerArousal: number;
  /** Load removed per scene of safety, rest and connection. */
  reliefRate: number;
  /** Above this, load counts as strain and starts accumulating chronicity. */
  strainThreshold: number;
  /** How much load raises reactivity (kindling). */
  kindlingGain: number;
  /** How much load and dissociation blur granularity. */
  granularityLoss: number;
  /** Rate at which granularity recovers with reflective processing. */
  granularityGain: number;
  /** How far defense maturity can regress below its baseline under load. */
  maturityRegression: number;
  /** Maturity gained per successful mature move. */
  maturityGain: number;
  /** Nowness lost per approach, gained per avoidance. */
  integrationRate: number;
  sensitisationRate: number;
  /** Sleep debt accrued per scene awake; recovered per scene asleep. */
  sleepDebtRate: number;
  /** Trauma count / severity needed before CPTSD read-out engages. */
  dsoThreshold: number;
}
