import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  changePassword,
  initVault,
  isSealed,
  lock,
  migrateAll,
  openBuffer,
  sealBuffer,
  setupVault,
  unlockVault,
  vaultState,
} from './vault';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-vault-'));
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  initVault(dir);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const PW = 'correct horse battery staple';

describe('vault', () => {
  it('starts uninitialized', () => {
    expect(vaultState()).toBe('uninitialized');
  });

  it('encrypts the existing corpus on setup and leaves no plaintext', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ activePresetId: 'default' }));
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ openai: 'sk-super-secret' }));
    fs.writeFileSync(
      path.join(dir, 'chats', 'a.jsonl'),
      `${JSON.stringify({ id: '1', content: 'a private confession' })}\n`,
    );

    await setupVault(PW);
    await migrateAll('encrypt');

    expect(vaultState()).toBe('unlocked');
    expect(fs.readFileSync(path.join(dir, 'secrets.json')).toString('utf8')).not.toContain('sk-super-secret');
    const jsonl = fs.readFileSync(path.join(dir, 'chats', 'a.jsonl')).toString('utf8');
    expect(jsonl).not.toContain('confession');
    expect(jsonl.split('\n')[0]).toBe('#NWv1');
    // The password itself never lands on disk.
    expect(fs.readFileSync(path.join(dir, 'vault.json')).toString('utf8')).not.toContain('horse');
  }, 30_000);

  it('round-trips a blob and rejects tampering', () => {
    const rel = 'chats/a.meta.json';
    const sealed = sealBuffer(Buffer.from('hello world'), rel);
    expect(isSealed(sealed)).toBe(true);
    expect(openBuffer(sealed, rel).toString()).toBe('hello world');

    const bitFlipped = Buffer.from(sealed);
    bitFlipped[bitFlipped.length - 1] ^= 1;
    expect(() => openBuffer(bitFlipped, rel)).toThrow();
  });

  it('binds ciphertext to its path, so files cannot be swapped', () => {
    const sealed = sealBuffer(Buffer.from('mine'), 'chats/a.meta.json');
    expect(() => openBuffer(sealed, 'chats/b.meta.json')).toThrow();
  });

  it('refuses a wrong password and opens with the right one', async () => {
    lock();
    expect(vaultState()).toBe('locked');
    await expect(unlockVault('wrong password')).rejects.toThrow(/Incorrect password/);
    // Throttle is in effect after a failure, so wait it out (first miss = 500ms).
    await new Promise((r) => setTimeout(r, 700));
    await unlockVault(PW);
    expect(vaultState()).toBe('unlocked');
  }, 30_000);

  it('changes password without rewriting data, and the old one stops working', async () => {
    const before = fs.readFileSync(path.join(dir, 'secrets.json'));
    await changePassword(PW, 'a different long passphrase');
    const after = fs.readFileSync(path.join(dir, 'secrets.json'));
    expect(after.equals(before)).toBe(true); // corpus untouched

    lock();
    await expect(unlockVault(PW)).rejects.toThrow(/Incorrect password/);
    await new Promise((r) => setTimeout(r, 700));
    await unlockVault('a different long passphrase');
    expect(vaultState()).toBe('unlocked');
  }, 60_000);

  it('decrypts back to the original plaintext', async () => {
    await migrateAll('decrypt');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).openai).toBe('sk-super-secret');
    const rows = fs
      .readFileSync(path.join(dir, 'chats', 'a.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(rows[0].content).toBe('a private confession');
  }, 30_000);
});
