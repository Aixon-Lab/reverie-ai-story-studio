/**
 * Character Brain — data model.
 *
 * Implements docs/brain-system.md §2, grounded in
 * docs/research/human-memory-architecture.md (cited as §n below).
 *
 * Design rule: nothing here is a "chat summary". Every field exists because a
 * finding in the research dossier requires it.
 */
// Type-only, and reciprocated by `shared/psyche/types.ts`. The cycle is erased at
// compile time; keeping the two models in separate files is worth it because
// memory and mind are genuinely different concerns.
import type { PsycheState } from '../psyche/types';
import type { BrainIndex } from './graph';
import type { Distortion } from './reconstruction';
import type { SynapticState } from './synapse';
import type { GoalReview, Intention, SteeringDirective } from './volition';

// ---------- affect ----------

/** Discrete emotion labels the appraisal engine can emit (Scherer CPM families). */
export type EmotionLabel =
  | 'joy' | 'affection' | 'pride' | 'relief' | 'amusement' | 'desire' | 'awe'
  | 'trust' | 'hope' | 'gratitude' | 'calm'
  | 'anger' | 'contempt' | 'disgust' | 'fear' | 'horror' | 'anxiety' | 'sadness' | 'grief'
  | 'shame' | 'guilt' | 'jealousy' | 'humiliation' | 'loneliness'
  | 'surprise' | 'confusion' | 'neutral';

/**
 * Dimensional affect (PAD). Valence and arousal do different jobs (§5.2):
 * arousal drives durability, valence drives content and relationship updating.
 */
export interface Affect {
  /** -1 misery … +1 delight */
  valence: number;
  /** 0 calm … 1 maximal activation — the consolidation modulator (§5.1) */
  arousal: number;
  /** -1 powerless … +1 in control — separates fear from anger (§5.4) */
  dominance: number;
  label: EmotionLabel;
}

/**
 * Scherer Component Process Model appraisal checks (§5.4).
 * Conditioned on the character's own traits/goals — this is why the same event
 * produces different emotions (and therefore different memories) per character.
 */
export interface Appraisal {
  /** 0 utterly expected … 1 shocking. Also the encoding prediction-error signal (§2.1). */
  novelty: number;
  /** -1 repellent … +1 intrinsically pleasant */
  pleasantness: number;
  /** 0 irrelevant … 1 strikes at an active goal or core concern */
  goalRelevance: number;
  /** -1 blocks my goals … +1 advances them */
  goalConduciveness: number;
  /** who made this happen */
  agency: 'self' | 'other' | 'circumstance';
  /** -1 malicious … 0 neutral … +1 benevolent intent attributed to the agent */
  intent: number;
  /** 0 helpless … 1 fully able to handle it. Fear vs. anger hinges here (§5.4). */
  copingPotential: number;
  /** -1 violates my standards … +1 upholds them (guilt/shame/pride axis) */
  norms: number;
  /** 0 can wait … 1 demands response now */
  urgency: number;
}

// ---------- nodes ----------

export type MemoryKind =
  /** a bounded event with time/place/self binding */
  | 'episodic'
  /** decontextualised fact abstracted from episodes (§7, §13.1) */
  | 'semantic'
  /** induced belief/pattern that biases future appraisal (§9.1) */
  | 'schema'
  /** self-defining memory — anchors identity, never pruned (§1.3) */
  | 'identity'
  /** trauma S-rep: sensory-bound, weakly contextualised, involuntary (§8) */
  | 'sensory'
  /** internal working model of a specific person (§9.2) */
  | 'relational'
  /** habit / verbal tic / default coping move (§9.4) */
  | 'procedural';

export type MemoryStatus =
  /** above retrieval threshold with ordinary cues */
  | 'active'
  /** below threshold — recallable only with a strong, specific cue (§3.2) */
  | 'faded'
  /** effectively inaccessible; retained for reinstatement and for the graph view */
  | 'dormant';

export interface MemoryNode {
  id: string;
  kind: MemoryKind;

  /** Durable meaning. Always present, fades slowly (fuzzy-trace gist, §7.3). */
  gist: string;
  /** Surface form / exact wording. Fades fast and is dropped entirely (§7.3). */
  verbatim?: string;
  /** Sensory particulars — what it looked, sounded, smelled like. */
  detail?: string;

  // --- ACT-R trace substrate (§4.1) ---
  encodedAt: number;
  /**
   * Timestamps of encounters and retrievals. Each is an independently decaying
   * trace; strength is their log-sum. Capped at `maxTraceHistory`, after which
   * the optimised approximation takes over using `useCount` + `encodedAt`.
   */
  uses: number[];
  /** True lifetime count, kept exact even once `uses` is capped. */
  useCount: number;
  /** β_i — permanent offset from emotional/identity significance (§5.1). */
  permanentBoost: number;

  // --- affective record ---
  affect: Affect;
  appraisal: Appraisal;
  /** Subjective richness of the recollection (§5.3). */
  vividness: number;
  /** How strongly it is believed. Decays far slower than fidelity (§5.3). */
  confidence: number;
  /** How accurate it actually is. Drops with each reconstruction (§7.3). */
  fidelity: number;

  // --- retrieval structure ---
  actors: string[];
  place?: string;
  tags: string[];
  chapterId?: string;
  /** Partonomy parent: episode → arc → chapter (§1.2). */
  parentId?: string;

  // --- trauma / intrusion (§8) ---
  /** Fires involuntarily on sensory cue match, bypassing the threshold. */
  intrusive?: boolean;
  /** 0 free-floating sensory fragment … 1 fully bound to time/place/sequence. */
  contextBinding: number;

  /** Accumulated retrieval-induced suppression from competitors (§7.4). */
  suppressed: number;
  /**
   * Consolidation pass this trace was encoded on (`stats.updates` at the time).
   *
   * Drives engram maturation (`maturation.ts`). Absent on nodes written before
   * the field existed, which is read as "fully settled" — correct, because they
   * have been through every pass since.
   */
  encodedAtPass?: number;
  /**
   * Activation lost to near-twin memories blurring into this one
   * (`interference.ts`). Recomputed offline on maintenance passes and left
   * `undefined` when nothing is similar enough to interfere, so a graph of
   * distinct memories carries neither the penalty nor the bytes.
   */
  interference?: number;
  lastRetrievedAt?: number;
  status: MemoryStatus;

  /**
   * Fast synaptic dynamics: priming, habituation, stability and interference
   * noise (`synapse.ts`, docs/research/brain-integration-2026.md §B.2 #2–#4, #15–#16).
   *
   * Optional and lazily seeded at rest by `ensureSynapse`, so every brain already
   * on disk keeps loading and acquires the dynamics on its next pass instead of
   * being reset. A node with no synapse contributes exactly zero to activation,
   * which is what makes the existing ACT-R calibration still valid.
   */
  synapse?: SynapticState;

  /** User pinned this: exempt from fading and pruning. */
  pinned?: boolean;

  /**
   * When the character *believes* this happened, once temporal telescoping has
   * moved it (`reconstruction.ts`). Never used for decay — every activation
   * equation reads `encodedAt`, which stays true — only for how the memory is
   * narrated. Absent until the memory has actually drifted.
   */
  perceivedAt?: number;
  /**
   * Distortions this memory has accumulated, newest last (`reconstruction.ts`).
   *
   * Kept for the Mind page, where being able to see that a memory *has* drifted —
   * and how — is the difference between the character feeling unreliable and the
   * engine feeling buggy. Never composed into the prompt.
   */
  distortions?: Distortion[];

  /**
   * Why this is believed (`warrant.ts`, §B.2 #7).
   *
   * Present on schemas and semantics that were abstracted from episodes. When
   * the evidence fades or is contradicted, support drops and the belief can
   * collapse — that is the whole point of storing the warrant rather than
   * treating a schema as an unexamined fact.
   */
  warrant?: Warrant;

  // --- provenance ---
  sourceChatId?: string;
  sourceMessageIds?: string[];
  /** Which character's head this lives in (redundant with file, kept for exports). */
  characterId?: string;
}

// ---------- edges ----------

export type EdgeKind =
  | 'caused'
  | 'led_to'
  | 'contradicts'
  | 'reminds_of'
  | 'about_person'
  | 'at_place'
  | 'during'
  | 'instance_of'
  | 'co_occurred'
  | 'resolved'
  | 'broke_promise'
  | 'kept_promise'
  /** This belief was abstracted from that episode (§B.2 #7). */
  | 'derived_from'
  /** This action or belief was driven by that motive. */
  | 'motivated_by'
  /** This episode still underwrites that belief. */
  | 'supports'
  /** This account was taken over a competing one. */
  | 'chose_over';

export interface MemoryEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** 0..1, decays with disuse; drives spreading activation (§4.3). */
  weight: number;
  createdAt: number;
  note?: string;
}

// ---------- person models (§9.2) ----------

export interface RelationModel {
  /** Stable key (lowercased name or character id). */
  key: string;
  displayName: string;
  /** All -1..1 unless noted. */
  trust: number;
  affection: number;
  fear: number;
  respect: number;
  resentment: number;
  /** Net favours owed (+ they owe me, - I owe them). */
  debt: number;
  /** 0..1 — how well this character believes they know the other. */
  familiarity: number;
  /** Free-text working model — the story they tell about this person. */
  model: string;
  interactions: number;
  firstMetAt: number;
  lastSeenAt: number;
}

// ---------- self (§1.2, §9.3) ----------

export type TraitAxis =
  | 'warmth'
  | 'dominance'
  | 'volatility'
  | 'trust'
  | 'courage'
  | 'openness'
  | 'conscientiousness'
  | 'selfWorth';

export type TraitVector = Record<TraitAxis, number>;

export interface Goal {
  id: string;
  text: string;
  /** 0..1 how much of the working self this occupies */
  priority: number;
  status: 'active' | 'achieved' | 'abandoned' | 'blocked';
  createdAt: number;
  updatedAt: number;
}

export interface WorkingSelf {
  goals: Goal[];
  /** "I am someone who…" — biases retrieval and appraisal (§1.2). */
  selfImages: string[];
  /** Standing preoccupations that act as always-on retrieval cues. */
  concerns: string[];
}

/**
 * Why a belief is held, so it can collapse when its evidence does (§B.2 #7).
 *
 * Optional and lazily attached: brains written before this field existed keep
 * loading, and a schema without a warrant behaves exactly as it did — it just
 * cannot be unseated by the loss of the episodes that produced it.
 */
export interface Warrant {
  /** Plain-language reason, for the Mind page. Never composed as a hedge. */
  rationale: string;
  /** Node ids that currently underwrite this belief. */
  evidence: string[];
  /** Competing accounts that were considered and set aside. */
  alternatives?: string[];
  /**
   * 0..1 — derived from the strength of the evidence, not authored.
   * Recomputed on maintenance; a collapse here is what drops confidence.
   */
  support: number;
}

/**
 * One item in the within-scene buffer (`working.ts`, §B.2 #5).
 *
 * Not a MemoryNode: working memory is a volatile scratchpad, not a durable
 * trace. It is what the character is *holding right now*, and it evaporates
 * when the scene moves on. Capacity is Cowan's 4±1.
 */
export interface WorkingSlot {
  id: string;
  gist: string;
  actors: string[];
  heldAt: number;
  salience: number;
  /** If this slot is a live view of an encoded node. */
  nodeId?: string;
}

/** Lifetime period / arc — the top of the partonomy (§1.2). */
export interface Chapter {
  id: string;
  title: string;
  /** One-line thematic summary. */
  theme: string;
  startedAt: number;
  endedAt?: number;
  /** Aggregate emotional colour of the period. */
  tone: Affect;
  chatIds: string[];
}

// ---------- tunables ----------

/** ACT-R + forgetting parameters (§4.5, §12.1). All user-tunable. */
export interface BrainParams {
  /** d — base-level decay. ACT-R default 0.5. */
  decay: number;
  /** s — activation noise scale. */
  noise: number;
  /** τ — retrieval threshold. */
  threshold: number;
  /** S — maximum associative strength. */
  maxAssoc: number;
  /** W — total source activation shared among cues. */
  sourceActivation: number;
  /** P — mismatch penalty for partial matching. */
  mismatchPenalty: number;
  /** γ — emotional gain on permanent boost. */
  arousalGain: number;
  /** κ — extra boost from valence extremity. */
  valenceGain: number;
  /** f_v — verbatim decay exponent (must exceed gist decay). */
  verbatimDecay: number;
  /** Verbatim below this is dropped entirely. */
  verbatimFloor: number;
  /** λ — mood EMA rate per update. */
  moodInertia: number;
  /** η — trait drift rate per unit schema pressure. */
  driftRate: number;
  /** Maximum |trait − disposition| (§9.3). */
  maxDrift: number;
  /** Arousal above which encoding splits into a trauma S-rep (§8). */
  traumaArousal: number;
  /** δ — retrieval-induced suppression applied to unretrieved competitors (§7.4). */
  rifPenalty: number;
  /** Salience below which an event is never encoded at all (§2.2). */
  encodeThreshold: number;
  /** Similar episodics needed before a semantic node is derived (§7). */
  semanticiseAfter: number;
  /** Activation below which an active node becomes `faded`. */
  fadeBelow: number;
  /** Activation below which a faded node becomes `dormant`. */
  dormantBelow: number;
  /** Dormant, unboosted, prunable nodes are deleted below this. */
  pruneBelow: number;
  /** Cap on stored `uses` timestamps before switching to the approximation. */
  maxTraceHistory: number;
  /** Prediction error must exceed θ0 + θ1·strength + θ2·ln(ageDays) to rewrite (§6). */
  peBase: number;
  peStrengthWeight: number;
  peAgeWeight: number;
}

export interface BrainConfig {
  enabled: boolean;
  /** Run consolidation automatically after this many new messages. */
  updateEveryMessages: number;
  autoUpdate: boolean;
  /** Fraction of the model's usable context the brain may occupy. Hard cap 1/3. */
  shareOfContext: number;
  /** Allow trauma S-rep formation (§8). */
  traumaEnabled: boolean;
  /** Allow intrusive memories to surface unbidden (§8). */
  intrusionsEnabled: boolean;
  /**
   * How readily degraded memories drift into confident errors
   * (`reconstruction.ts`), 0..1. At 0 memory only ever fades and hedges, never
   * misremembers; at 1 it drifts at the full modelled rate.
   *
   * Exposed because it is a taste decision as much as a fidelity one: a
   * character who misremembers who said what is more human and harder to plot
   * around, and different stories want different amounts of that.
   */
  confabulation: number;
  params: BrainParams;
}

// ---------- the brain ----------

export interface BrainStats {
  totalEncoded: number;
  totalPruned: number;
  totalRecalls: number;
  updates: number;
  /**
   * Calibration of the character's own predictions about people
   * (`forecast.ts`). Only forecasts the scene actually *tested* are counted, so
   * a mind that never commits to anything scores nothing rather than scoring
   * perfectly.
   */
  forecastsTested?: number;
  forecastsHit?: number;
  lastUpdateAt?: number;
  /**
   * When the maintenance tail (verbatim fade, edge decay, drift, mood
   * regression) last ran.
   *
   * Separate from `lastUpdateAt` because maintenance models the passage of
   * *time*, while an update models the arrival of *events* — and a long
   * conversation is read as many chunks in quick succession, all of which are
   * one update each but together only one moment of elapsed time.
   */
  lastMaintenanceAt?: number;
  /**
   * When the idle mind last ticked (`mentation.ts`).
   *
   * Distinct from both of the above: consolidation models *events arriving* and
   * maintenance models *time passing*, while this models the character being
   * alone with their own head, which happens on its own schedule and produces
   * different changes than either.
   */
  lastMentationAt?: number;
  /** How many idle ticks have actually done something. */
  mentationTicks?: number;
  /** Messages consumed per source chat, so updates resume where they left off. */
  cursor: Record<string, number>;
  /**
   * Id of the last message consumed per source chat.
   *
   * The count alone is not a safe cursor: swipes, deletions, branch restores and
   * deep-swipe forks rewrite history, and a count left pointing past the end of
   * a shortened transcript blocks every future pass forever. The id is looked up
   * first and the count is only the fallback.
   */
  cursorMessageId?: Record<string, string>;
  /**
   * `revision` of the last consumed message, per source chat.
   *
   * A swipe, a Continue and an edit all rewrite a message *in place*, keeping
   * its id — so an id-only cursor reports "nothing new" forever and the
   * character is left remembering the version that was thrown away. Comparing
   * the revision is what reopens a message whose text changed under us.
   */
  cursorRevision?: Record<string, number>;
  /**
   * The last few consumed message ids, oldest first, per source chat.
   *
   * Used only when the anchor itself has been deleted. The stored *count* is a
   * poor fallback there: deleting a message shifts every later index down, so
   * resuming at the old number skips exactly one unread message, silently. The
   * newest surviving id in this trail gives an exact answer instead.
   */
  cursorTrail?: Record<string, string[]>;
}

export interface BrainState {
  version: 1;
  /**
   * A brain belongs to one conversation, not to a character in the abstract.
   * The same character in another chat is a different person with a different
   * history — they have not lived through what happened here.
   */
  chatId: string;
  characterId: string;
  characterName: string;
  createdAt: number;
  updatedAt: number;

  /** Card-derived anchor. Traits are bounded around this forever (§9.3). */
  disposition: TraitVector;
  /**
   * How the anchor was established. `none` means no baseline has been built yet
   * — traits sit at dead zero and the character has no temperament to drift
   * from, so this must be repaired before the brain means anything.
   * Tracked explicitly rather than inferred from "is any axis non-zero",
   * because a genuinely balanced character is a legitimate outcome.
   */
  dispositionSource: 'none' | 'lexicon' | 'model';
  traits: TraitVector;
  /** Diffuse background affect — slow EMA toward a dispositional baseline (§5.5). */
  mood: Affect;
  workingSelf: WorkingSelf;

  nodes: Record<string, MemoryNode>;
  edges: MemoryEdge[];
  people: Record<string, RelationModel>;
  chapters: Chapter[];

  /**
   * What the character is trying to do in the current scene (`volition.ts`).
   *
   * Distinct from `workingSelf.goals`, which are durable and abstract. This is
   * the dramatic objective — concrete, aimed at somebody, and on a timer. A
   * character with goals but no intention answers well and never pushes.
   */
  intention?: Intention;
  /**
   * An external nudge on what they reach for, with its own expiry. The hook a
   * story-direction feature steers through; it biases, it does not script.
   */
  steer?: SteeringDirective;

  /**
   * What they are holding in this scene (`working.ts`). Optional so brains
   * already on disk keep loading; seeded empty and filled on the next pass.
   */
  working?: WorkingSlot[];

  /**
   * Alias → canonical person key (`entities.ts`, §B.2 #33).
   *
   * "Wren" / "Miss Vale" / "she" must resolve to one person. Optional and
   * lazily grown: an empty table is the previous behaviour.
   */
  aliases?: Record<string, string>;

  /**
   * The mind that owns the memory (docs/research/psyche-architecture.md).
   *
   * Optional because every brain written before the psyche layer existed has to
   * keep loading; `normalizeBrain` seeds one from the character's temperament on
   * first read, so a pre-existing character acquires an inner life rather than
   * being reset.
   */
  psyche?: PsycheState;

  config: BrainConfig;
  stats: BrainStats;
  /**
   * The prediction this mind is currently exposed on (`forecast.ts`). Formed
   * before a turn, scored on the next consolidation pass, then spent.
   */
  forecast?: SceneForecast;
  /** The last time the world went against what they expected. */
  lastSurprise?: { note: string; surprise: number; at: number };
}

/**
 * A structural, scorable expectation — never generated prose.
 *
 * Both axes are signed and continuous so they can be scored against quantities
 * the appraisal already produces, rather than needing a matcher over labels.
 */
export interface SceneForecast {
  /** Who the stance prediction is about. Absent when nobody is known well enough. */
  target?: string;
  /** -1 expects to be hurt … +1 expects to be treated well. */
  stance: number;
  /** 0..1 — how exposed they are on this call. Familiarity is what buys it. */
  confidence: number;
  /** -1..1 — whether they expect their own objective to advance. */
  progress: number;
  /** The intention this was predicted under, so a changed objective is visible. */
  intentionId?: string;
  madeAt: number;
  /** Passes it may go untested before it lapses unscored. */
  ttl: number;
}

// ---------- retrieval ----------

/** Composite cue — encoding specificity demands more than "the last message" (§7.1). */
export interface RecallCue {
  text: string;
  actors: string[];
  place?: string;
  keywords: string[];
  /** Current mood, for mood-congruent retrieval (§5.5). */
  mood?: Affect;
  goals?: string[];
  now: number;
}

/** Full activation breakdown — surfaced in the UI so recall is explainable. */
export interface ActivationBreakdown {
  base: number;
  spreading: number;
  partialMatch: number;
  boost: number;
  suppression: number;
  moodCongruence: number;
  noise: number;
  /**
   * Short-term plasticity: positive when this trace is primed by recent use,
   * negative when it has been used so often it is depleted (`synapse.ts`).
   * Exactly zero for a node with no synaptic history.
   */
  availability: number;
  /**
   * Blur from near-duplicate memories (`interference.ts`) — always ≤ 0, and
   * exactly 0 for a memory with no near-twin.
   */
  interference: number;
  /**
   * Withheld from a trace that has not consolidated yet (`maturation.ts`) —
   * always ≤ 0, and exactly 0 once settled.
   */
  maturation: number;
  total: number;
}

export interface RecallHit {
  node: MemoryNode;
  activation: number;
  probability: number;
  breakdown: ActivationBreakdown;
  /** Fired involuntarily as a trauma intrusion rather than by ranked recall (§8). */
  intrusion: boolean;
}

export interface RecallResult {
  hits: RecallHit[];
  /** Same-cluster nodes that lost the competition — they get suppressed (§7.4). */
  competitors: string[];
  cue: RecallCue;
  /**
   * The cue index this recall ran against.
   *
   * Returned so the caller can hand it back to `applyRetrievalEffects` instead of
   * letting the effects run without one. That is not an optimisation: the
   * facilitation half of retrieval competition is guarded on having an index, so
   * a caller that recalls and then applies effects separately silently loses
   * priming altogether — remembering something made its neighbours harder to
   * reach and nothing easier, which is the opposite of the intended behaviour.
   *
   * Not serialised: it is a derived view of `nodes` and `edges`, rebuilt on load.
   */
  index: BrainIndex;
}

// ---------- consolidation I/O ----------

/**
 * One appraised event, as produced by the LLM encoder (or the heuristic
 * fallback). This is the only shape the encoder contract has to satisfy.
 */
export interface AppraisedEvent {
  gist: string;
  verbatim?: string;
  detail?: string;
  actors: string[];
  place?: string;
  tags: string[];
  appraisal: Appraisal;
  /** 0..1 — encoder's own view of how memorable this was. */
  salience: number;
  /** Existing node ids this event contradicts or extends (drives §6). */
  updates?: { nodeId: string; kind: 'contradicts' | 'extends'; newGist?: string }[];
  /** Causal/associative links to existing nodes. */
  links?: { nodeId: string; kind: EdgeKind }[];
  sourceMessageIds?: string[];
  /** Whether this is self-defining (§1.3). */
  identityRelevant?: boolean;
  /**
   * Other names the encoder recognised as the same person (§B.2 #33).
   * Learned into `brain.aliases` so later passes stop splitting them.
   */
  aliases?: { canonical: string; also: string[] }[];
  /**
   * How many affect-lexicon words the offline scorer actually recognised in this
   * stretch (`heuristics.ts`). Set only by the cheap path.
   *
   * This is the difference between "the scorer read this and judged it dull" and
   * "the scorer recognised nothing here" — which look identical in `salience`
   * and mean opposite things. The admission gate needs the distinction, because
   * a scene written without any of the lexicon's ~120 trigger words scores the
   * same 0.05 as genuine small talk, and dropping it is how memory stops forming
   * in exactly the prose that deserves it most.
   */
  lexiconHits?: number;
}

/** What one consolidation pass changed — mirrored into the audit log. */
export interface ConsolidationReport {
  encoded: string[];
  skipped: number;
  reconsolidated: string[];
  reconsolidationBlocked: { nodeId: string; pe: number; required: number }[];
  semanticised: string[];
  schemasFormed: string[];
  faded: string[];
  dormant: string[];
  pruned: string[];
  traumaFormed: string[];
  traitDrift: Partial<TraitVector>;
  moodBefore: Affect;
  moodAfter: Affect;
  peopleUpdated: string[];
  /** Set when this pass ended the character's current objective (`volition.ts`). */
  intentionResolved?: 'satisfied' | 'thwarted' | 'expired';
  /** What the goal curator changed, on maintenance passes. */
  goalReview?: GoalReview;
  at: number;
  /** Nodes whose activation now carries blur from a near-twin (`interference.ts`). */
  interfered?: number;
  /**
   * 0..1 — how far this stretch went against what the character predicted
   * (`forecast.ts`). Absent when no prediction was standing, or when the scene
   * never put the standing one to the test.
   */
  surprise?: number;
}
