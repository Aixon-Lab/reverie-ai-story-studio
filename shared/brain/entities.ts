/**
 * Entity canonicalisation — one person, many names (§B.2 #33).
 *
 * "Wren" / "Miss Vale" / "she" must be one person in the relationship table
 * and in every actor list. Without an alias table, each spelling grows its
 * own `RelationModel`, reconstruction "misattributes" Wren to Miss Vale
 * (they are the same woman), and the People tab lies.
 *
 * `personKey` still lowercases; this layer sits on top and maps any known
 * alias onto a single canonical key. Pronouns are *not* stored as global
 * aliases — "she" is context, not identity.
 *
 * Learning is conservative. A name is only folded into another when the
 * match is unambiguous given the people already known and the cast in the
 * scene. Ambiguity leaves both keys alone.
 *
 * Pure. Mutates the brain it is given.
 */
import type { BrainState, RelationModel } from './types';

/** Same rule as `personKey` — kept local so this file does not import personality. */
function personKey(name: string): string {
  return name.trim().toLowerCase();
}

const TITLES = /^(miss|ms|mrs|mr|mister|dr|doctor|lady|lord|sir|madam|mx)\.?\s+/i;
const PRONOUNS = new Set([
  'she', 'her', 'hers', 'he', 'him', 'his', 'they', 'them', 'their', 'theirs',
  'it', 'its', 'we', 'us', 'our', 'you', 'your', 'yours',
]);

export function ensureAliases(brain: BrainState): Record<string, string> {
  if (!brain.aliases) brain.aliases = {};
  return brain.aliases;
}

/** Strip a courtesy title so "Miss Vale" and "Vale" can meet. */
export function bareName(name: string): string {
  return personKey(name.replace(TITLES, ''));
}

export function isPronoun(name: string): boolean {
  return PRONOUNS.has(personKey(name));
}

/**
 * The key this name should live under.
 *
 * Walks the alias table once. A cycle (should never be written) stops at
 * the first repeat rather than looping.
 */
export function resolvePerson(brain: BrainState, name: string): string {
  const start = personKey(name);
  if (!start || isPronoun(start)) return start;
  const table = brain.aliases;
  if (!table) return start;
  let key = start;
  const seen = new Set<string>();
  while (table[key] && table[key] !== key && !seen.has(key)) {
    seen.add(key);
    key = table[key];
  }
  return key;
}

/**
 * Remember that `alias` is `canonical`.
 *
 * Refuses pronouns, empty strings, and mapping a name to itself. If the
 * alias already had its own relationship record, that record is merged
 * into the canonical one so nothing is lost.
 */
export function registerAlias(brain: BrainState, alias: string, canonical: string): string {
  const a = personKey(alias);
  const c = personKey(canonical);
  if (!a || !c || a === c || isPronoun(a) || isPronoun(c)) return resolvePerson(brain, canonical);
  const table = ensureAliases(brain);
  table[a] = c;
  mergePeople(brain, a, c);
  return c;
}

/**
 * Fold a newly-seen name into an existing person when the match is unique.
 *
 * Returns the canonical key. Never invents a person — if nothing matches,
 * the incoming name is its own key.
 */
export function learnPerson(
  brain: BrainState,
  name: string,
  opts: { cast?: Iterable<string>; now?: number } = {},
): string {
  const incoming = name.trim();
  if (!incoming || isPronoun(incoming)) return personKey(incoming);

  const key = personKey(incoming);
  const resolved = resolvePerson(brain, incoming);
  if (resolved !== key) return resolved;

  const cast = [...(opts.cast ?? [])].map((n) => n.trim()).filter(Boolean);
  /**
   * An exact name in the scene belongs to that person. "Wren" sitting next
   * to "Scarlet Wren" is a different woman; folding her in is the bug
   * `isSelf` already learned the hard way.
   */
  if (cast.some((m) => personKey(m) === key)) return key;

  const match = findUniqueMatch(brain, incoming, cast);
  if (match) return registerAlias(brain, incoming, match);

  return key;
}

/** Canonicalise a list of actor names, dropping empties and pronouns. */
export function canonicalizeActors(
  brain: BrainState,
  actors: string[] | undefined,
  cast?: Iterable<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of actors ?? []) {
    const name = (raw ?? '').trim();
    if (!name || isPronoun(name)) continue;
    const key = learnPerson(brain, name, { cast });
    if (seen.has(key)) continue;
    seen.add(key);
    // Keep the display form the encoder wrote, not the key.
    const rel = brain.people[key];
    out.push(rel?.displayName || name);
  }
  return out;
}

/**
 * Ingest encoder-supplied alias groups.
 *
 * The model is allowed to say "Wren, also Miss Vale". We still run the
 * uniqueness check so a confused encoder cannot merge two real people.
 */
export function learnAliasGroups(
  brain: BrainState,
  groups: { canonical: string; also: string[] }[] | undefined,
  cast?: Iterable<string>,
): void {
  if (!groups?.length) return;
  for (const group of groups) {
    const canon = learnPerson(brain, group.canonical, { cast });
    for (const also of group.also ?? []) {
      if (isPronoun(also)) continue;
      const match = findUniqueMatch(brain, also, cast ?? []);
      // Only fold if the alias is free or already points at this person.
      if (!match || resolvePerson(brain, match) === canon || personKey(match) === canon) {
        registerAlias(brain, also, canon);
      }
    }
  }
}

function findUniqueMatch(brain: BrainState, name: string, cast: Iterable<string>): string | null {
  const key = personKey(name);
  const bare = bareName(name);
  const parts = bare.split(/\s+/).filter((p) => p.length > 2);

  const candidates: string[] = [];
  const consider = (display: string, canonical: string) => {
    const otherKey = resolvePerson(brain, canonical);
    const otherBare = bareName(display);
    const otherParts = otherBare.split(/\s+/).filter((p) => p.length > 2);
    if (bare && (bare === otherBare || key === personKey(display))) {
      candidates.push(otherKey);
      return;
    }
    // "Wren" matches "Scarlet Wren" / "Wren Vale" when no one else claims the token.
    if (parts.length === 1 && otherParts.includes(parts[0])) {
      candidates.push(otherKey);
      return;
    }
    if (otherParts.length === 1 && parts.includes(otherParts[0])) {
      candidates.push(otherKey);
    }
  };

  for (const rel of Object.values(brain.people)) {
    consider(rel.displayName || rel.key, rel.key);
  }
  for (const member of cast) {
    consider(member, member);
  }

  const unique = [...new Set(candidates)].filter((c) => c !== key);
  if (unique.length === 1) return unique[0];
  return null;
}

/**
 * Move an alias's relationship record onto the canonical key.
 *
 * The canonical record wins on display name when it looks like a full name;
 * numeric axes take the more extreme value, because two spellings of the
 * same person should not dilute a betrayal.
 */
function mergePeople(brain: BrainState, fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  const from = brain.people[fromKey];
  const to = brain.people[toKey];
  if (!from) return;
  if (!to) {
    from.key = toKey;
    brain.people[toKey] = from;
    delete brain.people[fromKey];
    return;
  }

  const pick = (a: number, b: number) => (Math.abs(a) >= Math.abs(b) ? a : b);
  to.trust = pick(to.trust, from.trust);
  to.affection = pick(to.affection, from.affection);
  to.fear = pick(to.fear, from.fear);
  to.respect = pick(to.respect, from.respect);
  to.resentment = pick(to.resentment, from.resentment);
  to.debt += from.debt;
  to.familiarity = Math.max(to.familiarity, from.familiarity);
  to.interactions += from.interactions;
  to.firstMetAt = Math.min(to.firstMetAt, from.firstMetAt);
  to.lastSeenAt = Math.max(to.lastSeenAt, from.lastSeenAt);
  if ((from.displayName || '').length > (to.displayName || '').length) {
    to.displayName = from.displayName;
  }
  if (from.model && !to.model) to.model = from.model;
  delete brain.people[fromKey];
}

/** Display name for a resolved key, falling back to the key itself. */
export function displayPerson(brain: BrainState, name: string): string {
  const key = resolvePerson(brain, name);
  return brain.people[key]?.displayName || name.trim();
}

/** All keys (canonical + aliases) that refer to this person. */
export function namesOf(brain: BrainState, name: string): Set<string> {
  const canon = resolvePerson(brain, name);
  const out = new Set<string>([canon, personKey(name)]);
  for (const [alias, target] of Object.entries(brain.aliases ?? {})) {
    if (target === canon || alias === canon) out.add(alias);
  }
  const rel: RelationModel | undefined = brain.people[canon];
  if (rel) {
    out.add(personKey(rel.displayName));
    out.add(bareName(rel.displayName));
  }
  return out;
}
