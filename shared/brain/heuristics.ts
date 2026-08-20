/**
 * Offline fallback encoder.
 *
 * When the utility model is unreachable (no key, rate limit, provider down),
 * the brain still has to grow — a memory system that stops working when the
 * network hiccups is not a memory system. This module does boundary
 * segmentation plus lexicon-based appraisal: much coarser than the LLM path,
 * but it produces the same `AppraisedEvent` shape, so everything downstream is
 * identical.
 */
import { clamp01, clampSigned, tokenSet } from './activation';
import type { AppraisedEvent } from './types';

export interface TranscriptTurn {
  id: string;
  speaker: string;
  text: string;
  isUser: boolean;
}

/** Words that mark a change of scene, place or time — real event boundaries (§2.2). */
const BOUNDARY_CUES = [
  'later', 'afterward', 'afterwards', 'the next', 'meanwhile', 'hours pass', 'days later',
  'suddenly', 'then', 'outside', 'inside', 'they arrive', 'she arrives', 'he arrives',
  'the door', 'they leave', 'morning', 'evening', 'night falls', 'dawn',
];

const AROUSAL_WORDS: Record<string, number> = {
  scream: 0.9, screamed: 0.9, screaming: 0.9, terror: 0.95, terrified: 0.9, panic: 0.85,
  blood: 0.8, kill: 0.85, killed: 0.9, died: 0.9, death: 0.85, dying: 0.9,
  rage: 0.85, furious: 0.8, fury: 0.85, attack: 0.8, attacked: 0.85, weapon: 0.7,
  betray: 0.85, betrayed: 0.9, betrayal: 0.9, lied: 0.6, lie: 0.55,
  love: 0.7, kiss: 0.65, kissed: 0.7, desperate: 0.75, sobbing: 0.8, crying: 0.7,
  fight: 0.75, fought: 0.75, explosion: 0.9, fire: 0.7, escape: 0.7, trapped: 0.8,
  promise: 0.6, promised: 0.65, secret: 0.6, confess: 0.7, confessed: 0.75,
  shock: 0.75, shocked: 0.75, horror: 0.9, wound: 0.75, wounded: 0.8, scar: 0.6,
  saved: 0.7, rescue: 0.75, rescued: 0.8, goodbye: 0.65, forever: 0.55,
};

const VALENCE_WORDS: Record<string, number> = {
  love: 0.8, loved: 0.8, kind: 0.5, gentle: 0.5, safe: 0.6, warm: 0.5, laugh: 0.6,
  laughed: 0.6, smile: 0.5, smiled: 0.5, thank: 0.5, saved: 0.7, rescued: 0.7,
  beautiful: 0.5, hope: 0.5, forgive: 0.6, forgiven: 0.7, home: 0.4, together: 0.4,
  hate: -0.8, hated: -0.8, cruel: -0.7, kill: -0.7, killed: -0.85, died: -0.8,
  death: -0.7, blood: -0.5, betrayed: -0.9, betrayal: -0.9, lied: -0.6, lie: -0.5,
  pain: -0.7, hurt: -0.6, afraid: -0.6, terrified: -0.8, alone: -0.5, lost: -0.5,
  fail: -0.6, failed: -0.65, shame: -0.7, ashamed: -0.7, guilt: -0.7, sorry: -0.3,
  wound: -0.6, wounded: -0.65, trapped: -0.7, scream: -0.7, horror: -0.85,
};

const POWER_WORDS: Record<string, number> = {
  helpless: -0.8, powerless: -0.85, trapped: -0.7, pinned: -0.6, begged: -0.7,
  couldnt: -0.4, overwhelmed: -0.7, forced: -0.6, dragged: -0.6,
  seized: 0.5, commanded: 0.7, ordered: 0.6, won: 0.7, defeated: 0.7, refused: 0.5,
  stood: 0.4, fought: 0.4, stopped: 0.4, saved: 0.6, protected: 0.6,
};

const NORM_WORDS: Record<string, number> = {
  betrayed: -0.85, lied: -0.7, cheated: -0.8, stole: -0.75, murdered: -0.9,
  broke: -0.4, abandoned: -0.7, cruel: -0.7, unfair: -0.6,
  promised: 0.5, kept: 0.4, honest: 0.6, protected: 0.6, defended: 0.6, honored: 0.7,
  apologised: 0.4, apologized: 0.4, forgave: 0.6,
};

/** Split a run of turns into candidate events at perceived boundaries. */
export function segmentTurns(turns: TranscriptTurn[], maxTurnsPerEvent = 5): TranscriptTurn[][] {
  const out: TranscriptTurn[][] = [];
  let current: TranscriptTurn[] = [];

  for (const turn of turns) {
    const lower = turn.text.toLowerCase();
    const boundary = current.length > 0 && BOUNDARY_CUES.some((c) => lower.includes(c));
    if (boundary || current.length >= maxTurnsPerEvent) {
      if (current.length) out.push(current);
      current = [];
    }
    current.push(turn);
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Elaboration, for a stretch the affect lexicon had nothing to say about.
 *
 * §2.1 lists elaboration alongside arousal and goal relevance as an encoding
 * determinant, but offline it was the one determinant with no estimator: when
 * none of the ~120 trigger words appeared, arousal, valence and norms were all
 * exactly zero and the score collapsed to a constant 0.05 — below
 * `encodeThreshold`, so the offline encoder could not encode a scene it had no
 * vocabulary for, however much happened in it. That is most literary prose.
 *
 * Distinct content words are the crudest honest proxy for "how much there is
 * here to encode", and crude is the whole contract of this module. It is
 * deliberately capped well under `ADMIT_BAND`: substance alone is never
 * evidence that something was *memorable*, only that it was not nothing, so a
 * dense stretch still gets read by the model rather than admitted on its own.
 */
export function elaborationSalience(contentWords: number): number {
  const MIN_WORDS = 6; // below this `heuristicEncodeSegment` refuses outright
  const SPAN = 70;     // content words to reach the ceiling
  const CEILING = 0.45;
  return clamp01(Math.min(CEILING, Math.max(0, (contentWords - MIN_WORDS) / SPAN)));
}

function scoreLexicon(tokens: Set<string>, lexicon: Record<string, number>): { sum: number; hits: number; peak: number } {
  let sum = 0, hits = 0, peak = 0;
  for (const t of tokens) {
    const v = lexicon[t];
    if (v === undefined) continue;
    sum += v;
    hits++;
    if (Math.abs(v) > Math.abs(peak)) peak = v;
  }
  return { sum, hits, peak };
}

/**
 * Turn one segment into an appraised event.
 * Coarse by design — the point is that the brain keeps growing offline.
 */
export function heuristicEncodeSegment(
  segment: TranscriptTurn[],
  selfName: string,
): AppraisedEvent | null {
  const text = segment.map((t) => `${t.speaker}: ${t.text}`).join('\n');
  const tokens = tokenSet(text);
  if (tokens.size < 6) return null;

  const arousalHits = scoreLexicon(tokens, AROUSAL_WORDS);
  const valenceHits = scoreLexicon(tokens, VALENCE_WORDS);
  const powerHits = scoreLexicon(tokens, POWER_WORDS);
  const normHits = scoreLexicon(tokens, NORM_WORDS);

  const arousal = clamp01(arousalHits.hits ? Math.max(arousalHits.peak, arousalHits.sum / (arousalHits.hits * 1.6)) : 0);
  const valence = clampSigned(valenceHits.hits ? valenceHits.sum / Math.max(1, valenceHits.hits * 1.3) : 0);
  const power = clamp01(0.5 + (powerHits.hits ? powerHits.sum / (powerHits.hits * 2) : 0));

  // Who acted? If the other side of the conversation carried the loaded words,
  // attribute agency to them.
  const otherSpeakers = [...new Set(segment.filter((t) => t.speaker !== selfName).map((t) => t.speaker))];
  const selfSpoke = segment.some((t) => t.speaker === selfName);
  const agency: AppraisedEvent['appraisal']['agency'] =
    otherSpeakers.length && Math.abs(valence) > 0.2 ? 'other' : selfSpoke ? 'self' : 'circumstance';

  const loaded = arousalHits.hits + valenceHits.hits + normHits.hits + powerHits.hits;
  /**
   * With a silent lexicon every affect term below is exactly zero by
   * construction, so the old expression was the constant 0.05 — an unencodable
   * score for any scene written without a trigger word. Fall back to how much
   * substance is here instead. Scoped to `loaded === 0` on purpose: it cannot
   * change a single stretch the lexicon did have something to say about.
   */
  const salience = loaded === 0
    ? elaborationSalience(tokens.size)
    : clamp01(
      0.12 + 0.45 * arousal + 0.25 * Math.abs(valence) + 0.10 * clamp01(normHits.hits / 2),
    );

  const gist = summarize(segment, selfName);
  if (!gist) return null;

  const striking = segment
    .map((t) => t.text.trim())
    .filter((t) => t.length > 24 && t.length < 220)
    .sort((a, b) => scoreLexicon(tokenSet(b), AROUSAL_WORDS).sum - scoreLexicon(tokenSet(a), AROUSAL_WORDS).sum)[0];

  return {
    gist,
    verbatim: arousal > 0.55 && striking ? striking : undefined,
    actors: otherSpeakers,
    tags: [...tokens].filter((t) => AROUSAL_WORDS[t] || VALENCE_WORDS[t]).slice(0, 8),
    appraisal: {
      novelty: clamp01(0.25 + 0.4 * arousal),
      pleasantness: clampSigned(valence * 0.8),
      goalRelevance: clamp01(0.2 + 0.5 * Math.abs(valence) + 0.2 * arousal),
      goalConduciveness: valence,
      agency,
      intent: agency === 'other' ? clampSigned(valence) : 0,
      copingPotential: power,
      norms: clampSigned(normHits.hits ? normHits.sum / Math.max(1, normHits.hits) : 0),
      urgency: clamp01(arousal * 0.8),
    },
    salience,
    // What the lexicon actually recognised. A zero here means this score is an
    // absence of evidence, not evidence of absence — see `admission.ts`.
    lexiconHits: loaded,
    sourceMessageIds: segment.map((t) => t.id),
    identityRelevant: false,
  };
}

/** First-pass gist: the most content-dense line, attributed. */
function summarize(segment: TranscriptTurn[], selfName: string): string {
  const best = segment
    .map((t) => ({ t, score: tokenSet(t.text).size }))
    .sort((a, b) => b.score - a.score)[0];
  // Roleplay lines are short; two content words is already a real beat.
  if (!best || best.score < 2) return '';
  const line = best.t.text.replace(/\s+/g, ' ').trim().slice(0, 220);
  const who = best.t.speaker === selfName ? `${selfName}` : best.t.speaker;
  return `${who}: ${line}`;
}

export function heuristicEncode(turns: TranscriptTurn[], selfName: string): AppraisedEvent[] {
  const out: AppraisedEvent[] = [];
  for (const segment of segmentTurns(turns)) {
    const event = heuristicEncodeSegment(segment, selfName);
    if (event) out.push(event);
  }
  return out;
}
