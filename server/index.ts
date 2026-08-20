import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, ensureDataDirs } from './storage';
import { seedContent } from './seed';
import { enforceAutoLock, initVault, touchActivity, vaultState } from './vault';
import { vault } from './routes/vault';
import { library } from './routes/library';
import { chats } from './routes/chats';
import { timelineRoutes } from './routes/timelineRoutes';
import { generate } from './routes/generate';
import { brainRoutes } from './routes/brain';
import { startBrainSweeper } from './brain/sweeper';
import { terminal } from './routes/terminal';
import { skillRoutes } from './routes/skills';

const PORT = Number(process.env.PORT || 6969);
/** Pin to IPv4 loopback so Vite's proxy (127.0.0.1) never hits a dead ::1 race on Windows. */
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

ensureDataDirs();
initVault(DATA_DIR);
// With a vault present the app boots locked and holds no key, so seeding waits
// until unlock (see routes/vault.ts). Unencrypted installs seed as before.
if (vaultState() === 'uninitialized') seedContent();

const app = express();
app.use(express.json({ limit: '64mb' }));

/** Lightweight readiness probe for Start.bat / dev tooling. */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, port: PORT, vault: vaultState() });
});

app.use('/api', vault);

/**
 * Hard gate. While a vault exists and is locked, no route below can touch
 * `data/` — the decryption key simply isn't in memory.
 */
app.use('/api', (_req, res, next) => {
  if (vaultState() === 'locked') {
    return res.status(423).json({ error: 'Locked. Enter your password to unlock Reverie.', code: 'locked' });
  }
  touchActivity();
  next();
});

app.use('/api', library);
app.use('/api', chats);
app.use('/api', timelineRoutes);
app.use('/api', brainRoutes);
app.use('/api', generate);
app.use('/api', skillRoutes);
app.use('/api', terminal);

// production static build
const dist = path.join(ROOT, 'dist');
app.use(express.static(dist));
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(404).send('Run `npm run build` first, or use `npm run dev`.');
  });
});

// central error handler — every error surfaces as JSON, never a hung request
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status ?? 500).json({ error: err.message ?? 'Internal error' });
});

/** Idle auto-lock: drops the key from RAM after the configured quiet period. */
const autoLockTimer = setInterval(() => {
  if (enforceAutoLock()) console.log('[vault] auto-locked after idle timeout');
}, 15_000);
autoLockTimer.unref?.();

const server = app.listen(PORT, HOST, () => {
  console.log(`Reverie server listening on http://${HOST}:${PORT}`);
  /**
   * Memory formation must not depend on any single request completing. The
   * sweeper catches every conversation the inline trigger missed - aborted
   * streams, swipes, continues, plain user messages, crashes, restarts.
   */
  startBrainSweeper();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[server] Port ${PORT} is already in use. Close the other Reverie/node process (or whatever holds :${PORT}), then restart.`,
    );
  } else {
    console.error('[server] failed to bind:', err);
  }
  process.exit(1);
});
