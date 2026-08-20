/**
 * Long consolidation runs, made watchable.
 *
 * Reading a whole conversation is minutes of model calls, so it cannot live
 * inside an HTTP request: the browser waits on a spinner that says nothing, and
 * a dropped connection loses the run. A job is started, answered immediately,
 * and then polled — the caller sees which character is being read, how many
 * chunks are done, how many memories have formed, and can stop it.
 *
 * Stopping is safe by construction: each chunk advances the read cursor as it
 * finishes, so whatever was encoded stays encoded and the next run resumes from
 * the last completed chunk rather than starting over.
 *
 * The registry is in memory. A server restart loses the *view* of a run, never
 * the work — that lives in the brain files.
 */
import { randomUUID } from 'node:crypto';
import { loadCharacter } from '../routes/library';
import { loadChatMeta, loadGroup, loadMessages } from '../routes/chats';
import { consolidateForChat } from '../routes/brain';
import { loadBrainIfExists, tryWithBrainLock } from './store';
import { resolveCursor } from './service';
import { applyChunkProgress, foldJobStatus, settleMember } from '../../shared/brain/jobProgress';

export type BrainJobStatus = 'planning' | 'running' | 'done' | 'cancelled' | 'error';
export type BrainJobMemberStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface BrainJobMember {
  characterId: string;
  name: string;
  status: BrainJobMemberStatus;
  /** Chunks planned for this character, and how many have finished. */
  chunks: number;
  chunksDone: number;
  messages: number;
  messagesRead: number;
  /** Memories added or updated in this run. */
  encoded: number;
  reason?: string;
  error?: string;
}

export interface BrainJob {
  id: string;
  chatId: string;
  kind: 'update' | 'reread';
  status: BrainJobStatus;
  startedAt: number;
  finishedAt?: number;
  chunks: number;
  chunksDone: number;
  currentCharacterId?: string;
  members: BrainJobMember[];
  error?: string;
}

/** Finished jobs stay readable long enough for the UI to show the result. */
const KEEP_FINISHED_MS = 5 * 60_000;

const jobs = new Map<string, BrainJob>();
const cancelled = new Set<string>();
/** One run per conversation: a second Consolidate All joins the first. */
const byChat = new Map<string, string>();

function gc(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > KEEP_FINISHED_MS) {
      jobs.delete(id);
      cancelled.delete(id);
      if (byChat.get(job.chatId) === id) byChat.delete(job.chatId);
    }
  }
}

export function getBrainJob(id: string): BrainJob | null {
  gc();
  return jobs.get(id) ?? null;
}

/** The run in flight for a conversation, if any. */
export function activeBrainJob(chatId: string): BrainJob | null {
  gc();
  const id = byChat.get(chatId);
  const job = id ? jobs.get(id) : null;
  return job && (job.status === 'planning' || job.status === 'running') ? job : null;
}

export function cancelBrainJob(id: string): BrainJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'planning' || job.status === 'running') {
    cancelled.add(id);
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    job.currentCharacterId = undefined;
    for (const m of job.members) {
      if (m.status === 'pending' || m.status === 'running') {
        m.status = m.chunksDone ? 'done' : 'skipped';
        if (!m.chunksDone) m.reason = 'stopped before this character was read';
      }
    }
  }
  return job;
}

/**
 * Characters that belong to a conversation, group or solo.
 *
 * Muted members are included and flagged rather than dropped. A mute silences a
 * character in the *scene* — the automatic paths honour it, which is why the
 * cast screen says "no memory forms while muted" — but "Consolidate all" is a
 * deliberate instruction, and silently skipping half the cast without saying so
 * was worse than either answer. The run reports them as skipped, with a reason.
 */
async function castOf(chatId: string): Promise<{ id: string; muted: boolean }[]> {
  const meta = await loadChatMeta(chatId);
  if (meta.groupId) {
    const group = await loadGroup(meta.groupId).catch(() => null);
    if (!group) return [];
    return group.members.map((id) => ({ id, muted: group.disabledMembers.includes(id) }));
  }
  return meta.characterId ? [{ id: meta.characterId, muted: false }] : [];
}

/**
 * Start a run over a conversation.
 *
 * Returns as soon as the job exists — planning and reading continue in the
 * background. Re-entry while one is live returns the live one instead of
 * stacking a second set of model calls on the same brains.
 */
export async function startBrainJob(opts: {
  chatId: string;
  force?: boolean;
  /** Restrict the run to one character (the single-mind page). */
  characterIds?: string[];
}): Promise<BrainJob> {
  const existing = activeBrainJob(opts.chatId);
  if (existing) return existing;

  const ids = opts.characterIds?.length
    ? opts.characterIds.map((id) => ({ id, muted: false }))
    : await castOf(opts.chatId);
  const job: BrainJob = {
    id: randomUUID(),
    chatId: opts.chatId,
    kind: opts.force ? 'reread' : 'update',
    status: 'planning',
    startedAt: Date.now(),
    chunks: 0,
    chunksDone: 0,
    members: [],
    // Names are filled in during planning; the list order is the reading order.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  };
  jobs.set(job.id, job);
  byChat.set(opts.chatId, job.id);

  void run(job, ids, !!opts.force).catch((err) => {
    job.status = 'error';
    job.error = err?.message ?? 'Consolidation failed.';
    job.finishedAt = Date.now();
  });

  return job;
}

/** Plan every character's reading up front, so the bar has a real total. */
async function plan(job: BrainJob, ids: { id: string; muted: boolean }[], force: boolean): Promise<void> {
  const messages = await loadMessages(job.chatId).catch(() => []);
  for (const { id: characterId, muted } of ids) {
    const card = await loadCharacter(characterId).catch(() => null);
    const brain = await loadBrainIfExists(job.chatId, characterId);
    const member: BrainJobMember = {
      characterId,
      name: card?.name ?? brain?.characterName ?? characterId,
      status: 'pending',
      chunks: 0,
      chunksDone: 0,
      messages: 0,
      messagesRead: 0,
      encoded: 0,
    };

    if (!card) {
      member.status = 'skipped';
      member.reason = 'character card is missing from the library';
    } else if (muted) {
      member.status = 'skipped';
      member.reason = 'muted in this scene — unmute them to let their memory form';
    } else if (brain && !brain.config.enabled) {
      member.status = 'skipped';
      member.reason = 'memory is switched off for this character';
    } else {
      // Unread messages, from the same cursor the run itself will use. The exact
      // chunk count is settled by the run; this is the honest estimate for the bar.
      const pending = brain && !force
        ? Math.max(0, resolveCursor(brain, job.chatId, messages).pending)
        : messages.length;
      member.messages = pending;
      member.chunks = Math.max(pending ? 1 : 0, Math.ceil(pending / 40));
    }
    job.members.push(member);
  }
  job.chunks = job.members.reduce((s, m) => s + m.chunks, 0);
}

async function run(job: BrainJob, ids: { id: string; muted: boolean }[], force: boolean): Promise<void> {
  await plan(job, ids, force);
  if (cancelled.has(job.id)) return;
  job.status = 'running';

  for (const member of job.members) {
    if (cancelled.has(job.id)) break;
    if (member.status === 'skipped') continue;

    member.status = 'running';
    job.currentCharacterId = member.characterId;
    try {
      const outcome = await tryWithBrainLock(job.chatId, member.characterId, () =>
        consolidateForChat(member.characterId, job.chatId, {
          force,
          shouldStop: () => cancelled.has(job.id),
          // The plan was an estimate; the run knows the truth.
          onProgress: (p) => applyChunkProgress(job, member, p),
        }));

      if (!outcome.ran) {
        member.status = 'skipped';
        member.reason = 'another pass is already running for this mind';
      } else {
        member.status = 'done';
        if (!member.encoded && outcome.value?.reason) member.reason = outcome.value.reason;
      }
    } catch (err: any) {
      member.status = 'error';
      member.error = err?.message ?? 'Consolidation failed.';
    }
    // Whatever happened, stop promising passes this member will never run.
    settleMember(job, member);
  }

  job.currentCharacterId = undefined;
  job.status = foldJobStatus(job.members.map((m) => m.status), cancelled.has(job.id));
  const failed = job.members.find((m) => m.status === 'error');
  if (failed) job.error = failed.error;
  if (job.status === 'done') job.chunksDone = job.chunks;
  job.finishedAt = Date.now();
}
