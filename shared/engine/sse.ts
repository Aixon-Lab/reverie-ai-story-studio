/**
 * Server-sent events, parsed the way the protocol actually works.
 *
 * The streaming reply used to be read line by line: `event:` set a variable,
 * `data:` immediately parsed and dispatched. Two things are wrong with that,
 * and both lose text silently.
 *
 * A frame ends at a *blank line*, and the event type resets afterwards — that
 * is what blank lines are for. Reading line-wise left the type sticky, so any
 * frame that omitted its own `event:` inherited the previous one's, and a bare
 * `data:` arriving after `done` was dispatched as a second `done`.
 *
 * And `data:` may appear several times in one frame, in which case the payload
 * is the lines joined with newlines. Parsing each line on its own handed
 * `JSON.parse` a fragment every time, which threw into a catch that ignored it
 * — tokens vanished with nothing anywhere to say why.
 *
 * Pure and transport-free so it can be tested without a server.
 */

export interface SseFrame {
  /** Event type, defaulting to `message` exactly as the spec says. */
  event: string;
  /** The `data:` lines, joined and trimmed. Empty frames are not returned. */
  data: string;
}

/**
 * Cut every complete frame off the front of a buffer.
 *
 * Returns the unconsumed remainder, which the caller keeps until more bytes
 * arrive. Handles both `\n\n` and `\r\n\r\n` separators.
 */
export function drainSseFrames(buffer: string, onFrame: (frame: string) => void): string {
  let rest = buffer;
  for (;;) {
    const at = /\r?\n\r?\n/.exec(rest);
    if (!at) return rest;
    onFrame(rest.slice(0, at.index));
    rest = rest.slice(at.index + at[0].length);
  }
}

/** One raw frame → its event type and payload, or `null` when it carries none. */
export function parseSseFrame(frame: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];

  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // A line starting with ':' is a comment. Servers send them as keep-alives.
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // Exactly one leading space is part of the framing, not of the value.
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value.trim();
    else if (field === 'data') data.push(value);
  }

  if (!data.length) return null;
  const payload = data.join('\n').trim();
  return payload ? { event, data: payload } : null;
}
