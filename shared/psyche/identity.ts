/**
 * Narrative identity (§P.6.2).
 *
 * Conway's self-memory system pairs an autobiographical knowledge base with a
 * *working self* whose goals decide what gets retrieved; McAdams adds that the
 * life story is organised into arcs, and that redemption sequences (bad leading
 * to good) versus contamination sequences (good ruined by bad) are the structural
 * signature of how a person understands their own life.
 *
 * v1 had chapters with titles. This adds the two things that make a life story
 * mean something:
 *
 * 1. **Arc classification** — each chapter is redemption, contamination, stable or
 *    unresolved, derived from the affective trajectory of what happened in it.
 * 2. **A structured self-concept** — self-images with a valence and links to the
 *    memories that are their evidence. This is what makes "negative self-concept"
 *    a measurement rather than an assertion, and what lets a single powerful
 *    counter-example be pointed at the specific belief it contradicts.
 */
import { clamp01, clampSigned } from './defaults';
import { similarity, baseLevel } from '../brain/activation';
import type { BrainParams, Chapter, MemoryNode } from '../brain/types';

export type ArcKind = 'redemption' | 'contamination' | 'stable' | 'unresolved';

export interface ChapterArc {
  chapterId: string;
  title: string;
  kind: ArcKind;
  /** Affective slope across the chapter: negative → things got worse. */
  slope: number;
  /** How coherent the chapter is as a story, 0..1. */
  coherence: number;
  /** One line, written the way the character would tell it. */
  telling: string;
}

/**
 * Classify one chapter from the memories that belong to it.
 *
 * The arc is the *slope*, not the average: a chapter that starts in horror and
 * ends in safety is redemption even if most of it was terrible, and that is
 * exactly the distinction McAdams's redemption sequence captures.
 */
export function classifyChapter(
  chapter: Chapter,
  nodes: MemoryNode[],
  now: number,
  params: BrainParams,
): ChapterArc {
  const own = nodes
    .filter((n) => n.chapterId === chapter.id)
    .sort((a, b) => a.encodedAt - b.encodedAt);

  if (own.length < 2) {
    return {
      chapterId: chapter.id,
      title: chapter.title,
      kind: 'unresolved',
      slope: 0,
      coherence: 0,
      telling: `${chapter.title} — too little happened to say what it meant yet`,
    };
  }

  const half = Math.floor(own.length / 2);
  const early = mean(own.slice(0, half).map((n) => n.affect.valence));
  const late = mean(own.slice(-half).map((n) => n.affect.valence));
  const slope = clampSigned(late - early);

  // Coherence: are the memories in this chapter *about* each other, or is it just
  // a run of unrelated events? Low coherence is what an unintegrated period looks
  // like from the inside.
  const coherence = clamp01(meanPairSimilarity(own.slice(0, 12)) * 2);

  let kind: ArcKind;
  if (Math.abs(slope) < 0.25) {
    kind = coherence < 0.3 ? 'unresolved' : 'stable';
  } else if (slope > 0) {
    kind = 'redemption';
  } else {
    kind = 'contamination';
  }

  // Weak, low-strength chapters that never resolved read as unresolved regardless
  // of slope — the story has not finished being told.
  const strength = mean(own.map((n) => Math.max(0, baseLevel(n, now, params)) + n.permanentBoost));
  if (kind !== 'stable' && strength < 0.3 && !chapter.endedAt) kind = 'unresolved';

  return { chapterId: chapter.id, title: chapter.title, kind, slope, coherence, telling: tell(chapter.title, kind, slope) };
}

function tell(title: string, kind: ArcKind, slope: number): string {
  switch (kind) {
    case 'redemption':
      return `${title} — it started badly and they came out of it ${slope > 0.6 ? 'genuinely better' : 'somewhat better'} than they went in`;
    case 'contamination':
      return `${title} — it was fine, and then it was not, and that is how they tell it`;
    case 'stable':
      return `${title} — a stretch that was what it was, start to finish`;
    default:
      return `${title} — still open; they have not worked out what it meant`;
  }
}

// ---------- self-concept ----------

export interface SelfImage {
  id: string;
  /** "Someone who…" — third person about the character. */
  text: string;
  /** -1 damning … +1 affirming. */
  valence: number;
  /** 0..1 how firmly held. */
  conviction: number;
  /** Node ids that are the evidence for it. */
  evidence: string[];
  /** Node ids that contradict it and have not yet been absorbed. */
  counterEvidence: string[];
  /**
   * `belief` is an induced generalisation about the self and can be read as a
   * statement ("she is something people use"). `episode` is a self-defining
   * *event* and cannot: rendering one after "she takes herself to be" produced
   * sentences like "Wren takes themselves to be Rooke forced Wren to choose...".
   */
  kind: 'belief' | 'episode';
  formedAt: number;
  updatedAt: number;
}

export interface SelfConcept {
  images: SelfImage[];
  /** Σ negative conviction ÷ total — the DSO negative-self-concept measure. */
  negativity: number;
  /** How consistent the self-images are with one another, 0..1. */
  coherence: number;
}

/**
 * Build the self-concept from identity and schema nodes.
 *
 * Evidence links matter more than the count: a belief held on the strength of one
 * terrible night is different from the same belief held on the strength of a
 * decade, and only the second is hard to shift.
 */
export function buildSelfConcept(
  nodes: MemoryNode[],
  characterName: string,
  now: number,
  params: BrainParams,
): SelfConcept {
  const selfNodes = nodes.filter(
    (n) => (n.kind === 'identity' || n.kind === 'schema') && n.status !== 'dormant',
  );

  const images: SelfImage[] = selfNodes.map((n) => {
    const strength = Math.max(0, baseLevel(n, now, params)) + n.permanentBoost;
    const evidence = nodes
      .filter((e) => e.id !== n.id && e.kind === 'episodic' && similarity(e.gist, n.gist) > 0.4)
      .map((e) => e.id)
      .slice(0, 8);
    // A memory whose feeling runs opposite to the belief is a live contradiction
    // the character has not absorbed yet.
    const counter = nodes
      .filter((e) => e.id !== n.id
        && e.kind === 'episodic'
        && similarity(e.gist, n.gist) > 0.3
        && Math.sign(e.affect.valence) === -Math.sign(n.affect.valence)
        && Math.abs(e.affect.valence) > 0.35)
      .map((e) => e.id)
      .slice(0, 6);

    return {
      id: n.id,
      kind: n.kind === 'schema' ? 'belief' : 'episode',
      text: n.gist,
      valence: n.affect.valence,
      conviction: clamp01(0.4 + 0.15 * strength + 0.05 * evidence.length - 0.06 * counter.length),
      evidence,
      counterEvidence: counter,
      formedAt: n.encodedAt,
      updatedAt: n.lastRetrievedAt ?? n.encodedAt,
    };
  });

  let neg = 0;
  let pos = 0;
  for (const im of images) {
    if (im.valence < -0.1) neg += im.conviction * Math.abs(im.valence);
    else if (im.valence > 0.1) pos += im.conviction * im.valence;
  }
  const total = neg + pos;

  return {
    images: images.sort((a, b) => b.conviction - a.conviction),
    negativity: total > 0 ? clamp01(neg / total) : 0,
    coherence: clamp01(1 - variance(images.map((i) => i.valence))),
  };
}

/**
 * The belief a piece of counter-evidence is aimed at.
 *
 * This is what lets a scene *land*: when something happens that contradicts what
 * a character believes about themselves, the system can name the exact belief it
 * threatens, and the reconsolidation gate (§M.6) decides whether it gets through.
 */
export function threatenedBelief(concept: SelfConcept, eventGist: string, eventValence: number): SelfImage | null {
  let best: SelfImage | null = null;
  let bestScore = 0;
  for (const im of concept.images) {
    if (Math.sign(im.valence) === Math.sign(eventValence)) continue;
    const s = similarity(eventGist, im.text);
    if (s > bestScore) { bestScore = s; best = im; }
  }
  /**
   * 0.22 rather than something tighter: gist similarity is token overlap over
   * short natural sentences, and a genuine contradiction is usually phrased in
   * different words from the belief it undermines ("someone treated her as more
   * than a thing" versus "she is something people use"). A high bar here means
   * the most dramatically useful moments are the ones the system misses.
   */
  return bestScore > 0.22 ? best : null;
}

/**
 * How the character would summarise who they are.
 *
 * Beliefs and formative episodes are rendered separately because only one of
 * them is a sentence about the self. An episode is what happened; the belief is
 * what they concluded from it, and only the conclusion can follow "takes
 * themselves to be".
 */
export function describeSelfConcept(concept: SelfConcept, name: string): string {
  if (!concept.images.length) return '';

  const beliefs = concept.images.filter((i) => i.kind === 'belief');
  const episodes = concept.images.filter((i) => i.kind === 'episode');
  const parts: string[] = [];

  const damning = beliefs.filter((i) => i.valence < -0.2).slice(0, 2);
  const affirming = beliefs.filter((i) => i.valence > 0.2).slice(0, 2);

  if (damning.length) {
    parts.push(`${name} takes themselves to be ${damning.map((i) => strip(i.text)).join('; ')}`);
  }
  if (affirming.length) {
    parts.push(`${damning.length ? 'they also hold on to' : `${name} holds on to`} being ${affirming.map((i) => strip(i.text)).join('; ')}`);
  }
  if (beliefs.length && concept.negativity > 0.7 && !affirming.length) {
    parts.push('there is nothing on the other side of the ledger');
  }

  // Formative episodes are quoted as events, never folded into a sentence about
  // what the character *is* - they are what happened, not what it meant.
  const formative = episodes.slice(0, 2).map((i) => strip(i.text));
  if (formative.length) {
    parts.push(`what shaped that: ${formative.join('; ')}`);
  }

  // An unabsorbed contradiction is the most dramatically useful thing here: it is
  // the pressure point a scene can push on.
  const live = beliefs.find((i) => i.counterEvidence.length >= 2 && i.valence < -0.2);
  if (live) {
    parts.push(`something in them knows "${strip(live.text)}" does not quite fit the evidence, and they are not looking at that`);
  }

  // Sentence-case each clause: they are assembled independently, and a lowercase
  // fragment after a full stop reads as a rendering bug.
  return parts.map(sentence).join(' ');
}

function sentence(text: string): string {
  const t = text.trim();
  if (!t) return '';
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
}

/** Trim to a clause that can sit inside a longer sentence. */
function strip(text: string): string {
  const t = text
    .replace(/^(she|he|they)\s+(is|are)\s+/i, '')
    .replace(/[.;]\s*$/, '')
    .trim();
  return t.length > 90 ? `${t.slice(0, 89).replace(/[\s,;:]+\S*$/, '')}...` : t;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) * (x - m)));
}

function meanPairSimilarity(nodes: MemoryNode[]): number {
  if (nodes.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      sum += similarity(nodes[i].gist, nodes[j].gist);
      count++;
    }
  }
  return count ? sum / count : 0;
}

/** Life-story summary line for the Mind page. */
export function describeLifeStory(arcs: ChapterArc[]): string {
  if (!arcs.length) return 'no story yet';
  const counts = arcs.reduce((acc, a) => ({ ...acc, [a.kind]: (acc[a.kind] ?? 0) + 1 }), {} as Record<ArcKind, number>);
  const dominant = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? ['unresolved'])[0] as ArcKind;
  switch (dominant) {
    case 'redemption': return 'a life they tell as having come through things';
    case 'contamination': return 'a life they tell as a series of good things being ruined';
    case 'stable': return 'a life they tell as having been mostly one way';
    default: return 'a life they have not finished making sense of';
  }
}
