/**
 * Creating a mind, with the right settings, from anywhere.
 *
 * Brains are born in four places — the inline trigger after a reply, the
 * sweeper, a manual consolidate, and the group memory screen. Each of them used
 * to call `initBrain` directly, which meant a new mind took the hard-coded
 * defaults and quietly ignored both the Memory drawer and the conversation's own
 * settings. One function now owns "what should this mind start with", so the
 * answer cannot differ by which path got there first.
 */
import type { CharacterCard, TextConnection } from '../../shared/types';
import type { BrainState } from '../../shared/brain/types';
import { resolveBrainConfig, type BrainConfigFields } from '../../shared/brain/config';
import { loadSettings } from '../routes/library';
import { loadChatMeta } from '../routes/chats';
import { initBrain } from './service';

/** Global defaults + this conversation's settings, resolved into one config. */
export async function resolveSeedConfig(chatId: string): Promise<BrainConfigFields> {
  const settings = await loadSettings().catch(() => null);
  const meta = await loadChatMeta(chatId).catch(() => null);
  return resolveBrainConfig({ global: settings?.brain ?? null, chat: meta?.brain ?? null });
}

/**
 * Ensure a baseline exists for this character in this chat, seeded from the
 * settings in force. Safe to call every turn: `initBrain` is a no-op once a
 * model-derived anchor is in place, and the seed only applies at birth.
 */
export async function ensureBrain(
  chatId: string,
  card: CharacterCard,
  conn: TextConnection,
  opts: { force?: boolean } = {},
): Promise<BrainState> {
  const seed = await resolveSeedConfig(chatId);
  return initBrain(chatId, card, conn, { force: opts.force, seed });
}
