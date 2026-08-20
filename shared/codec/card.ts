/**
 * Character card codec: ST V1/V2/V3 JSON <-> internal CharacterCard.
 * Round-trip safe: unknown extension keys preserved; export always writes
 * a V1 shell + V2 `data` (+V3 fields added at PNG write time).
 */
import type { CharacterBook, CharacterBookEntry, CharacterCard } from '../types';

type AnyObj = Record<string, any>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function normalizeBook(book: AnyObj | undefined): CharacterBook | undefined {
  if (!book || !Array.isArray(book.entries)) {
    // V3 sometimes stores entries as object map
    if (book && book.entries && typeof book.entries === 'object') {
      book = { ...book, entries: Object.values(book.entries) };
    } else if (!book) {
      return undefined;
    }
  }
  const entries: CharacterBookEntry[] = (book!.entries as AnyObj[]).map((e, i) => ({
    id: typeof e.id === 'number' ? e.id : i,
    keys: Array.isArray(e.keys) ? e.keys.map(str) : Array.isArray(e.key) ? e.key.map(str) : [],
    secondary_keys: Array.isArray(e.secondary_keys) ? e.secondary_keys.map(str) : [],
    comment: str(e.comment),
    content: str(e.content),
    constant: !!e.constant,
    selective: !!e.selective,
    insertion_order: Number(e.insertion_order ?? e.order ?? 100),
    enabled: e.enabled !== false,
    position: e.position === 'after_char' ? 'after_char' : 'before_char',
    extensions: (e.extensions as AnyObj) ?? {},
  }));
  return { name: book!.name ? str(book!.name) : undefined, entries, extensions: book!.extensions };
}

/** Parse any ST card JSON (V1 flat, V2 {spec, data}, or V3) into internal form. */
export function parseCard(jsonText: string, id: string): CharacterCard {
  let root: AnyObj;
  try {
    root = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Card JSON is invalid: ${(err as Error).message}`);
  }
  const isV2orV3 = root.spec === 'chara_card_v2' || root.spec === 'chara_card_v3' || (root.data && typeof root.data === 'object');
  const d: AnyObj = isV2orV3 ? root.data ?? {} : root;

  const card: CharacterCard = {
    id,
    name: str(d.name || root.name),
    description: str(d.description ?? root.description),
    personality: str(d.personality ?? root.personality),
    scenario: str(d.scenario ?? root.scenario),
    first_mes: str(d.first_mes ?? root.first_mes),
    mes_example: str(d.mes_example ?? root.mes_example),
    creator_notes: str(d.creator_notes ?? root.creatorcomment),
    system_prompt: str(d.system_prompt),
    post_history_instructions: str(d.post_history_instructions),
    alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(str) : [],
    tags: Array.isArray(d.tags) ? d.tags.map(str) : Array.isArray(root.tags) ? root.tags.map(str) : [],
    creator: str(d.creator),
    character_version: str(d.character_version),
    character_book: normalizeBook(d.character_book),
    extensions: { ...(d.extensions as AnyObj) },
    createdAt: Date.now(),
  };

  if (card.extensions.talkativeness === undefined && root.talkativeness !== undefined) {
    card.extensions.talkativeness = root.talkativeness;
  }

  if (root.spec === 'chara_card_v3' || d.nickname !== undefined || d.group_only_greetings !== undefined) {
    card.v3 = {
      nickname: d.nickname ? str(d.nickname) : undefined,
      assets: Array.isArray(d.assets) ? d.assets : undefined,
      creator_notes_multilingual: d.creator_notes_multilingual,
      source: Array.isArray(d.source) ? d.source : undefined,
      group_only_greetings: Array.isArray(d.group_only_greetings) ? d.group_only_greetings.map(str) : undefined,
      creation_date: d.creation_date,
      modification_date: d.modification_date,
    };
  }
  return card;
}

/** Export internal card to ST-compatible JSON (V1 shell + V2 data, V3 extras included). */
export function exportCard(card: CharacterCard): AnyObj {
  const data: AnyObj = {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example,
    creator_notes: card.creator_notes,
    system_prompt: card.system_prompt,
    post_history_instructions: card.post_history_instructions,
    alternate_greetings: card.alternate_greetings,
    tags: card.tags,
    creator: card.creator,
    character_version: card.character_version,
    extensions: card.extensions,
  };
  if (card.character_book) {
    data.character_book = {
      name: card.character_book.name,
      entries: card.character_book.entries,
      extensions: card.character_book.extensions ?? {},
    };
  }
  if (card.v3) {
    for (const [k, v] of Object.entries(card.v3)) if (v !== undefined) data[k] = v;
  }
  const talk = card.extensions.talkativeness;
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    // V1 shell for maximum compatibility
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example,
    creatorcomment: card.creator_notes,
    tags: card.tags,
    talkativeness: talk ?? 0.5,
    fav: card.extensions.fav ?? false,
    data,
  };
}
