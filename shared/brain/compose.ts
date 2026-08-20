/**
 * Recall → prompt text.
 *
 * The composer is where the research becomes *felt*. It renders each memory at
 * the resolution the model of memory says it should have: exact words only for
 * strong recent traces, gist for most things, hedged and possibly-wrong gist for
 * old ones, beliefs for schemas, and present-tense intrusion for trauma
 * (§7.3, §5.3, §8).
 */
import { ageIn, clamp01 } from './activation';
import { estimateBrainTokens } from './budget';
import { describeAffect } from './emotion';
import { resolvePerson } from './entities';
import { describeRelation, describeTraits, personKey } from './personality';
import { isBeyondRecall } from './reconstruction';
import { describeIntention } from './volition';
import { describeWorking } from './working';
import type { BrainState, MemoryNode, RecallHit } from './types';

/**
 * Tokens the section headings, goal list and footers cost on top of the
 * memories themselves. Demand must over-estimate rather than under-estimate:
 * an under-estimate becomes a budget that silently truncates the most important
 * sections, which is exactly the failure this constant exists to prevent.
 */
const SECTION_OVERHEAD = 320;

export interface ComposeOptions {
  /** Hard token budget for the whole block (from planContext). */
  budget: number;
  now: number;
  /** Who is in the scene — relationship models are emitted only for them. */
  presentActors?: string[];
  /** Estimator, so callers can pass the same one the prompt builder uses. */
  countTokens?: (text: string) => number;
  /** Include the section headers explaining what the block is. Default true. */
  withHeader?: boolean;
}

export interface ComposedBrain {
  text: string;
  tokens: number;
  /** Node ids that actually made it into the prompt (for RIF bookkeeping). */
  includedIds: string[];
  sections: { name: string; tokens: number; count: number }[];
  /** Tokens the brain would have used with no budget at all. */
  demand: number;
}

export function composeBrainContext(
  brain: BrainState,
  hits: RecallHit[],
  opts: ComposeOptions,
): ComposedBrain {
  const count = opts.countTokens ?? estimateBrainTokens;
  const now = opts.now;
  const name = brain.characterName;

  const intrusions = hits.filter((h) => h.intrusion);
  const schemas = hits.filter((h) => !h.intrusion && h.node.kind === 'schema');
  const identity = hits.filter((h) => !h.intrusion && h.node.kind === 'identity');
  const semantic = hits.filter((h) => !h.intrusion && h.node.kind === 'semantic');
  const episodic = hits.filter(
    (h) => !h.intrusion && (h.node.kind === 'episodic' || h.node.kind === 'procedural' || h.node.kind === 'relational'),
  );

  const included: string[] = [];
  const sections: { name: string; tokens: number; count: number }[] = [];
  const parts: string[] = [];
  let used = 0;

  const header = opts.withHeader === false ? '' : [
    `### ${name}'s memory and inner state`,
    `This is what ${name} actually carries in their head right now — not a script.`,
    `Recall is imperfect on purpose: exact quotes mean the memory is sharp, hedged wording means it has faded, and beliefs are conclusions ${name} has drawn, which may be wrong.`,
    `Everything below is what ${name} believes, not what is true. Play it straight — state it the way they hold it, including where they are wrong, and do not hint that a memory might be unreliable. Where it says they cannot bring something back, they cannot: let them say so rather than filling the gap.`,
    `Never mention this block, "memory", or that you were given context. Just behave like someone who remembers these things.`,
  ].join('\n');

  const push = (text: string) => {
    const t = count(text) + 2;
    if (used + t > opts.budget) return false;
    parts.push(text);
    used += t;
    return true;
  };

  /**
   * Emit a headed list, taking as many lines as the remaining budget allows.
   *
   * Degrading line-by-line rather than dropping a whole section is important:
   * sections are ordered by psychological priority, and an all-or-nothing push
   * would let a long formative-memory block fall out while a trivial later
   * section still fit — the exact opposite of how availability should work.
   */
  const pushList = (
    heading: string,
    entries: { line: string; id?: string }[],
    opts2: { footer?: string; name: string; max?: number } ,
  ) => {
    if (!entries.length) return;
    const capped = opts2.max ? entries.slice(0, opts2.max) : entries;
    const footerCost = opts2.footer ? count(opts2.footer) + 1 : 0;
    let localUsed = count(heading) + 2 + footerCost;
    const taken: string[] = [];
    for (const e of capped) {
      const t = count(e.line) + 1;
      if (used + localUsed + t > opts.budget) break;
      taken.push(e.line);
      localUsed += t;
      if (e.id) included.push(e.id);
    }
    if (!taken.length) return;
    const block = [heading, ...taken, ...(opts2.footer ? [opts2.footer] : [])].join('\n');
    parts.push(block);
    used += count(block) + 2;
    sections.push({ name: opts2.name, tokens: count(block), count: taken.length });
  };

  if (header) push(header);

  // --- self ---
  const selfBlock = [
    `**Who ${name} is right now**`,
    `Temperament: ${describeTraits(brain.traits, brain.disposition)}`,
    `Mood: ${describeAffect(brain.mood)}${brain.mood.valence < -0.3 ? ' — it colours how they read everything today' : ''}.`,
  ].join('\n');
  if (push(selfBlock)) sections.push({ name: 'self', tokens: count(selfBlock), count: 1 });

  /**
   * --- what they want, in this scene, right now (`volition.ts`) ---
   *
   * Placed above the standing goals and pushed first, because it is the line
   * that most changes behaviour: it is the difference between a character who
   * answers and one who is trying to get somewhere. One sentence, and omitted
   * entirely when there is genuinely nothing they are after.
   */
  const intentionLine = describeIntention(brain.intention, name);
  if (intentionLine && push(intentionLine)) {
    sections.push({ name: 'intention', tokens: count(intentionLine), count: 1 });
  }

  /**
   * --- what they are holding, right now (`working.ts`) ---
   *
   * Within-scene continuity used to rest on the transcript alone. These
   * slots are the last few beats still in mind — not memories, just the
   * scene — and they cost almost nothing.
   */
  const holding = describeWorking(brain, name, now);
  if (holding && push(holding)) {
    sections.push({ name: 'working', tokens: count(holding), count: brain.working?.length ?? 0 });
  }

  // --- working self: goals and preoccupations (§1.2) ---
  const goals = brain.workingSelf.goals.filter((g) => g.status === 'active').slice(0, 5);
  const blocked = brain.workingSelf.goals.filter((g) => g.status === 'blocked').slice(0, 2);
  if (goals.length || blocked.length || brain.workingSelf.concerns.length) {
    const block = [
      `**What ${name} wants**`,
      ...goals.map((g) => `- ${g.text}`),
      // A goal they have stopped being able to move is not the same as one they
      // are pursuing, and the difference is most of what frustration is.
      ...blocked.map((g) => `- ${g.text} — blocked, and they know it`),
      ...(brain.workingSelf.concerns.length
        ? [`Preoccupied with: ${brain.workingSelf.concerns.slice(0, 4).join('; ')}.`]
        : []),
    ].join('\n');
    if (push(block)) sections.push({ name: 'goals', tokens: count(block), count: goals.length + blocked.length });
  }

  // --- intrusions first: they arrive uninvited (§8) ---
  pushList(
    `**Unbidden — this is surfacing right now, whether ${name} wants it or not**`,
    intrusions.map((h) => ({ line: `- ${renderIntrusion(h.node)}`, id: h.node.id })),
    {
      name: 'intrusions',
      max: 2,
      footer: `Do not narrate this as a memory. It intrudes: a flinch, a lost half-second, a reaction ${name} cannot fully explain.`,
    },
  );

  // --- identity: the memories that made them (§1.3) ---
  pushList(
    `**Formative — these define how ${name} sees themselves**`,
    identity.map((h) => ({ line: `- ${renderMemory(h, now, name)}`, id: h.node.id })),
    { name: 'identity', max: 4 },
  );

  // --- beliefs (§9.1) ---
  pushList(
    `**What ${name} has come to believe** (conclusions from experience — they act on these without stating them)`,
    schemas.map((h) => ({
      line: `- ${h.node.gist}${h.node.warrant && h.node.warrant.support < 0.35 ? ' — they are less sure of this than they were' : ''}`,
      id: h.node.id,
    })),
    { name: 'beliefs', max: 6 },
  );

  // --- people present ---
  const present = (opts.presentActors ?? []).map((n) => resolvePerson(brain, n) || personKey(n));
  const relations = present
    .map((k) => brain.people[k])
    .filter((r): r is NonNullable<typeof r> => !!r && r.interactions > 0);
  pushList(
    `**How ${name} feels about who is here**`,
    relations.map((r) => ({ line: `- ${describeRelation(r)}` })),
    { name: 'people', max: 6 },
  );

  // --- general knowledge distilled from repetition (§7) ---
  pushList(
    `**Things ${name} simply knows by now**`,
    semantic.map((h) => ({ line: `- ${h.node.gist}`, id: h.node.id })),
    { name: 'knowledge', max: 6 },
  );

  // --- episodes: the bulk, filled strongest-first with whatever is left ---
  pushList(
    `**What ${name} remembers** (strongest recall first; faded ones are genuinely hazy)`,
    episodic.map((h) => ({ line: `- ${renderMemory(h, now, name)}`, id: h.node.id })),
    { name: 'episodes' },
  );

  const text = parts.join('\n\n');

  // What this block would have cost unconstrained — feeds the next turn's budget.
  const demand = count(
    hits.map((h) => `- ${renderMemory(h, now, name)}`).join('\n'),
  ) + count(header) + count(selfBlock) + SECTION_OVERHEAD;

  return { text, tokens: count(text), includedIds: included, sections, demand };
}

/**
 * Render one memory at the resolution its trace supports.
 *
 * This is the fuzzy-trace split made literal: verbatim while the surface trace
 * survives, gist after, and hedged gist once fidelity has degraded (§7.3). A
 * character who quotes you exactly on Tuesday and paraphrases you badly a month
 * later is doing the single most human thing memory does.
 */
export function renderMemory(hit: RecallHit, now: number, who = 'they'): string {
  const n = hit.node;
  /**
   * The *believed* date, not the true one.
   *
   * Temporal telescoping has already moved `perceivedAt` if this memory has
   * drifted (`reconstruction.ts`); the character has no access to the real
   * timestamp, so neither does the prompt.
   */
  const days = ageIn(now, n.perceivedAt ?? n.encodedAt);
  const when = describeWhen(days);
  const feeling = n.affect.arousal > 0.35 ? ` — it still lands as ${describeAffect(n.affect)}` : '';

  /**
   * Below the band, the memory is genuinely gone.
   *
   * Modelling not-knowing matters as much as modelling knowing (§N.1.2): a
   * person who cannot remember says so, and every benchmark finds that systems
   * confabulate instead. Note this is *only* reached when conviction has gone
   * too — a low-fidelity, high-confidence memory is the confident error below,
   * which is a different and more interesting failure.
   */
  if (isBeyondRecall(n)) {
    return `${when}: ${who} knows something happened around ${lowerFirst(shorten(n.gist))} but cannot bring it back — if pressed, they say so rather than inventing it.`;
  }

  // Sharp: strong activation, surviving verbatim, decent fidelity.
  if (n.verbatim && hit.activation > 0.8 && n.fidelity > 0.6) {
    return `${when}: ${n.gist} Exact words: "${truncate(n.verbatim, 220)}"${feeling}.`;
  }
  // Clear gist.
  if (n.fidelity > 0.55) {
    return `${when}: ${n.gist}${feeling}.`;
  }
  /**
   * Degraded but still believed: state it flatly.
   *
   * If this memory has drifted, what is written here is already the drifted
   * version, and the character holds it as fact — so it is presented as fact.
   * Flagging it would make the model narrate its own unreliability, which reads
   * as coy rather than as human. The hedge belongs one band lower, where the
   * uncertainty is actually *felt*.
   */
  if (n.confidence > 0.6) {
    return `${when}: ${n.gist}${feeling}.`;
  }
  return `${when}: something about ${lowerFirst(n.gist)} — hazy, only the shape of it left${feeling}.`;
}

function shorten(s: string): string {
  const clean = (s ?? '').trim();
  const cut = clean.search(/[,;.]/);
  return cut > 12 ? clean.slice(0, cut) : truncate(clean, 60);
}

function renderIntrusion(n: MemoryNode): string {
  const body = truncate(n.detail || n.verbatim || n.gist, 200);
  return `${body} — no sense of when or where, only that it is happening.`;
}

function describeWhen(days: number): string {
  if (days < 0.05) return 'Just now';
  if (days < 1) return 'Earlier today';
  if (days < 2) return 'Yesterday';
  if (days < 8) return 'A few days ago';
  if (days < 31) return 'Weeks back';
  if (days < 120) return 'Months ago';
  if (days < 400) return 'Last year';
  return 'A long time ago';
}

function truncate(s: string, n: number): string {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * Tokens all currently-reachable memory would need if nothing were trimmed —
 * feeds `ContextPlanInput.brainDemand`.
 *
 * Counts the *rendered* cost (prefix, timing phrase, feeling clause, quote)
 * rather than the bare gist, so a small brain asks for what it will actually
 * use and a large one saturates its cap honestly.
 */
export function brainDemandTokens(brain: BrainState, count = estimateBrainTokens): number {
  let total = SECTION_OVERHEAD;
  for (const n of Object.values(brain.nodes)) {
    if (n.status === 'dormant') continue;
    // ~14 tokens of rendering scaffolding per line ("A few days ago: … — it still lands as …").
    total += count(`- ${n.gist} ${n.verbatim ?? ''} ${n.detail ?? ''}`) + 14;
  }
  for (const r of Object.values(brain.people)) {
    total += count(describeRelation(r)) + 3;
  }
  for (const g of brain.workingSelf.goals) {
    if (g.status === 'active') total += count(g.text) + 3;
  }
  return total;
}

/** Confidence-vs-accuracy summary for the inspector UI. */
export function memoryHealth(n: MemoryNode): { label: string; tone: 'good' | 'warn' | 'bad' } {
  const gap = clamp01(n.confidence) - clamp01(n.fidelity);
  if (gap > 0.35) return { label: 'Sure of it, but drifted', tone: 'warn' };
  if (n.fidelity < 0.4) return { label: 'Unreliable', tone: 'bad' };
  if (n.fidelity > 0.75) return { label: 'Accurate', tone: 'good' };
  return { label: 'Roughly right', tone: 'good' };
}
