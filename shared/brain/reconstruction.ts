/**
 * Reconstruction — where memory actually goes wrong.
 *
 * The engine already models fidelity, and the composer already *hedges* when
 * fidelity is low. That is not what memory does. A person with a degraded memory
 * does not say "I think, though I'm not sure"; they confidently report a version
 * that has quietly drifted — the wrong person, the wrong week, two evenings
 * fused into one — and they are certain. Bartlett's finding, and the reason
 * eyewitness testimony is worth so little: recall is reconstruction from a gist
 * plus whatever the schema supplies, and the joins are invisible from the inside.
 *
 * Cerememory implements the honest half of this (`degrade_text`, which blanks
 * every Nth word) — see docs/research/brain-integration-2026.md §B.2 #6. Blanked
 * words read as damage, not as memory. What follows instead applies *typed
 * distortions* that leave a fluent, wrong account.
 *
 * Two design decisions carry the whole module:
 *
 *   **Distortion is committed, not rolled.** It happens at retrieval and is
 *   written back into the node. Re-rolling per turn would make a character
 *   uncertain in a shimmering, obviously-synthetic way — right on Tuesday, wrong
 *   on Wednesday, right again on Thursday. Committing it means the memory *is*
 *   now wrong, stays wrong, gets more wrong, and shows as wrong in the Mind page.
 *   That is precisely reconsolidation, which the engine already names as the
 *   source of false memory (§M.7.3).
 *
 *   **The prompt is never told.** A distorted memory is presented flatly, as
 *   fact, because that is how the character holds it. Marking it would make the
 *   model narrate its own unreliability, which is the opposite of the effect.
 *   Only genuine, felt uncertainty — the abstention band — is surfaced.
 *
 * Pure, with an injected rng.
 */
import { clamp01, similarity, tokenSet } from './activation';
import { TIME_UNIT_MS } from './defaults';
import { namesOf, resolvePerson } from './entities';
import { corruptionOf } from './synapse';
import type { BrainState, MemoryNode } from './types';

/** What a single distortion did, kept so the Mind page can show the drift. */
export interface Distortion {
  at: number;
  kind: 'telescoped' | 'misattributed' | 'blended' | 'coloured';
  /** Plain-language description of the change, for the UI only. */
  note: string;
}

/**
 * Base per-retrieval distortion rate at full corruption.
 *
 * Deliberately low. Memory drifts over months, not over an afternoon, and a
 * character who misremembers something every other turn is not realistic, they
 * are broken. At 0.22 a badly degraded memory drifts roughly once every five
 * times it is brought up.
 */
const BASE_RATE = 0.22;

/** Corruption below this leaves a memory alone entirely. */
const FLOOR = 0.3;

/** How many distortions to keep on a node before dropping the oldest. */
const MAX_HISTORY = 6;

export interface ReconstructOptions {
  /** 0 disables distortion entirely; 1 is the full modelled rate. */
  confabulation?: number;
  rng?: () => number;
}

/**
 * Rebuild a memory at retrieval, possibly wrongly.
 *
 * Called from `applyRetrievalEffects`, where retrieval already mutates. Returns
 * the distortion applied, if any, so the consolidation report can carry it.
 */
export function reconstructOnRecall(
  brain: BrainState,
  node: MemoryNode,
  now: number,
  opts: ReconstructOptions = {},
): Distortion | null {
  const strength = opts.confabulation ?? brain.config.confabulation ?? 1;
  if (strength <= 0) return null;
  /**
   * Three exemptions, all for the same reason: these are the memories a
   * character rebuilds most often and therefore holds most stably. A pin is the
   * user asserting this one is correct; identity memories are rehearsed for life
   * and are the spine of the self; a trauma S-rep is pathologically *un*-drifting,
   * which is the entire complaint about it (§M.8).
   */
  if (node.pinned || node.kind === 'identity' || node.kind === 'sensory') return null;

  const corruption = corruptionOf(node);
  if (corruption < FLOOR) return null;

  const rng = opts.rng ?? Math.random;
  const chance = BASE_RATE * strength * ((corruption - FLOOR) / (1 - FLOOR));
  if (rng() >= chance) return null;

  const distortion = applyOne(brain, node, now, corruption, rng);
  if (!distortion) return null;

  node.distortions = [...(node.distortions ?? []), distortion].slice(-MAX_HISTORY);
  /**
   * Conviction *rises* as accuracy falls.
   *
   * This is the confidence–accuracy dissociation made active rather than merely
   * recorded: each retelling smooths the account and makes it feel more certain,
   * which is why the most confidently wrong witnesses are the ones who have gone
   * over it most.
   */
  node.confidence = clamp01(node.confidence + 0.03);
  return distortion;
}

function applyOne(
  brain: BrainState,
  node: MemoryNode,
  now: number,
  corruption: number,
  rng: () => number,
): Distortion | null {
  // Ordered by how badly damaged a trace has to be before each becomes likely.
  // Time goes first because it is the first thing anyone loses.
  const roll = rng();
  if (roll < 0.4) return telescope(node, now, corruption, rng);
  if (roll < 0.7) return colour(brain, node, now, corruption);
  if (roll < 0.9) return misattribute(brain, node, now, rng);
  return blend(brain, node, now);
}

/**
 * Temporal telescoping: the felt date of an event drifts.
 *
 * Recent events are pushed away and distant ones pulled closer — the standard
 * finding, and the reason people are so confident and so wrong about *when*.
 * `encodedAt` is untouched, because every decay equation depends on it; only the
 * perceived date moves, and only the composer reads it.
 */
function telescope(node: MemoryNode, now: number, corruption: number, rng: () => number): Distortion | null {
  const actual = node.perceivedAt ?? node.encodedAt;
  const ageDays = (now - actual) / TIME_UNIT_MS;
  if (ageDays < 1) return null;

  // Backward telescoping for the recent, forward for the old, around a pivot of
  // roughly a month — the region where the two effects change places.
  const pivot = 30;
  const direction = ageDays < pivot ? 1 : -1;
  const magnitude = ageDays * corruption * (0.25 + 0.5 * rng());
  const shifted = actual - direction * magnitude * TIME_UNIT_MS;
  // Never let a memory drift into the future or before the brain existed.
  node.perceivedAt = Math.min(now - TIME_UNIT_MS * 0.5, Math.max(brain0(node), shifted));

  const wasAgo = Math.round(ageDays);
  const nowAgo = Math.round((now - node.perceivedAt) / TIME_UNIT_MS);
  if (wasAgo === nowAgo) return null;
  return {
    at: now,
    kind: 'telescoped',
    note: `feels like ${nowAgo}d ago, actually ${wasAgo}d`,
  };
}

function brain0(node: MemoryNode): number {
  // A memory cannot be remembered as older than the life that contains it. We do
  // not have a birth date, so the encoding time minus a year is the safe bound.
  return node.encodedAt - 365 * TIME_UNIT_MS;
}

/**
 * Affective colouring: the feeling drifts toward what the character now believes.
 *
 * Bartlett's core mechanism — memory conforms to schema. A character who has
 * come to believe someone is untrustworthy gradually remembers past dealings
 * with them as having felt worse than they did. The event does not change; how
 * it felt does, and that is what they will act on.
 */
function colour(brain: BrainState, node: MemoryNode, now: number, corruption: number): Distortion | null {
  // Pull toward the standing belief about whoever was involved, falling back to
  // present mood when nobody in particular was.
  let target = brain.mood.valence;
  let why = 'their mood since';
  for (const actor of node.actors ?? []) {
    const rel = brain.people[actor.trim().toLowerCase()];
    if (!rel) continue;
    target = clamp01((rel.affection + rel.trust) / 2 + 0.5) * 2 - 1;
    why = `what they now think of ${rel.displayName}`;
    break;
  }

  const before = node.affect.valence;
  const pull = 0.35 * corruption;
  const after = before + (target - before) * pull;
  if (Math.abs(after - before) < 0.05) return null;
  node.affect = { ...node.affect, valence: Math.max(-1, Math.min(1, after)) };
  return {
    at: now,
    kind: 'coloured',
    note: `felt ${before.toFixed(2)}, now recalled as ${after.toFixed(2)} — ${why}`,
  };
}

/**
 * Source misattribution: the wrong person ends up in the memory.
 *
 * The most consequential everyday memory error and the easiest to produce
 * honestly — swap an actor for someone who appears in a memory sharing this
 * one's cues, i.e. someone who plausibly *could* have been there. Only ever one
 * actor, and never when there is nobody to confuse them with.
 */
function misattribute(brain: BrainState, node: MemoryNode, now: number, rng: () => number): Distortion | null {
  const own = new Set((node.actors ?? []).flatMap((a) => [...namesOf(brain, a)]));
  if (!own.size) return null;

  const candidates: string[] = [];
  for (const other of Object.values(brain.nodes)) {
    if (other.id === node.id || !other.actors?.length) continue;
    // Plausible confusions only: the two memories have to share something.
    if (similarity(other.gist, node.gist) < 0.15 && !sharesTag(other, node)) continue;
    for (const a of other.actors) {
      // Same person under another name is not a confusion — it is a spelling.
      if (own.has(resolvePerson(brain, a)) || own.has(a.toLowerCase())) continue;
      candidates.push(a);
    }
  }
  if (!candidates.length) return null;

  const replacement = candidates[Math.floor(rng() * candidates.length) % candidates.length];
  const index = Math.floor(rng() * node.actors.length) % node.actors.length;
  const replaced = node.actors[index];
  if (replaced.toLowerCase() === replacement.toLowerCase()) return null;

  node.actors = node.actors.map((a, i) => (i === index ? replacement : a));
  // The name in the gist has to move with the actor list, or the two disagree
  // and the memory reads as corrupted data rather than as a mistake.
  node.gist = replaceName(node.gist, replaced, replacement);
  if (node.verbatim) node.verbatim = undefined; // exact wording cannot survive this
  return {
    at: now,
    kind: 'misattributed',
    note: `remembers ${replacement} where it was ${replaced}`,
  };
}

/**
 * Fusion: two similar occasions become one.
 *
 * What happens to repeated events — a dozen arguments in the same kitchen
 * collapse into a single remembered argument that never happened in that form.
 * Only fuses genuinely similar episodes, and only ever borrows a clause.
 */
function blend(brain: BrainState, node: MemoryNode, now: number): Distortion | null {
  let best: MemoryNode | null = null;
  let bestSim = 0.35;
  for (const other of Object.values(brain.nodes)) {
    if (other.id === node.id || other.kind !== node.kind) continue;
    const sim = similarity(node.gist, other.gist);
    if (sim > bestSim) { bestSim = sim; best = other; }
  }
  if (!best) return null;

  const borrowed = firstClause(best.gist);
  if (!borrowed || node.gist.toLowerCase().includes(borrowed.toLowerCase())) return null;

  node.gist = `${node.gist.replace(/[.\s]+$/, '')} — and ${lowerFirst(borrowed)}`;
  node.verbatim = undefined;
  return {
    at: now,
    kind: 'blended',
    note: 'fused with a similar occasion',
  };
}

// ---------- abstention ----------

/**
 * Can this memory be brought back at all?
 *
 * The gap most memory systems never model: LongMemEval's abstention questions
 * ask about events that never happened and systems confabulate rather than
 * decline (§N.1.2). A person who cannot remember says so. Below this band the
 * character knows *that* something happened and cannot retrieve *what* — which
 * is a distinct and very common experience, and quite different from the hedged
 * "I think it was something about…" the composer produces above it.
 */
export function isBeyondRecall(node: MemoryNode): boolean {
  if (node.pinned || node.kind === 'identity' || node.kind === 'sensory') return false;
  // Both have to be gone. Low fidelity with high conviction is the *confident
  // error* case, which is the whole point of this module — not an abstention.
  return node.fidelity < 0.22 && node.confidence < 0.45;
}

// ---------- small helpers ----------

function sharesTag(a: MemoryNode, b: MemoryNode): boolean {
  const tags = new Set((b.tags ?? []).map((t) => t.toLowerCase()));
  if ((a.tags ?? []).some((t) => tags.has(t.toLowerCase()))) return true;
  return !!a.place && !!b.place && a.place.toLowerCase() === b.place.toLowerCase();
}

/** Replace a name in prose without mangling words that merely contain it. */
function replaceName(text: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), to);
}

function firstClause(gist: string): string {
  const clean = (gist ?? '').trim();
  const cut = clean.search(/[,;.]|\s—\s/);
  const clause = cut > 12 ? clean.slice(0, cut) : clean;
  return clause.length > 90 ? clause.slice(0, 90).trimEnd() : clause;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** Cue overlap between a node and a text, for callers that need it. */
export function cueOverlap(node: MemoryNode, text: string): number {
  const a = tokenSet(`${node.gist} ${node.tags.join(' ')}`);
  const b = tokenSet(text);
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits / a.size;
}
