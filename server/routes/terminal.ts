/**
 * Session terminal API.
 *
 * Session-scoped by construction: the buffer lives in process memory, so a
 * restart is a wipe and there is nothing on disk to leak or to encrypt.
 */
import { Router } from 'express';
import {
  clearSessionLog, readSessionLog, sessionLogStats, subscribeSessionLog,
} from '../lib/sessionLog';

export const terminal = Router();

/** Backlog. `since` is the last sequence number the client already has. */
terminal.get('/terminal', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json({ ...readSessionLog(since), stats: sessionLogStats() });
});

terminal.delete('/terminal', (_req, res) => {
  clearSessionLog();
  res.json({ ok: true, stats: sessionLogStats() });
});

/**
 * Live tail over SSE.
 *
 * Polling would work, but a terminal that lags a second behind the call it is
 * describing is much less useful for watching a generation actually happen.
 */
terminal.get('/terminal/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const since = Number(req.query.since) || 0;
  const backlog = readSessionLog(since);
  res.write(`event: init\ndata: ${JSON.stringify(backlog)}\n\n`);

  const unsubscribe = subscribeSessionLog((entry) => {
    try {
      res.write(`event: entry\ndata: ${JSON.stringify(entry)}\n\n`);
    } catch { /* client went away; cleanup runs on close */ }
  });

  // Proxies drop idle SSE connections; a comment frame is the cheapest keepalive.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 20_000);
  ping.unref?.();

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
    res.end();
  });
});
