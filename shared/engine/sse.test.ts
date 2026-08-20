/**
 * Streaming frames, and the three ways the old line-wise reader lost text.
 */
import { describe, expect, it } from 'vitest';
import { drainSseFrames, parseSseFrame } from './sse';

/** Feed a stream in arbitrary slices and collect what comes out. */
function stream(chunks: string[]): { event: string; data: string }[] {
  const out: { event: string; data: string }[] = [];
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    buffer = drainSseFrames(buffer, (frame) => {
      const parsed = parseSseFrame(frame);
      if (parsed) out.push(parsed);
    });
  }
  return out;
}

describe('frames are separated by blank lines', () => {
  it('reads a normal delta/done exchange', () => {
    expect(stream([
      'event: delta\ndata: {"text":"Hello"}\n\n',
      'event: delta\ndata: {"text":" there"}\n\n',
      'event: done\ndata: {"message":{"id":"m1"}}\n\n',
    ])).toEqual([
      { event: 'delta', data: '{"text":"Hello"}' },
      { event: 'delta', data: '{"text":" there"}' },
      { event: 'done', data: '{"message":{"id":"m1"}}' },
    ]);
  });

  it('survives a frame split across network chunks', () => {
    expect(stream(['event: de', 'lta\ndata: {"te', 'xt":"split"}\n', '\n'])).toEqual([
      { event: 'delta', data: '{"text":"split"}' },
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(stream(['event: delta\r\ndata: {"text":"crlf"}\r\n\r\n'])).toEqual([
      { event: 'delta', data: '{"text":"crlf"}' },
    ]);
  });

  it('ignores comment keep-alives', () => {
    expect(stream([': keep-alive\n\n', 'event: delta\ndata: {"text":"x"}\n\n'])).toEqual([
      { event: 'delta', data: '{"text":"x"}' },
    ]);
  });
});

describe('the event type does not leak between frames', () => {
  it('falls back to `message` rather than repeating the last event', () => {
    // The bug: this second frame was dispatched as another `done`, because
    // `event` was set once and never reset.
    expect(stream([
      'event: done\ndata: {"message":{"id":"m1"}}\n\n',
      'data: {"text":"trailing"}\n\n',
    ])).toEqual([
      { event: 'done', data: '{"message":{"id":"m1"}}' },
      { event: 'message', data: '{"text":"trailing"}' },
    ]);
  });
});

describe('a multi-line payload is one document', () => {
  it('joins repeated data lines with newlines instead of parsing each alone', () => {
    // A pretty-printed payload: legal SSE, and three broken fragments to the
    // old per-line reader — every one of which threw into a silent catch.
    const frame = [
      'event: delta',
      'data: {',
      'data:   "text": "hi"',
      'data: }',
    ].join('\n');
    const parsed = parseSseFrame(frame);
    expect(parsed).toEqual({ event: 'delta', data: '{\n  "text": "hi"\n}' });
    expect(JSON.parse(parsed!.data).text).toBe('hi');
  });
});

describe('framing details', () => {
  it('strips the framing space, then trims — the payload is always JSON', () => {
    expect(parseSseFrame('event: delta\ndata: {"text":"x"}')).toEqual({
      event: 'delta', data: '{"text":"x"}',
    });
    expect(parseSseFrame('event: delta\ndata:{"text":"x"}')).toEqual({
      event: 'delta', data: '{"text":"x"}',
    });
  });

  it('returns nothing for a frame carrying no data', () => {
    expect(parseSseFrame('event: ping')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
    expect(parseSseFrame('data:   ')).toBeNull();
  });

  it('keeps an unterminated tail in the buffer rather than dispatching it early', () => {
    let leftover = '';
    const seen: string[] = [];
    leftover = drainSseFrames('event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"te', (f) => seen.push(f));
    expect(seen).toHaveLength(1);
    expect(leftover).toBe('event: delta\ndata: {"te');
  });
});
