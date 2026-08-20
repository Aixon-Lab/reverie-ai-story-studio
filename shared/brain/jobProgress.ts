/**
 * Bookkeeping for a consolidation run.
 *
 * Separated from the runner because the arithmetic is where a progress bar goes
 * wrong: the plan is an *estimate* made before any reading happens, and the run
 * then discovers the real number of passes. If the total is not corrected as it
 * goes, the bar either sticks below 100% forever or claims more progress than
 * exists. No file access, no model calls — just the counters.
 */

export interface JobCounters {
  chunks: number;
  chunksDone: number;
}

export interface MemberCounters extends JobCounters {
  messages: number;
  messagesRead: number;
  encoded: number;
}

export interface ChunkProgress {
  chunkIndex: number;
  chunkCount: number;
  messagesRead: number;
  messagesTotal: number;
  encoded: number;
}

/**
 * Fold one progress report into a member and the run it belongs to.
 *
 * The job total is adjusted by the *difference* between what this member was
 * assumed to need and what it actually needs, so other members' estimates are
 * left alone.
 */
export function applyChunkProgress(
  job: JobCounters,
  member: MemberCounters,
  p: ChunkProgress,
): void {
  job.chunks += p.chunkCount - member.chunks;
  job.chunksDone += p.chunkIndex - member.chunksDone;
  member.chunks = p.chunkCount;
  member.chunksDone = p.chunkIndex;
  member.messages = p.messagesTotal;
  member.messagesRead = p.messagesRead;
  member.encoded = p.encoded;
  // Totals must never go backwards past zero or below what is already done.
  if (job.chunks < job.chunksDone) job.chunks = job.chunksDone;
}

/**
 * Settle a member that finished early — stopped, or with fewer real passes than
 * planned — so the run's total stops promising work nobody will do.
 */
export function settleMember(job: JobCounters, member: MemberCounters): void {
  const unplayed = member.chunks - member.chunksDone;
  if (unplayed > 0) {
    job.chunks -= unplayed;
    member.chunks = member.chunksDone;
  }
  if (job.chunks < job.chunksDone) job.chunks = job.chunksDone;
}

export type MemberStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

/**
 * What the run as a whole amounts to.
 *
 * A partial run is still a run: only a run where every character that was meant
 * to be read failed counts as an error.
 */
export function foldJobStatus(
  statuses: MemberStatus[],
  wasCancelled: boolean,
): 'done' | 'error' | 'cancelled' {
  if (wasCancelled) return 'cancelled';
  const attempted = statuses.filter((s) => s !== 'skipped');
  if (attempted.length && attempted.every((s) => s === 'error')) return 'error';
  return 'done';
}

/** Progress as a percentage, tolerant of a run that has not planned yet. */
export function jobPercent(job: JobCounters, finished: boolean): number {
  if (job.chunks <= 0) return finished ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((job.chunksDone / job.chunks) * 100)));
}
