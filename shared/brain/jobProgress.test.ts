/**
 * A progress bar is a promise about how much work is left. These are the cases
 * where that promise used to break: the plan guessed wrong, a character was
 * skipped, or the run was stopped part-way.
 */
import { describe, expect, it } from 'vitest';
import {
  applyChunkProgress, foldJobStatus, jobPercent, settleMember,
  type JobCounters, type MemberCounters,
} from './jobProgress';

const member = (over: Partial<MemberCounters> = {}): MemberCounters => ({
  chunks: 0, chunksDone: 0, messages: 0, messagesRead: 0, encoded: 0, ...over,
});

describe('consolidation run bookkeeping', () => {
  it('counts a straightforward pass', () => {
    const job: JobCounters = { chunks: 3, chunksDone: 0 };
    const m = member({ chunks: 3 });
    applyChunkProgress(job, m, { chunkIndex: 1, chunkCount: 3, messagesRead: 40, messagesTotal: 120, encoded: 4 });
    expect(job).toEqual({ chunks: 3, chunksDone: 1 });
    expect(m).toMatchObject({ chunksDone: 1, messagesRead: 40, encoded: 4 });
    expect(jobPercent(job, false)).toBe(33);
  });

  it('corrects the total when the plan guessed too low', () => {
    // Planned 2 passes for this member; the real split needs 5.
    const job: JobCounters = { chunks: 4, chunksDone: 0 }; // 2 here + 2 for someone else
    const m = member({ chunks: 2 });
    applyChunkProgress(job, m, { chunkIndex: 0, chunkCount: 5, messagesRead: 0, messagesTotal: 200, encoded: 0 });
    expect(job.chunks).toBe(7); // the other member's 2 are untouched
    expect(job.chunksDone).toBe(0);
  });

  it('corrects the total when the plan guessed too high', () => {
    const job: JobCounters = { chunks: 10, chunksDone: 0 };
    const m = member({ chunks: 8 });
    applyChunkProgress(job, m, { chunkIndex: 1, chunkCount: 1, messagesRead: 6, messagesTotal: 6, encoded: 2 });
    expect(job.chunks).toBe(3);
    expect(job.chunksDone).toBe(1);
    expect(jobPercent(job, false)).toBe(33);
  });

  it('never claims more done than there is to do', () => {
    const job: JobCounters = { chunks: 5, chunksDone: 5 };
    const m = member({ chunks: 5, chunksDone: 5 });
    applyChunkProgress(job, m, { chunkIndex: 5, chunkCount: 2, messagesRead: 9, messagesTotal: 9, encoded: 1 });
    expect(job.chunks).toBeGreaterThanOrEqual(job.chunksDone);
    expect(jobPercent(job, false)).toBeLessThanOrEqual(100);
  });

  it('drops the passes a stopped member will never run', () => {
    const job: JobCounters = { chunks: 9, chunksDone: 2 };
    const m = member({ chunks: 6, chunksDone: 2 });
    settleMember(job, m);
    // The 4 unread passes stop counting against the bar.
    expect(job.chunks).toBe(5);
    expect(m.chunks).toBe(2);
  });

  it('leaves a member that finished its plan alone', () => {
    const job: JobCounters = { chunks: 4, chunksDone: 4 };
    const m = member({ chunks: 4, chunksDone: 4 });
    settleMember(job, m);
    expect(job.chunks).toBe(4);
    expect(jobPercent(job, true)).toBe(100);
  });

  it('reads an unplanned run as 0% while live and 100% once finished', () => {
    expect(jobPercent({ chunks: 0, chunksDone: 0 }, false)).toBe(0);
    expect(jobPercent({ chunks: 0, chunksDone: 0 }, true)).toBe(100);
  });

  it('calls a partial run done, and only a total failure an error', () => {
    expect(foldJobStatus(['done', 'error'], false)).toBe('done');
    expect(foldJobStatus(['error', 'error'], false)).toBe('error');
    // Skipped characters do not decide the verdict on their own.
    expect(foldJobStatus(['skipped', 'skipped'], false)).toBe('done');
    expect(foldJobStatus(['skipped', 'error'], false)).toBe('error');
    expect(foldJobStatus(['done'], true)).toBe('cancelled');
    expect(foldJobStatus([], false)).toBe('done');
  });
});
