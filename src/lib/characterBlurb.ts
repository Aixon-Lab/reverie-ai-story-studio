/** Short list-safe blurbs from a character card — identity/description, not the word "Character". */
import type { CharacterCard, Group } from '@shared/types';

/** Strip ST macros and collapse whitespace for a one- or two-line list preview. */
function clean(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .replace(/\{\{[^}]+\}\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Prefer personality (who they are), then description, notes, scenario, then tags.
 * Truncates for dense lists.
 */
export function characterBlurb(
  c: Pick<CharacterCard, 'personality' | 'description' | 'creator_notes' | 'scenario' | 'tags'>,
  maxLen = 110,
): string {
  const pool = [c.personality, c.description, c.creator_notes, c.scenario]
    .map(clean)
    .filter(Boolean);

  let text = pool[0] ?? '';
  if (!text && c.tags?.length) {
    text = c.tags.slice(0, 4).join(' · ');
  }
  if (!text) return 'No description yet';

  // Prefer first sentence if it fits; otherwise hard-truncate.
  const sentence = text.match(/^(.+?[.!?])(\s|$)/);
  if (sentence && sentence[1].length >= 24 && sentence[1].length <= maxLen) {
    return sentence[1];
  }
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).replace(/\s+\S*$/, '').trimEnd()}…`;
}

/** Member names for group rows in pickers. */
export function groupBlurb(
  g: Pick<Group, 'members' | 'name'>,
  characters: Pick<CharacterCard, 'id' | 'name'>[],
  maxNames = 3,
): string {
  const names = g.members
    .map((id) => characters.find((c) => c.id === id)?.name)
    .filter(Boolean) as string[];
  if (!names.length) return `Group · ${g.members.length}`;
  const shown = names.slice(0, maxNames).join(' · ');
  const extra = names.length > maxNames ? ` +${names.length - maxNames}` : '';
  return `Group · ${shown}${extra}`;
}
