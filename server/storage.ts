/**
 * File-system storage layer. Users own their data as plain files, ST-style.
 *
 * Privacy split (see AGENTS.md):
 * - `data/` = runtime only (app imports, chats, secrets). Gitignored + agent-hidden.
 * - `server/defaults/` = shipped package seeds (tracked; edited via code/agents).
 *
 * Encryption: when a vault is configured and unlocked, every write below is
 * sealed with AES-256-GCM under a per-file key (see `vault.ts`). Readers accept
 * both sealed and plain bytes, so an interrupted migration still opens cleanly.
 * Callers never see the difference.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JSONL_HEADER,
  isEncrypting,
  isSealed,
  openBuffer,
  openLine,
  relOf,
  sealBuffer,
  sealLine,
} from './vault';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');

export const dirs = {
  characters: path.join(DATA_DIR, 'characters'),
  avatars: path.join(DATA_DIR, 'avatars'),
  chats: path.join(DATA_DIR, 'chats'),
  groups: path.join(DATA_DIR, 'groups'),
  presets: path.join(DATA_DIR, 'presets'),
  instruct: path.join(DATA_DIR, 'instruct'),
  context: path.join(DATA_DIR, 'context'),
  sysprompt: path.join(DATA_DIR, 'sysprompt'),
  reasoning: path.join(DATA_DIR, 'reasoning'),
  lorebooks: path.join(DATA_DIR, 'lorebooks'),
  images: path.join(DATA_DIR, 'images'),
  styleProfiles: path.join(DATA_DIR, 'style-profiles'),
  quickreplies: path.join(DATA_DIR, 'quick-replies'),
  /** Per-character memory networks (see docs/brain-system.md). */
  brains: path.join(DATA_DIR, 'brains'),
  /** Global craft documents any character can draw on (see docs/skills-system.md). */
  skills: path.join(DATA_DIR, 'skills'),
};

export function ensureDataDirs(): void {
  for (const d of [DATA_DIR, ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });
}

export function sanitizeId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9._ -]/g, '_');
  if (!clean || clean.startsWith('.')) throw new Error(`Invalid id: ${id}`);
  return clean;
}

// ---- raw bytes (the single choke point every read/write funnels through) ----

/** Read a file, transparently unsealing it if it is ciphertext. */
export async function readBlob(file: string): Promise<Buffer> {
  const raw = await fsp.readFile(file);
  return isSealed(raw) ? openBuffer(raw, relOf(file)) : raw;
}

export function readBlobSync(file: string): Buffer {
  const raw = fs.readFileSync(file);
  return isSealed(raw) ? openBuffer(raw, relOf(file)) : raw;
}

/** Write a file, sealing it when the vault is unlocked. Atomic via rename. */
export async function writeBlob(file: string, data: Buffer | Uint8Array): Promise<void> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out = isEncrypting() ? sealBuffer(buf, relOf(file)) : buf;
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, out);
  await fsp.rename(tmp, file);
}

export function writeBlobSync(file: string, data: Buffer | Uint8Array): void {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out = isEncrypting() ? sealBuffer(buf, relOf(file)) : buf;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
}

// ---- JSON ----

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse((await readBlob(file)).toString('utf8')) as T;
  } catch (err: any) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readBlobSync(file).toString('utf8')) as T;
  } catch (err: any) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeBlob(file, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
}

export function writeJsonSync(file: string, data: unknown): void {
  writeBlobSync(file, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
}

export async function listJsonFiles<T>(dir: string): Promise<T[]> {
  const out: T[] = [];
  let files: string[] = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return out;
  }
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try {
      out.push(JSON.parse((await readBlob(path.join(dir, f))).toString('utf8')));
    } catch (err) {
      console.error(`Skipping corrupt file ${f}:`, err);
    }
  }
  return out;
}

// ---- JSONL chats ----
//
// Sealed JSONL keeps one encrypted record per line behind the vault header
// line, so appending a message stays a single O(1) append instead of a
// decrypt-rewrite-encrypt of the whole transcript.

export async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = (await fsp.readFile(file)).toString('utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines[0] !== JSONL_HEADER) return lines.map((l) => JSON.parse(l));
  const rel = relOf(file);
  return lines.slice(1).map((l) => JSON.parse(openLine(l, rel)));
}

export async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  const rel = relOf(file);
  const body = isEncrypting()
    ? [JSONL_HEADER, ...rows.map((r) => sealLine(JSON.stringify(r), rel))]
    : rows.map((r) => JSON.stringify(r));
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, body.join('\n') + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

export async function appendJsonl(file: string, row: unknown): Promise<void> {
  const json = JSON.stringify(row);
  if (!isEncrypting()) return fsp.appendFile(file, json + '\n', 'utf8');

  const rel = relOf(file);
  // A brand-new (or legacy plaintext) file needs the marker line first.
  let head = '';
  try {
    const fd = await fsp.open(file, 'r');
    try {
      const probe = Buffer.alloc(JSONL_HEADER.length);
      const { bytesRead } = await fd.read(probe, 0, probe.length, 0);
      if (bytesRead < probe.length || probe.toString('utf8') !== JSONL_HEADER) {
        // Existing plaintext transcript: upgrade it in place, then append.
        const rows = await readJsonl(file);
        await writeJsonl(file, [...rows, row]);
        return;
      }
    } finally {
      await fd.close();
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    head = `${JSONL_HEADER}\n`;
  }
  await fsp.appendFile(file, head + sealLine(json, rel) + '\n', 'utf8');
}

// ---- secrets (server-side only, never sent to client) ----

const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

export async function getSecret(key: string): Promise<string | undefined> {
  const secrets = await readJson<Record<string, string>>(SECRETS_FILE, {});
  return secrets[key];
}

export async function setSecret(key: string, value: string): Promise<void> {
  const secrets = await readJson<Record<string, string>>(SECRETS_FILE, {});
  if (value) secrets[key] = value;
  else delete secrets[key];
  await writeJsonAtomic(SECRETS_FILE, secrets);
}

export async function listSecretKeys(): Promise<string[]> {
  return Object.keys(await readJson<Record<string, string>>(SECRETS_FILE, {}));
}
