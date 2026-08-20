/**
 * The per-brain lock has to survive being taken twice on one call path.
 *
 * `consolidateForChat` acquires it (via `initBrain`) and then again (via
 * `runConsolidation`), and the automatic paths wrap the whole thing in
 * `tryWithBrainLock`. If the lock is a plain promise chain, the inner
 * acquisition waits for the outer one to finish and the outer one is waiting for
 * the inner — the pass never completes, `inFlight` never clears, and every later
 * pass for that brain declines forever.
 */
import { describe, expect, it } from 'vitest';
import { brainBusy, tryWithBrainLock, withBrainLock } from './store';

const TIMEOUT = Symbol('timeout');

function within<T>(ms: number, p: Promise<T>): Promise<T | typeof TIMEOUT> {
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), ms))]);
}

describe('brain lock', () => {
  it('serialises independent sections', async () => {
    const order: string[] = [];
    const a = withBrainLock('chat', 'a', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-end');
    });
    const b = withBrainLock('chat', 'a', async () => { order.push('b'); });
    await within(1000, Promise.all([a, b]));
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('does not deadlock when the same lock is re-acquired inside itself', async () => {
    const got = await within(1000, withBrainLock('chat', 'nested', async () =>
      withBrainLock('chat', 'nested', async () => 'inner')));
    expect(got).toBe('inner');
  });

  it('does not deadlock through tryWithBrainLock, the way consolidation runs', async () => {
    const got = await within(1000, tryWithBrainLock('chat', 'pass', async () => {
      // initBrain takes the lock…
      await withBrainLock('chat', 'pass', async () => 'baseline');
      // …and then runConsolidation takes it again.
      return withBrainLock('chat', 'pass', async () => 'consolidated');
    }));
    expect(got).toEqual({ ran: true, value: 'consolidated' });
    // A brain left marked busy declines every future pass.
    expect(brainBusy('chat', 'pass')).toBe(false);
  });

  it('releases the lock when the section throws', async () => {
    await expect(withBrainLock('chat', 'boom', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    const after = await within(1000, withBrainLock('chat', 'boom', async () => 'still works'));
    expect(after).toBe('still works');
  });
});
