/**
 * The terminal must never be able to break the thing it observes, and must never
 * retain a key or grow without bound.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearSessionLog, currentPurpose, logRequest, readSessionLog, runWithPurpose,
  sessionLogStats, subscribeSessionLog,
} from './lib/sessionLog';

beforeEach(() => clearSessionLog());

describe('session log', () => {
  it('records a request and its response as linked entries', () => {
    const tap = logRequest({
      purpose: 'reply:Wren', provider: 'openrouter', model: 'x/y',
      messages: [{ role: 'system', content: 'you are Wren' }, { role: 'user', content: 'hello' }],
      params: { temperature: 0.8 }, streamed: true,
    });
    tap.ok('hi there');

    const { entries } = readSessionLog();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ phase: 'request', purpose: 'reply:Wren' });
    expect(entries[0].messages).toHaveLength(2);
    expect(entries[1]).toMatchObject({ phase: 'response', requestId: entries[0].id, text: 'hi there' });
    expect(entries[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records failures without throwing', () => {
    const tap = logRequest({ purpose: 'brain.encoder', provider: 'p', model: 'm', messages: [] });
    expect(() => tap.fail(new Error('provider 500'))).not.toThrow();
    expect(readSessionLog().entries.at(-1)).toMatchObject({ phase: 'error', error: 'provider 500' });
  });

  it('NEVER retains an API key', () => {
    const tap = logRequest({
      purpose: 'x', provider: 'p', model: 'm',
      messages: [{ role: 'system', content: 'key sk-abcdefghijklmnopqrstuvwxyz here' }],
    });
    tap.ok('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234');
    const dumped = JSON.stringify(readSessionLog().entries);
    expect(dumped).not.toMatch(/sk-abcdefghijklmnop/);
    expect(dumped).not.toMatch(/Bearer abcdefghijkl/);
    expect(dumped).toMatch(/redacted/);
  });

  it('is bounded — a long session cannot grow without limit', () => {
    for (let i = 0; i < 500; i++) {
      logRequest({ purpose: `p${i}`, provider: 'p', model: 'm', messages: [] }).ok('x');
    }
    const stats = sessionLogStats();
    expect(stats.entries).toBeLessThanOrEqual(stats.max);
  });

  it('caps a single enormous prompt rather than retaining all of it', () => {
    logRequest({
      purpose: 'x', provider: 'p', model: 'm',
      messages: [{ role: 'user', content: 'a'.repeat(200_000) }],
    });
    const content = readSessionLog().entries[0].messages![0].content;
    expect(content.length).toBeLessThan(60_000);
    expect(content).toMatch(/not retained/);
  });

  it('serves only what a client has not seen', () => {
    logRequest({ purpose: 'a', provider: 'p', model: 'm', messages: [] });
    const first = readSessionLog();
    logRequest({ purpose: 'b', provider: 'p', model: 'm', messages: [] });
    const rest = readSessionLog(first.entries.at(-1)!.seq);
    expect(rest.entries).toHaveLength(1);
    expect(rest.entries[0].purpose).toBe('b');
  });

  it('notifies subscribers live, and a broken subscriber cannot break logging', () => {
    const seen: string[] = [];
    const un1 = subscribeSessionLog((e) => seen.push(e.purpose));
    const un2 = subscribeSessionLog(() => { throw new Error('bad listener'); });
    expect(() => logRequest({ purpose: 'live', provider: 'p', model: 'm', messages: [] })).not.toThrow();
    expect(seen).toContain('live');
    un1(); un2();
  });

  it('labels calls by the feature that made them', async () => {
    expect(currentPurpose()).toBe('model call');
    const inner = await runWithPurpose('brain.encoder', async () => {
      await Promise.resolve();
      return currentPurpose();
    });
    // Survives an await — the label has to outlive the async boundary or every
    // provider call would be logged as anonymous.
    expect(inner).toBe('brain.encoder');
    expect(currentPurpose()).toBe('model call');
  });

  it('clearing resets the epoch so clients can detect a wipe', () => {
    logRequest({ purpose: 'a', provider: 'p', model: 'm', messages: [] });
    const before = sessionLogStats().epoch;
    clearSessionLog();
    expect(readSessionLog().entries).toHaveLength(0);
    expect(sessionLogStats().epoch).toBeGreaterThanOrEqual(before);
  });
});
