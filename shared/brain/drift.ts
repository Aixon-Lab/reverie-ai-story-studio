/**
 * Closed-loop drift measurement (§3.7).
 *
 * Instruction-tuned models lose 20–40% of their persona consistency over ten to
 * fifteen turns, sliding along a well-documented "assistant axis" toward
 * agreeable, hedged, affectively flat prose. This engine spends real tokens on a
 * state block whose entire job is to stop that, and has never once checked
 * whether it works.
 *
 * ## The measurement is a comparison, not a classifier
 *
 * The naive version scores the character's output against their card and needs a
 * baseline, a model call, or an embedding — and a moving baseline is worse than
 * useless here, because it drifts along with the thing it is measuring.
 *
 * This engine can do something better, because it already knows what the
 * character is *supposed* to be showing. `express()` produces `shown` — the
 * affect that reaches the surface after regulation, suppression and defence have
 * taken their cut. So drift is the gap between what the psyche says is visible
 * and what the prose actually contains. Nothing else is needed:
 *
 *   - A character suppressing hard is *supposed* to read flat. `shown` is
 *     already near zero, the gap is near zero, and nothing is flagged. This is
 *     the property that makes the measure usable at all.
 *   - A character whose state says fury and whose last three turns contain no
 *     charged language at any point has drifted, and there is no reading of the
 *     psyche under which that is correct.
 *
 * Three signals, all local arithmetic over the same affect lexicon the encoder
 * uses, so the two halves are on one scale:
 *
 *   **flatness** — surface affect owed, minus surface affect delivered.
 *   **deference** — agreement and hedging markers, against how accommodating
 *     `stance.ts` says this character is willing to be. A warm, open character
 *     being agreeable is in character; a resentful, guarded one being agreeable
 *     is the assistant leaking through.
 *   **repetition** — turns collapsing toward each other, the attractor-state
 *     failure, which is the one that makes long sessions feel dead.
 *
 * ## What it is allowed to do about it
 *
 * Add one corrective line, naming the specific failure, only when there is one.
 * It deliberately does **not** shrink the block when drift is low, which the
 * original design proposed: the block is what prevents the drift, so shrinking
 * on a good reading and regrowing on a bad one is a feedback loop that
 * oscillates, and it would be measuring its own cure.
 *
 * Pure. No clock, no rng, no model.
 */
import { clamp01, similarity, tokenSet } from './activation';
import { AROUSAL_WORDS, VALENCE_WORDS, scoreLexicon } from './heuristics';

/** Turns of the character's own speech worth looking at. */
const WINDOW = 4;

/** Fewer than this and there is not enough output to judge. */
const MIN_TURNS = 3;

/** Below this, nothing is reported and nothing costs a token. */
export const DRIFT_FLOOR = 0.34;

/**
 * Markers of the agreeable-assistant register.
 *
 * Not "words a polite person uses" — words a *model* reaches for when it has
 * stopped playing somebody and started being helpful at you.
 */
const DEFERENCE_MARKERS = [
  'of course', 'certainly', 'absolutely', 'i understand', 'i completely understand',
  'you are right', "you're right", 'that makes sense', 'i apologize', 'i apologise',
  'i am sorry', "i'm sorry", 'happy to', 'let me know', 'if you would like',
  'if you like', 'whatever you', 'as you wish', 'i can help', 'feel free',
  'i appreciate', 'thank you for sharing', 'that is completely', "that's completely",
  'no problem', 'i just want to', 'i hope that helps',
];

const HEDGES = [
  'perhaps', 'maybe', 'possibly', 'somewhat', 'i think that', 'it seems',
  'i suppose', 'kind of', 'sort of', 'a little bit',
];

export interface DriftInput {
  /** The character's own recent turns, oldest first. */
  ownTurns: string[];
  /**
   * Arousal that should be reaching the surface right now — `shown.arousal` from
   * `express()`, *not* `felt`. A character holding it in owes nothing.
   */
  shownArousal: number;
  /** Signed surface valence owed, same source. */
  shownValence: number;
  /**
   * 0..1 from `stance.ts` — how forthcoming and agreeable this character is
   * willing to be. High openness makes deference expected rather than suspect.
   */
  openness: number;
}

export interface DriftReading {
  /** 0..1 — surface feeling owed but not delivered. */
  flatness: number;
  /** 0..1 — agreeable-assistant register beyond what the stance justifies. */
  deference: number;
  /** 0..1 — turns collapsing toward each other. */
  repetition: number;
  /** The worst of the three, which is what a corrective should address. */
  drift: number;
  /** The corrective line, or '' when the character is on-model. */
  line: string;
  /** For the inspector. */
  reasons: string[];
}

const ON_MODEL: DriftReading = {
  flatness: 0, deference: 0, repetition: 0, drift: 0, line: '', reasons: [],
};

/** Charged-language density in a stretch of the character's own prose. */
export function affectiveCharge(text: string): { arousal: number; valence: number } {
  const tokens = tokenSet(text);
  if (!tokens.size) return { arousal: 0, valence: 0 };
  const a = scoreLexicon(tokens, AROUSAL_WORDS);
  const v = scoreLexicon(tokens, VALENCE_WORDS);
  return {
    // Peak rather than mean: one genuinely charged word carries a whole turn,
    // which is how prose works and is not how an average works.
    arousal: clamp01(a.peak),
    valence: v.hits ? v.sum / v.hits : 0,
  };
}

/** How much of this reads as an assistant rather than a person. */
export function deferenceDensity(text: string): number {
  const hay = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  let hits = 0;
  for (const m of DEFERENCE_MARKERS) if (hay.includes(` ${m}`)) hits += 1;
  for (const h of HEDGES) if (hay.includes(` ${h} `)) hits += 0.5;
  // Two markers in a turn is already the register; five is not two and a half
  // times worse, it is the same failure.
  return clamp01(hits / 3);
}

export function measureDrift(input: DriftInput): DriftReading {
  const turns = input.ownTurns.map((t) => (t ?? '').trim()).filter(Boolean).slice(-WINDOW);
  if (turns.length < MIN_TURNS) return ON_MODEL;

  const reasons: string[] = [];

  /**
   * Flatness: owed minus delivered, across the whole window.
   *
   * The peak over recent turns is the right comparison — a character does not
   * have to be shouting in every sentence, but a genuinely activated one gets
   * charged *somewhere* in three turns. Scaled by what is owed, so a calm
   * character can never be flagged for being calm.
   */
  const owed = clamp01(input.shownArousal);
  const delivered = Math.max(...turns.map((t) => affectiveCharge(t).arousal));
  const flatness = clamp01((owed - delivered) / Math.max(0.2, owed)) * owed;
  if (flatness > 0.35) {
    reasons.push('the state says something is showing and the prose is not showing it');
  }

  /**
   * Deference beyond what the stance justifies.
   *
   * `openness` is the licence. A character who is warm and forthcoming toward
   * this person is *meant* to sound accommodating, and flagging that would be
   * flagging the character for being themselves.
   */
  const observed = Math.max(...turns.map(deferenceDensity));
  const licensed = clamp01(input.openness);
  const deference = clamp01(observed - licensed);
  if (deference > 0.3) reasons.push('the accommodating register has crept in past what they would actually offer');

  /** Repetition: consecutive turns collapsing toward each other. */
  let repetition = 0;
  for (let i = 1; i < turns.length; i++) {
    repetition = Math.max(repetition, similarity(turns[i], turns[i - 1]));
  }
  repetition = clamp01((repetition - 0.4) / 0.5);
  if (repetition > 0.4) reasons.push('the last few turns are circling the same shape');

  const drift = Math.max(flatness, deference, repetition);
  if (drift < DRIFT_FLOOR) return { ...ON_MODEL, flatness, deference, repetition, drift };

  return { flatness, deference, repetition, drift, line: correctionFor(flatness, deference, repetition), reasons };
}

/**
 * One line, addressing the worst of the three.
 *
 * Naming the specific failure matters. "Stay in character" is the instruction
 * every drifting model has already been given and is already ignoring; "you have
 * been agreeing for three turns and this person has not earned that" is
 * something a model can act on.
 */
function correctionFor(flatness: number, deference: number, repetition: number): string {
  const worst = Math.max(flatness, deference, repetition);
  if (worst === deference) {
    return 'DRIFT: the last few turns have slid into an accommodating, helpful register that '
      + 'this character has not earned and would not offer. No smoothing, no apologising for '
      + 'having a position, no offering to help. Answer as them.';
  }
  if (worst === repetition) {
    return 'DRIFT: the last few turns are circling the same shape. Say something this scene '
      + 'has not already said, or let them do something instead of saying anything.';
  }
  return 'DRIFT: their state says something is reaching the surface and the last few turns have '
    + 'read flat. Whatever is showing should be *in* the prose — in what they do, what they '
    + 'refuse to do, how the sentences land — not summarised.';
}
