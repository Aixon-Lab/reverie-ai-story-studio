/**
 * Default brain parameters and state factories.
 *
 * Parameter values follow ACT-R conventions where one exists (§4.5); the rest
 * were chosen so that a memory encoded with ordinary salience and no repetition
 * fades below the retrieval threshold in roughly two to three weeks of real
 * time, while a high-arousal formative event stays retrievable for years —
 * the human ratio the dossier describes.
 */
import { emptyPsyche, normalizePsyche } from '../psyche/defaults';
import type {
  Affect, BrainConfig, BrainParams, BrainState, TraitAxis, TraitVector,
} from './types';

/** Base time unit for all decay math: one day in milliseconds. */
export const TIME_UNIT_MS = 86_400_000;

/**
 * Minimum age (in TIME_UNIT) used in t^-d. Without a floor, an event recalled in
 * the same instant it happened yields infinite activation. ~15 minutes.
 */
export const MIN_AGE = 0.01;

export const TRAIT_AXES: TraitAxis[] = [
  'warmth', 'dominance', 'volatility', 'trust',
  'courage', 'openness', 'conscientiousness', 'selfWorth',
];

export const DEFAULT_PARAMS: BrainParams = {
  decay: 0.5,               // ACT-R default d
  noise: 0.25,              // s — retrieval is stochastic but not chaotic
  threshold: -1.0,          // τ — accessibility floor
  maxAssoc: 2.0,            // S
  sourceActivation: 1.0,    // W
  mismatchPenalty: 1.0,     // P
  arousalGain: 1.6,         // γ — arousal → permanent boost (§5.1)
  valenceGain: 0.4,         // κ — extremity of feeling adds durability
  verbatimDecay: 1.6,       // f_v ≫ gist decay: exact wording goes first (§7.3)
  verbatimFloor: 0.18,
  moodInertia: 0.35,        // λ — mood follows emotion with lag (§5.5)
  driftRate: 0.35,         // η — personality moves slowly (§9.3)
  maxDrift: 0.45,           // a character never stops being themselves
  traumaArousal: 0.86,      // above this, encoding splits (§8)
  rifPenalty: 0.08,         // δ — competitors quietly fade (§7.4)
  // Most of experience is never encoded (§2.2) — but the gate must agree with
  // the scale the encoder prompt is given, or "ordinary but real" beats get
  // proposed and then silently thrown away, leaving a near-empty network.
  encodeThreshold: 0.15,
  semanticiseAfter: 3,      // k similar episodes → a gist that outlives them (§7)
  fadeBelow: -0.6,
  dormantBelow: -1.8,
  pruneBelow: -4.5,
  maxTraceHistory: 64,
  peBase: 0.30,             // §6 reconsolidation gate
  peStrengthWeight: 0.10,
  peAgeWeight: 0.06,
};

/** Hard ceiling on how much of the model context the brain may ever occupy. */
export const MAX_BRAIN_SHARE = 1 / 3;

export const DEFAULT_CONFIG: BrainConfig = {
  enabled: true,
  updateEveryMessages: 6,
  autoUpdate: true,
  shareOfContext: MAX_BRAIN_SHARE,
  traumaEnabled: true,
  intrusionsEnabled: true,
  /**
   * Half the modelled rate by default.
   *
   * The mechanism is right at 1, but a character who misremembers who said what
   * is genuinely harder to write around, and a default should not surprise
   * someone who never asked for it. At 0.5 drift is rare enough to read as
   * humanity and frequent enough to be felt over a long story.
   */
  confabulation: 0.5,
  params: { ...DEFAULT_PARAMS },
};

export function neutralAffect(): Affect {
  return { valence: 0, arousal: 0.1, dominance: 0, label: 'neutral' };
}

export function neutralTraits(): TraitVector {
  return {
    warmth: 0, dominance: 0, volatility: 0, trust: 0,
    courage: 0, openness: 0, conscientiousness: 0, selfWorth: 0,
  };
}

export function emptyBrain(
  chatId: string,
  characterId: string,
  characterName: string,
  now = Date.now(),
): BrainState {
  return {
    version: 1,
    chatId,
    characterId,
    characterName,
    createdAt: now,
    updatedAt: now,
    disposition: neutralTraits(),
    dispositionSource: 'none',
    traits: neutralTraits(),
    mood: neutralAffect(),
    workingSelf: { goals: [], selfImages: [], concerns: [] },
    nodes: {},
    edges: [],
    people: {},
    chapters: [],
    config: { ...DEFAULT_CONFIG, params: { ...DEFAULT_PARAMS } },
    stats: {
      totalEncoded: 0, totalPruned: 0, totalRecalls: 0, updates: 0, cursor: {}, cursorMessageId: {},
    },
    psyche: emptyPsyche(neutralTraits(), now),
  };
}

/**
 * Superseded defaults, by axis.
 *
 * Stored params win over defaults, which is right when the user tuned them and
 * wrong when the shipped value was simply mis-calibrated: a brain saved with the
 * old number keeps it forever and never benefits from the fix. Each entry here is
 * a value that was a *default* and is now known to be wrong, so a brain still
 * carrying it exactly is migrated; anything else is treated as deliberate and
 * left alone.
 */
const SUPERSEDED_PARAMS: Partial<Record<keyof BrainParams, number[]>> = {
  // 0.035 shrank every trait pressure by ~30x on top of pressures that were
  // already scaled small, so a betrayal moved trust by 0.002 — invisible.
  driftRate: [0.035],
  // 0.22 pre-dated the encoder prompt's stated salience scale.
  encodeThreshold: [0.22],
};

/**
 * Drop a relationship the character has with themselves (see `isSelf`).
 *
 * Exact name only, deliberately. `isSelf` also matches on a first or last name,
 * because an encoder told the character is "Scarlet Wren" will write the actor as
 * "Wren" — but that guess belongs at *write* time, where the cast is known and a
 * real NPC called Wren can be recognised as somebody else. Applying it here, on
 * every load, silently and permanently deleted that NPC's entire relationship
 * record. This runs against data that already exists, so it only removes what is
 * unambiguously the character themselves.
 */
function stripSelfRelation(
  people: BrainState['people'] | undefined,
  characterName: string,
): BrainState['people'] {
  if (!people) return {};
  const self = characterName.trim().toLowerCase();
  if (!self) return people;
  const out: BrainState['people'] = {};
  for (const [key, rel] of Object.entries(people)) {
    if (key.trim().toLowerCase() === self) continue;
    out[key] = rel;
  }
  return out;
}

function migrateParams(stored?: Partial<BrainParams>): BrainParams {
  const params: BrainParams = { ...DEFAULT_PARAMS, ...(stored ?? {}) };
  for (const [key, legacy] of Object.entries(SUPERSEDED_PARAMS) as [keyof BrainParams, number[]][]) {
    if (legacy.includes(params[key])) params[key] = DEFAULT_PARAMS[key];
  }
  return params;
}

/** Fill in anything a stored brain is missing after a version upgrade. */
export function normalizeBrain(
  raw: Partial<BrainState>,
  chatId: string,
  characterId: string,
  characterName: string,
): BrainState {
  const base = emptyBrain(chatId, characterId, raw.characterName || characterName, raw.createdAt);
  return {
    ...base,
    ...raw,
    version: 1,
    chatId,
    characterId,
    characterName: raw.characterName || characterName,
    disposition: { ...base.disposition, ...(raw.disposition ?? {}) },
    // Brains written before this field existed: infer from the anchor itself.
    dispositionSource: raw.dispositionSource
      ?? (Object.values(raw.disposition ?? {}).some((v) => v !== 0) ? 'lexicon' : 'none'),
    traits: { ...base.traits, ...(raw.traits ?? {}) },
    mood: { ...base.mood, ...(raw.mood ?? {}) },
    workingSelf: {
      goals: raw.workingSelf?.goals ?? [],
      selfImages: raw.workingSelf?.selfImages ?? [],
      concerns: raw.workingSelf?.concerns ?? [],
    },
    nodes: raw.nodes ?? {},
    edges: raw.edges ?? [],
    // Strip any self-relation an older pass recorded. A character listing
    // themselves among the people they know is always a bug, and it is cheaper to
    // heal on load than to leave in every brain already on disk.
    people: stripSelfRelation(raw.people, raw.characterName || characterName),
    chapters: raw.chapters ?? [],
    working: raw.working ?? [],
    aliases: raw.aliases ?? {},
    config: {
      ...base.config,
      ...(raw.config ?? {}),
      params: migrateParams(raw.config?.params),
    },
    stats: {
      ...base.stats,
      ...(raw.stats ?? {}),
      cursor: raw.stats?.cursor ?? {},
      cursorMessageId: raw.stats?.cursorMessageId ?? {},
    },
    /**
     * A brain written before the psyche existed gets one seeded from the traits
     * it has already earned — so an established character acquires an inner life
     * consistent with who they have become, rather than starting over as a
     * stranger.
     */
    psyche: normalizePsyche(raw.psyche, raw.traits ?? raw.disposition),
  };
}
