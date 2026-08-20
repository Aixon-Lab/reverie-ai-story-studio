/**
 * Dev API runner — keeps Express on :6969 even if the process crashes.
 * `tsx watch` can leave a live parent with a dead child; this restarts on exit
 * and on changes under server/ + shared/.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'server', 'index.ts');
const preflight = path.join(root, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
const loader = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const watchDirs = [path.join(root, 'server'), path.join(root, 'shared')];

let child = null;
let restartTimer = null;
let shuttingDown = false;

function clearRestart() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestart(reason, delayMs = 600) {
  if (shuttingDown) return;
  clearRestart();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    console.log(`[dev:server] restart (${reason})`);
    start();
  }, delayMs);
}

function stopChild() {
  if (!child) return;
  const proc = child;
  child = null;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    // already gone
  }
}

function start() {
  if (shuttingDown) return;
  stopChild();

  // Windows needs a beat after taskkill before the port is free again
  const launchDelay = process.platform === 'win32' ? 500 : 100;
  setTimeout(() => {
    if (shuttingDown) return;

    const proc = spawn(
      process.execPath,
      ['--require', preflight, '--import', loader, entry],
      {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
        windowsHide: true,
      },
    );
    child = proc;

    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      if (shuttingDown) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? '?'}`;
      console.error(`[dev:server] API process exited (${detail}); restarting in 1s…`);
      scheduleRestart('process exit', 1000);
    });
  }, launchDelay);
}

function watchTree(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (!/\.(ts|js|json|mjs|cjs)$/i.test(filename)) return;
      if (filename.includes(`${path.sep}node_modules${path.sep}`)) return;
      scheduleRestart(`change: ${filename}`, 300);
    });
  } catch (err) {
    console.warn(`[dev:server] watch failed for ${dir}:`, err?.message || err);
  }
}

for (const dir of watchDirs) watchTree(dir);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearRestart();
  stopChild();
  // Give taskkill a moment on Windows, then exit.
  setTimeout(() => process.exit(0), process.platform === 'win32' ? 400 : 0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (process.platform === 'win32') {
  // Ctrl+C via npm/concurrently often arrives as this on Windows.
  process.on('SIGHUP', shutdown);
}

console.log('[dev:server] watching server/ + shared/ — API on port 6969');
start();
