/**
 * Background consolidation sweeper.
 *
 * Consolidation used to depend entirely on one call at the end of the streaming
 * generation handler. Every way that call could be missed became a way for memory
 * to stop forming, silently and permanently:
 *
 *   - the request errored, aborted, or the client disconnected mid-stream
 *   - the reply came from a swipe, a continue, or an impersonation path
 *   - the message was written by the user without any generation at all
 *   - the pass threw, or a stalled model call held the per-brain lock
 *   - the server restarted between the message landing and the pass running
 *
 * The sweeper removes the whole class. It walks every chat on a timer and
 * consolidates anything with enough unread messages, using exactly the same
 * cadence, gates and locking as the inline trigger — so the two can never
 * disagree, and the inline path stays as the fast case rather than the only one.
 */
import { loadSettings, loadCharacter } from '../routes/library';
import { loadChatMeta, loadGroup, loadMessages } from '../routes/chats';
import { listJsonFiles, dirs } from '../storage';
import type { ChatMeta } from '../../shared/types';
import { appendAudit, loadBrainIfExists, saveBrain, tryWithBrainLock } from './store';
import { repairCursor, resolveCursor } from './service';
import { ensureBrain } from './provision';
import { consolidateForChat } from '../routes/brain';
import { MIN_TICK_MS, describeMentation, mentate } from '../../shared/brain/mentation';
import { randomUUID } from 'node:crypto';

/** How often to look for work. Cheap: a scan is a few file reads per chat. */
const SWEEP_INTERVAL_MS = 60_000;
/**
 * Leave the newest messages alone briefly so the sweeper does not race the inline
 * trigger for the turn that just finished, and so a scene mid-exchange is read as
 * a whole rather than split down the middle.
 */
const SETTLE_MS = 20_000;
/** Chunks one sweep may read per character; the rest waits for the next sweep. */
const SWEEP_CHUNKS_PER_PASS = 3;

let timer: NodeJS.Timeout | null = null;
let running = false;

export interface SweepResult {
  chatsScanned: number;
  passesRun: number;
  /** Idle ticks that actually changed something; quiet ones are not counted. */
  mentationTicks: number;
  errors: number;
}

/**
 * One pass over every conversation.
 *
 * Exported so it can be triggered on demand (and tested) rather than only by the
 * timer. Never throws: a sweeper that dies takes memory formation with it.
 */
export async function sweepOnce(now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { chatsScanned: 0, passesRun: 0, mentationTicks: 0, errors: 0 };

  const settings = await loadSettings().catch(() => null);
  if (!settings) return result;
  const cfg = settings.brain;
  if (cfg?.enabled === false || cfg?.autoUpdate === false) return result;

  const metas = await listJsonFiles<ChatMeta>(dirs.chats).catch(() => [] as ChatMeta[]);

  for (const meta of metas) {
    if (!meta?.id) continue;
    result.chatsScanned++;
    try {
      // Give the tail a moment to settle before reading it.
      if (meta.updatedAt && now - meta.updatedAt < SETTLE_MS) continue;

      const characterIds: string[] = [];
      if (meta.groupId) {
        const group = await loadGroup(meta.groupId).catch(() => null);
        if (group) {
          characterIds.push(...group.members.filter((m) => !group.disabledMembers.includes(m)));
        }
      } else if (meta.characterId) {
        characterIds.push(meta.characterId);
      }
      if (!characterIds.length) continue;

      const messages = await loadMessages(meta.id);
      if (!messages.length) continue;

      for (const characterId of characterIds) {
        let brain = await loadBrainIfExists(meta.id, characterId);
        if (!brain) {
          // A conversation that has never consolidated is exactly the case the
          // inline trigger most often misses, so the sweeper creates the brain too.
          if (cfg?.autoCreate === false) continue;
          const card = await loadCharacter(characterId).catch(() => null);
          if (!card) continue;
          const conn = settings.utilityConnection ?? settings.textConnection;
          brain = await ensureBrain(meta.id, card, conn).catch(() => null);
          if (!brain) continue;
        }
        if (!brain.config.enabled) continue;
        // Honour a mind's own "manual only" — the sweeper is the one path that
        // would otherwise keep making model calls for it behind the user's back.
        if (brain.config.autoUpdate === false) continue;

        const every = Math.max(1, brain.config.updateEveryMessages || cfg?.updateEveryMessages || 6);
        const cursor = resolveCursor(brain, meta.id, messages);

        if (cursor.repaired) {
          await repairCursor(meta.id, characterId, brain.characterName, messages);
        }
        if (cursor.pending < every) {
          /**
           * Nothing new to consolidate — which is precisely when the mind should
           * be left alone with itself (`shared/brain/mentation.ts`).
           *
           * This is the whole point of the idle loop: a character who is not
           * being spoken to is not paused, and the gap between scenes is where
           * mood settles, things get chewed over, and connections nobody wrote
           * get made. It runs *here*, in the branch that used to `continue`,
           * because a brain with a backlog has real events to process and does
           * not need to invent inner weather on top of them.
           */
          /**
           * The cheap half of the quiet path, decided from the brain already in
           * hand. Without it every idle mind would cost a lock and a re-read on
           * every sixty-second sweep just to be told nothing has changed — which
           * is exactly the cost the quiet path exists to avoid.
           */
          const since = now - (brain.stats.lastMentationAt ?? brain.stats.lastUpdateAt ?? brain.updatedAt ?? now);
          if (since >= MIN_TICK_MS && await tickIdleMind(meta.id, characterId, now)) {
            result.mentationTicks++;
          }
          continue;
        }

        const outcome = await tryWithBrainLock(meta.id, characterId, () =>
          // Same bound as the inline trigger: a long backlog is read over
          // successive sweeps, never as one unattended burst of model calls.
          consolidateForChat(characterId, meta.id, { maxChunks: SWEEP_CHUNKS_PER_PASS }));
        if (outcome.ran) {
          result.passesRun++;
          console.log(
            `[brain] sweeper consolidated ${brain.characterName} in "${meta.title}" `
            + `(${cursor.pending} unread, cadence ${every})`,
          );
        }
      }
    } catch (err: any) {
      result.errors++;
      console.error(`[brain] sweeper: ${meta.id}:`, err?.message ?? err);
    }
  }

  return result;
}

/**
 * One idle tick for a single mind.
 *
 * Returns whether anything actually happened. The quiet path is the common case
 * by design, and it must stay genuinely free — no lock contention, no write, no
 * audit line — or the sweeper could not afford to offer it to every mind on
 * every pass.
 *
 * Never throws: idling is the least important thing the sweeper does and must
 * not be able to stop the most important.
 */
async function tickIdleMind(chatId: string, characterId: string, now: number): Promise<boolean> {
  try {
    const outcome = await tryWithBrainLock(chatId, characterId, async () => {
      // Re-read under the lock: consolidation may have run since the scan.
      const brain = await loadBrainIfExists(chatId, characterId);
      if (!brain?.config.enabled) return false;

      const report = mentate(brain, { now, makeId: () => randomUUID() });
      if (report.quiet) return false;

      await saveBrain(brain);
      await appendAudit(chatId, characterId, {
        kind: 'mentation',
        chatId,
        summary: describeMentation(report, brain.characterName),
        detail: report,
      });
      return true;
    });
    return outcome.ran && outcome.value === true;
  } catch (err: any) {
    console.error(`[brain] mentation ${chatId}/${characterId}:`, err?.message ?? err);
    return false;
  }
}

/** Start the timer. Idempotent; safe to call on every boot path. */
export function startBrainSweeper(): void {
  if (timer) return;
  /**
   * Look once at boot, not only a minute later.
   *
   * A restart in the middle of a backlog left memory visibly doing nothing for
   * the first sixty seconds, which is exactly when a user checks whether the
   * restart fixed anything. Delayed slightly so it does not compete with the
   * first page load for the same model.
   */
  const kickoff = setTimeout(() => {
    if (running) return;
    running = true;
    void sweepOnce()
      .catch((err) => console.error('[brain] first sweep failed', err))
      .finally(() => { running = false; });
  }, 3_000);
  kickoff.unref?.();

  timer = setInterval(() => {
    // Overlap guard: a sweep that runs long must not have a second one stacked
    // on top of it, or slow model calls would multiply.
    if (running) return;
    running = true;
    void sweepOnce()
      .catch((err) => console.error('[brain] sweeper failed', err))
      .finally(() => { running = false; });
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open on its own account.
  timer.unref?.();
  console.log(`[brain] consolidation sweeper active (every ${SWEEP_INTERVAL_MS / 1000}s)`);
}

export function stopBrainSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
