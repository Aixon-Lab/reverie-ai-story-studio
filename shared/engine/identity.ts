/**
 * Who the human is in a scene.
 *
 * Two systems used to describe the same person: the global persona ("PLAYING AS
 * X" — who you are everywhere) and `group.playAs` (the cast seat you occupy in
 * this chat). When they disagreed, the same character existed twice — you wrote
 * as them and the AI also wrote as them, replying to yourself. These helpers
 * collapse both into one answer: which cast members are *you*, and are therefore
 * never voiced by the AI.
 */
import type { Persona } from '../types';

/** Personas minted from a character card carry that card's id: `from-<characterId>`. */
export const PERSONA_FROM_PREFIX = 'from-';

/** The persona id that represents a given library character. */
export function personaIdForCharacter(characterId: string): string {
  return `${PERSONA_FROM_PREFIX}${characterId}`;
}

/** The library character a persona was minted from, if any. */
export function personaCharacterId(persona?: Persona | null): string | null {
  const id = persona?.id;
  if (!id || !id.startsWith(PERSONA_FROM_PREFIX)) return null;
  const characterId = id.slice(PERSONA_FROM_PREFIX.length);
  return characterId || null;
}

type Seat = { id: string; name: string };

/**
 * Cast seats occupied by the human: the explicit `playAs` seat plus whichever
 * member the active persona *is* (by card id, else by name — a persona named
 * exactly like a cast member is that cast member as far as the reader is
 * concerned). Anything in here is off-limits to the AI.
 */
export function humanSeatIds(opts: {
  members: Seat[];
  playAs?: string | null;
  persona?: Persona | null;
}): string[] {
  const { members, playAs, persona } = opts;
  const ids: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && !ids.includes(id) && members.some((m) => m.id === id)) ids.push(id);
  };

  add(playAs);
  add(personaCharacterId(persona));
  const name = persona?.name?.trim().toLowerCase();
  if (name) add(members.find((m) => m.name.trim().toLowerCase() === name)?.id);
  return ids;
}

/**
 * The one seat that *is* you — the persona's own card wins over a stale
 * `playAs`, because the persona is what the header and the composer show.
 */
export function humanSeatId(opts: {
  members: Seat[];
  playAs?: string | null;
  persona?: Persona | null;
}): string | null {
  const { members, persona } = opts;
  const fromPersona = humanSeatIds({ members, persona });
  return fromPersona[0] ?? humanSeatIds(opts)[0] ?? null;
}
