/**
 * Theory of mind (§N.2.1) — what the character believes *other people* know.
 *
 * This is the largest realism gap in the system, and it is not an LLM limitation:
 * it is a state we never tracked. Without it a character reveals a secret to
 * someone who was never told, answers a question the other person has no reason
 * to have asked, or fails to notice they are being lied to — the failures that
 * break a scene faster than any prose problem.
 *
 * The ToM literature is clear that models handle clean belief puzzles and then
 * collapse under perturbation, with the bottleneck at converting *what an actor
 * perceived* into *what they now believe*. So we do not ask the model to reason
 * about it per turn. We track it, the same way we track memory: an event happened,
 * these people were present, therefore these people know it — and everyone else
 * does not, until told.
 *
 * Deliberately first-order plus a shallow second order. "I know that you know"
 * is worth its cost; "I know that you know that I know that you know" is not, and
 * the benchmarks say models cannot use it reliably anyway.
 */
import { clamp01 } from './defaults';
import { tokenSet } from '../brain/activation';

/**
 * Are two gists about the same fact?
 *
 * Not `similarity()`: that is Jaccard over the union, which punishes exactly the
 * case this module lives on — a short thing someone was told ("Rooke works for
 * Kessler") against a longer memory of it ("Rooke revealed he is working for
 * Kessler and that Della supplied the vial"). Union-based scoring calls those
 * unrelated. Containment over the *shorter* set is the right measure for
 * "is this fact present in that one".
 *
 * Possessives are normalised because `tokenSet` keeps `kessler's` distinct from
 * `kessler`, and a character should not treat those as different people.
 *
 * Two shared content tokens are required, so a single coincidental overlap
 * cannot make the character assume someone is in on something.
 */
function relatedGist(a: string, b: string): number {
  const norm = (text: string) => new Set(
    [...tokenSet(text)].map((t) => t.replace(/'s$/, '')),
  );
  const ta = norm(a);
  const tb = norm(b);
  if (ta.size < 2 || tb.size < 2) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  if (inter < 2) return 0;
  return inter / Math.min(ta.size, tb.size);
}

/** How a person came to know something — it decides how firmly they hold it. */
export type KnowledgeSource =
  /** They were there. Strongest. */
  | 'witnessed'
  /** Someone said it to them. As trustworthy as the teller. */
  | 'told'
  /** They worked it out. Held with less certainty, and can be wrong. */
  | 'inferred'
  /** The character deliberately kept it from them. */
  | 'withheld'
  /** The character told them something untrue about it. */
  | 'deceived';

export interface BeliefRecord {
  /** Memory node this belief is about. */
  nodeId: string;
  /** Short restatement, so the prompt does not have to carry the whole node. */
  gist: string;
  source: KnowledgeSource;
  /** 0..1 — how sure the character is that this person knows. */
  certainty: number;
  at: number;
}

/**
 * What the character believes is inside one other person's head.
 *
 * `knows` is not "the truth" — it is the character's *model*, and it can be
 * wrong. That is the point: a character who thinks you know something you do not
 * behaves very differently from one who has it right, and both are more human
 * than a character with perfect information.
 */
export interface MindModel {
  /** Person key (lowercased name), matching `RelationModel.key`. */
  key: string;
  displayName: string;
  knows: BeliefRecord[];
  /** Things the character is actively keeping from this person. */
  withheld: BeliefRecord[];
  /** Things the character has told this person that are not true. */
  deceptions: BeliefRecord[];
  /**
   * Second order, shallow: does the character think this person knows that *they*
   * know? The thing that makes an unspoken understanding — or a standoff — legible.
   */
  sharedUnderstanding: string[];
  updatedAt: number;
}

export interface TheoryOfMind {
  /** Keyed by person. */
  minds: Record<string, MindModel>;
}

export function emptyTheoryOfMind(): TheoryOfMind {
  return { minds: {} };
}

function ensureMind(tom: TheoryOfMind, key: string, displayName: string, now: number): MindModel {
  const k = key.toLowerCase();
  if (!tom.minds[k]) {
    tom.minds[k] = {
      key: k,
      displayName,
      knows: [],
      withheld: [],
      deceptions: [],
      sharedUnderstanding: [],
      updatedAt: now,
    };
  }
  return tom.minds[k];
}

const MAX_PER_PERSON = 40;

export interface WitnessInput {
  nodeId: string;
  gist: string;
  /** Everyone present when it happened, excluding the character themselves. */
  present: string[];
  /** Everyone in the scene at all, so absence can be recorded as *not* knowing. */
  cast: string[];
  now: number;
}

/**
 * Record who saw what.
 *
 * Presence is the strongest evidence there is, so a witnessed belief is held at
 * near-certainty. Crucially, this also *silently* establishes the negative: a
 * person in the cast who was not present does not get a record, and absence of a
 * record is what later makes "they do not know this" answerable.
 */
export function recordWitnessed(tom: TheoryOfMind, input: WitnessInput): TheoryOfMind {
  for (const name of input.present) {
    const mind = ensureMind(tom, name, name, input.now);
    if (mind.knows.some((b) => b.nodeId === input.nodeId)) continue;
    mind.knows.push({
      nodeId: input.nodeId,
      gist: input.gist.slice(0, 160),
      source: 'witnessed',
      certainty: 0.95,
      at: input.now,
    });
    mind.knows = mind.knows.slice(-MAX_PER_PERSON);
    mind.updatedAt = input.now;
  }
  return tom;
}

/** The character told someone something. Certainty tracks how well it landed. */
export function recordTold(
  tom: TheoryOfMind,
  person: string,
  belief: Omit<BeliefRecord, 'source' | 'certainty'> & { certainty?: number },
  now: number,
): TheoryOfMind {
  const mind = ensureMind(tom, person, person, now);
  const existing = mind.knows.find((b) => b.nodeId === belief.nodeId);
  if (existing) {
    // Being told something you already witnessed does not make you know it more.
    existing.certainty = Math.max(existing.certainty, belief.certainty ?? 0.8);
    return tom;
  }
  mind.knows.push({
    ...belief,
    gist: belief.gist.slice(0, 160),
    source: 'told',
    certainty: clamp01(belief.certainty ?? 0.8),
  });
  mind.knows = mind.knows.slice(-MAX_PER_PERSON);
  // Telling someone is also how a shared understanding forms: they know, and they
  // know that you know, because you are the one who said it.
  mind.updatedAt = now;
  return tom;
}

/** The character is keeping this from someone. */
export function recordWithheld(
  tom: TheoryOfMind,
  person: string,
  belief: Omit<BeliefRecord, 'source' | 'certainty'>,
  now: number,
): TheoryOfMind {
  const mind = ensureMind(tom, person, person, now);
  if (mind.withheld.some((b) => b.nodeId === belief.nodeId)) return tom;
  mind.withheld.push({
    ...belief,
    gist: belief.gist.slice(0, 160),
    source: 'withheld',
    certainty: 0.9,
  });
  mind.withheld = mind.withheld.slice(-20);
  mind.updatedAt = now;
  return tom;
}

/** The character lied to someone about this. */
export function recordDeception(
  tom: TheoryOfMind,
  person: string,
  belief: Omit<BeliefRecord, 'source' | 'certainty'>,
  now: number,
): TheoryOfMind {
  const mind = ensureMind(tom, person, person, now);
  if (mind.deceptions.some((b) => b.nodeId === belief.nodeId)) return tom;
  mind.deceptions.push({
    ...belief,
    gist: belief.gist.slice(0, 160),
    source: 'deceived',
    certainty: 0.85,
  });
  mind.deceptions = mind.deceptions.slice(-20);
  mind.updatedAt = now;
  return tom;
}

// ---------- queries ----------

export interface KnowledgeVerdict {
  knows: boolean;
  certainty: number;
  source?: KnowledgeSource;
  /** Plain-language reason, for the prompt and the inspector. */
  why: string;
}

/**
 * Does the character believe this person knows about a given memory?
 *
 * Matches by node id first, then by gist similarity — because the same fact
 * reaches people in different words, and a character who told you "he works for
 * Kessler" should not think you are ignorant of "Rooke is Kessler's man".
 */
export function doesKnow(
  tom: TheoryOfMind,
  person: string,
  target: { nodeId?: string; gist?: string },
): KnowledgeVerdict {
  const mind = tom.minds[person.toLowerCase()];
  if (!mind) {
    return { knows: false, certainty: 0.6, why: 'they have never been part of this' };
  }

  const byId = target.nodeId
    ? mind.knows.find((b) => b.nodeId === target.nodeId)
    : undefined;
  if (byId) {
    return {
      knows: true,
      certainty: byId.certainty,
      source: byId.source,
      why: byId.source === 'witnessed' ? 'they were there' : 'they were told',
    };
  }

  if (target.gist) {
    const near = mind.knows
      .map((b) => ({ b, s: relatedGist(b.gist, target.gist!) }))
      .sort((x, y) => y.s - x.s)[0];
    if (near && near.s >= 0.5) {
      return {
        knows: true,
        certainty: near.b.certainty * near.s,
        source: near.b.source,
        why: 'they know a version of this',
      };
    }
    // Being *deliberately* kept from something is a stronger "no" than silence.
    const hidden = mind.withheld
      .map((b) => ({ b, s: relatedGist(b.gist, target.gist!) }))
      .sort((x, y) => y.s - x.s)[0];
    if (hidden && hidden.s >= 0.5) {
      return { knows: false, certainty: 0.9, source: 'withheld', why: 'this is being kept from them' };
    }
  }

  return { knows: false, certainty: 0.75, why: 'nothing suggests they know' };
}

/**
 * Memories that must not be spoken freely in front of the people present.
 *
 * This is the operative output: given who is in the room, which of the things
 * the character is about to recall would be a *revelation* rather than a shared
 * reference. It is what stops a character casually mentioning what only they know.
 */
export function guardedTopics(
  tom: TheoryOfMind,
  present: string[],
  recalled: { nodeId: string; gist: string }[],
): { gist: string; hiddenFrom: string[]; deliberate: boolean }[] {
  const out: { gist: string; hiddenFrom: string[]; deliberate: boolean }[] = [];

  for (const node of recalled) {
    const hiddenFrom: string[] = [];
    let deliberate = false;
    for (const person of present) {
      const verdict = doesKnow(tom, person, { nodeId: node.nodeId, gist: node.gist });
      if (verdict.knows) continue;
      hiddenFrom.push(tom.minds[person.toLowerCase()]?.displayName ?? person);
      if (verdict.source === 'withheld') deliberate = true;
    }
    if (hiddenFrom.length) out.push({ gist: node.gist, hiddenFrom, deliberate });
  }
  return out;
}

/**
 * Lines for the prompt.
 *
 * Kept extremely short by design: this is the section that has to earn its tokens
 * against everything else in the block, and one clear sentence about what the
 * other person does not know does more work than a list.
 */
export function describeTheoryOfMind(
  tom: TheoryOfMind,
  present: string[],
  guarded: ReturnType<typeof guardedTopics>,
): string[] {
  const lines: string[] = [];

  if (guarded.length) {
    const deliberate = guarded.filter((g) => g.deliberate).slice(0, 2);
    const incidental = guarded.filter((g) => !g.deliberate).slice(0, 2);
    if (deliberate.length) {
      lines.push(
        `They are deliberately keeping this from ${listNames(deliberate[0].hiddenFrom)}: `
        + deliberate.map((g) => truncate(g.gist)).join('; ')
        + '. Do not let it slip, and do not hint at it clumsily.',
      );
    }
    if (incidental.length) {
      lines.push(
        `${listNames(incidental[0].hiddenFrom)} ${incidental[0].hiddenFrom.length > 1 ? 'do' : 'does'} not know: `
        + incidental.map((g) => truncate(g.gist)).join('; ')
        + '. Referring to it as shared knowledge would be a mistake they would not make.',
      );
    }
  }

  for (const person of present.slice(0, 3)) {
    const mind = tom.minds[person.toLowerCase()];
    if (!mind?.deceptions.length) continue;
    lines.push(
      `They have lied to ${mind.displayName} about ${truncate(mind.deceptions.at(-1)!.gist)} `
      + 'and have to keep that story straight.',
    );
  }

  return lines;
}

function listNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function truncate(s: string, n = 90): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).replace(/[\s,;:]+\S*$/, '')}…` : t;
}

/** Rough token cost, so the budget planner can account for the section. */
export function tomTokens(lines: string[]): number {
  return Math.ceil(lines.join(' ').length / 4);
}
