/**
 * Vault endpoints — the only routes reachable while the app is locked.
 *
 * Everything else is gated by `requireUnlocked` in index.ts, so with no
 * password there is no API surface that can read `data/` at all.
 */
import { Router } from 'express';
import {
  changePassword,
  destroyVault,
  markSwept,
  needsSweep,
  lock,
  migrateAll,
  passwordProblem,
  setAutoLockMinutes,
  setupVault,
  touchActivity,
  unlockVault,
  vaultState,
  vaultStatus,
  verifyPassword,
} from '../vault';
import { ensureDataDirs } from '../storage';
import { seedContent } from '../seed';

export const vault = Router();

/** Seeds can only be written once a key exists, so first-run seeding happens here. */
function afterUnlock(): void {
  ensureDataDirs();
  seedContent();
}

vault.get('/vault/status', (_req, res) => {
  res.json(vaultStatus());
});

/** First-time setup: create the vault, then seal everything already on disk. */
vault.post('/vault/setup', async (req, res) => {
  const { password, confirm } = req.body as { password: string; confirm?: string };
  const bad = passwordProblem(password);
  if (bad) return res.status(400).json({ error: bad });
  if (confirm !== undefined && confirm !== password) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  await setupVault(password);
  const result = await migrateAll('encrypt');
  markSwept(result.failed.length === 0);
  afterUnlock();
  res.json({ ...vaultStatus(), encrypted: result.changed, failed: result.failed });
});

vault.post('/vault/unlock', async (req, res) => {
  const { password } = req.body as { password: string };
  if (typeof password !== 'string') return res.status(400).json({ error: 'Password required.' });
  await unlockVault(password);
  // Normally a no-op: the corpus is already sealed and flagged as such, so
  // unlock costs one scrypt derivation and nothing else. The sweep only runs
  // when a previous setup was interrupted before it finished.
  let encrypted = 0;
  if (needsSweep()) {
    const result = await migrateAll('encrypt');
    markSwept(result.failed.length === 0);
    encrypted = result.changed;
  }
  afterUnlock();
  res.json({ ...vaultStatus(), encrypted });
});

vault.post('/vault/lock', (_req, res) => {
  lock();
  res.json(vaultStatus());
});

vault.post('/vault/change-password', async (req, res) => {
  const { current, next, confirm } = req.body as { current: string; next: string; confirm?: string };
  if (vaultState() !== 'unlocked') return res.status(423).json({ error: 'Unlock first.' });
  if (confirm !== undefined && confirm !== next) {
    return res.status(400).json({ error: 'New passwords do not match.' });
  }
  if (current === next) return res.status(400).json({ error: 'New password must differ from the current one.' });
  await changePassword(current, next);
  res.json({ ...vaultStatus(), ok: true });
});

vault.post('/vault/auto-lock', (req, res) => {
  if (vaultState() !== 'unlocked') return res.status(423).json({ error: 'Unlock first.' });
  const { minutes } = req.body as { minutes: number };
  setAutoLockMinutes(Number(minutes));
  res.json(vaultStatus());
});

/** Escape hatch: decrypt the corpus back to plain files and remove the vault. */
vault.post('/vault/disable', async (req, res) => {
  const { password } = req.body as { password: string };
  if (vaultState() !== 'unlocked') return res.status(423).json({ error: 'Unlock first.' });
  if (!(await verifyPassword(password))) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const result = await migrateAll('decrypt');
  if (result.failed.length) {
    // Leave the vault intact — half-decrypted data with no key would be lost.
    return res.status(500).json({ error: `Could not decrypt every file; vault kept. ${result.failed[0]}` });
  }
  destroyVault();
  res.json({ ...vaultStatus(), decrypted: result.changed });
});

vault.post('/vault/ping', (_req, res) => {
  touchActivity();
  res.json(vaultStatus());
});
