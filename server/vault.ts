/**
 * Vault — at-rest encryption for everything under `data/`.
 *
 * Threat model: an attacker with *full* access to the machine's disk (stolen
 * laptop, backup, cloud sync, forensic image) must learn nothing about chats,
 * group chats, characters, personas or API keys without the password.
 *
 * Design
 * ------
 * password --scrypt(N=2^18,r=8,p=1)--> KEK --AES-256-GCM--> unwraps DEK (random 32B)
 * DEK --HKDF-SHA256(info = relative file path)--> per-file key --AES-256-GCM--> file
 *
 * - The password never touches disk. Only the scrypt salt and the DEK wrapped
 *   under the KEK live in `data/vault.json`.
 * - Wrong password = GCM tag mismatch on the DEK unwrap. There is no verifier
 *   to attack and no way to test a guess without paying the full scrypt cost
 *   (~0.5s and 256 MB of RAM per guess — that is what makes offline brute force
 *   hopeless for any non-trivial passphrase).
 * - Per-file subkeys are bound to the file's path, so ciphertext cannot be
 *   swapped between files (you can't drop someone else's chat in as yours).
 * - Changing the password only re-wraps the 32-byte DEK: instant, no rewrite
 *   of the corpus.
 * - Bulk crypto is AES-256-GCM, which runs on the CPU's AES-NI instructions
 *   at GB/s. Read/write cost is unmeasurable next to disk IO.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  pw: Buffer | string,
  salt: Buffer,
  keylen: number,
  opts: KdfParams,
) => Promise<Buffer>;

// ---- constants ----

/** File magic. Also the "is this already encrypted?" probe. */
const MAGIC = Buffer.from('NWv1');
/** Marker on line 1 of an encrypted JSONL file (append-friendly format). */
export const JSONL_HEADER = '#NWv1';
const NONCE = 12;
const TAG = 16;
const KEY = 32;
const WRAP_AAD = Buffer.from('reverie-vault-key-v1');
/** Previous wrap AAD; still accepted so existing vaults unlock, then re-wrap. */
const WRAP_AAD_LEGACY = Buffer.from('bmV3d29ybGQtdmF1bHQta2V5LXYx', 'base64');

interface KdfParams { N: number; r: number; p: number; maxmem: number }

/**
 * scrypt cost: 128*N*r = 256 MB and ~0.5s per guess on a modern desktop.
 * The memory term is the point — it denies an attacker the massive parallelism
 * a GPU or ASIC farm would otherwise bring to bear, since each guess in flight
 * needs its own 256 MB. Vault files record the params they were made with, so
 * raising this later does not orphan existing vaults.
 */
const KDF: KdfParams = { N: 1 << 18, r: 8, p: 1, maxmem: 640 * 1024 * 1024 };

export type VaultState = 'uninitialized' | 'locked' | 'unlocked';

interface VaultFile {
  version: 1;
  kdf: { algo: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  /** DEK sealed under the password-derived KEK. */
  wrapped: { nonce: string; tag: string; ct: string };
  /** HKDF salt for per-file subkey derivation (not secret). */
  fileSalt: string;
  createdAt: number;
  updatedAt: number;
  /** Idle minutes before the key is dropped from memory. 0 = never. */
  autoLockMinutes: number;
  /** True once a full encrypt sweep finished cleanly — lets unlock skip rescanning. */
  sealed: boolean;
  /** Brute-force throttle, persisted so a restart doesn't reset it. */
  failedAttempts: number;
  lockoutUntil: number;
}

// ---- module state (memory only) ----

let DATA_DIR = '';
let vaultPath = '';
let meta: VaultFile | null = null;
/** The Data Encryption Key. Present only while unlocked; never persisted. */
let dek: Buffer | null = null;
let fileSalt: Buffer | null = null;
let lastActivity = Date.now();
/** Per-path subkey cache — HKDF is cheap but this makes it free. */
const subkeys = new Map<string, Buffer>();

export function initVault(dataDir: string): void {
  DATA_DIR = dataDir;
  vaultPath = path.join(dataDir, 'vault.json');
  try {
    meta = JSON.parse(fs.readFileSync(vaultPath, 'utf8')) as VaultFile;
  } catch {
    meta = null;
  }
}

export function vaultState(): VaultState {
  if (!meta) return 'uninitialized';
  return dek ? 'unlocked' : 'locked';
}

/** True when files on disk should be ciphertext. */
export function isEncrypting(): boolean {
  return !!meta && !!dek;
}

export function vaultStatus() {
  return {
    state: vaultState(),
    autoLockMinutes: meta?.autoLockMinutes ?? 0,
    lockoutUntil: meta ? Math.max(0, meta.lockoutUntil - Date.now()) : 0,
    failedAttempts: meta?.failedAttempts ?? 0,
  };
}

export function touchActivity(): void {
  lastActivity = Date.now();
}

/** Called from a timer in index.ts. Drops the key after the idle window. */
export function enforceAutoLock(): boolean {
  const mins = meta?.autoLockMinutes ?? 0;
  if (!dek || !mins) return false;
  if (Date.now() - lastActivity < mins * 60_000) return false;
  lock();
  return true;
}

export function lock(): void {
  if (dek) dek.fill(0);
  for (const k of subkeys.values()) k.fill(0);
  subkeys.clear();
  dek = null;
}

// ---- key handling ----

/** KDF cost recorded in the vault file, so old vaults keep opening after a tuning change. */
function storedKdf(m: VaultFile): KdfParams {
  return { N: m.kdf.N, r: m.kdf.r, p: m.kdf.p, maxmem: KDF.maxmem };
}

function saveMeta(): void {
  if (!meta) return;
  meta.updatedAt = Date.now();
  const tmp = `${vaultPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  fs.renameSync(tmp, vaultPath);
}

async function deriveKek(password: string, salt: Buffer, params: KdfParams = KDF): Promise<Buffer> {
  // NFKC so the same typed passphrase derives the same key across platforms /
  // keyboards (accented and CJK input can arrive in different normal forms).
  return scrypt(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, KEY, params);
}

function wrapDek(kek: Buffer, key: Buffer): VaultFile['wrapped'] {
  const nonce = randomBytes(NONCE);
  const c = createCipheriv('aes-256-gcm', kek, nonce, { authTagLength: TAG });
  c.setAAD(WRAP_AAD);
  const ct = Buffer.concat([c.update(key), c.final()]);
  return { nonce: nonce.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function unwrapDekWith(kek: Buffer, w: VaultFile['wrapped'], aad: Buffer): Buffer | null {
  try {
    const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(w.nonce, 'base64'), { authTagLength: TAG });
    d.setAAD(aad);
    d.setAuthTag(Buffer.from(w.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(w.ct, 'base64')), d.final()]);
  } catch {
    return null; // tag mismatch == wrong password or wrong AAD
  }
}

function unwrapDek(kek: Buffer, w: VaultFile['wrapped']): { key: Buffer; legacy: boolean } | null {
  const current = unwrapDekWith(kek, w, WRAP_AAD);
  if (current) return { key: current, legacy: false };
  const legacy = unwrapDekWith(kek, w, WRAP_AAD_LEGACY);
  if (legacy) return { key: legacy, legacy: true };
  return null;
}

/**
 * Per-file key. Binding the path into the KDF info means a ciphertext lifted
 * from one file fails to authenticate in another.
 */
function keyFor(relPath: string): Buffer {
  if (!dek || !fileSalt) throw lockedError();
  const norm = relPath.split(path.sep).join('/').toLowerCase();
  const hit = subkeys.get(norm);
  if (hit) return hit;
  const k = Buffer.from(hkdfSync('sha256', dek, fileSalt, Buffer.from(`nwfile:${norm}`), KEY));
  subkeys.set(norm, k);
  return k;
}

export function relOf(file: string): string {
  return path.relative(DATA_DIR, file) || path.basename(file);
}

function lockedError(): Error {
  return Object.assign(new Error('Vault is locked'), { status: 423, code: 'locked' });
}

// ---- record-level crypto ----

/** MAGIC | nonce | tag | ciphertext */
export function sealBuffer(plain: Buffer, relPath: string): Buffer {
  const nonce = randomBytes(NONCE);
  const c = createCipheriv('aes-256-gcm', keyFor(relPath), nonce, { authTagLength: TAG });
  c.setAAD(Buffer.from(relPath, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, nonce, c.getAuthTag(), ct]);
}

export function openBuffer(blob: Buffer, relPath: string): Buffer {
  const d = createDecipheriv(
    'aes-256-gcm',
    keyFor(relPath),
    blob.subarray(MAGIC.length, MAGIC.length + NONCE),
    { authTagLength: TAG },
  );
  d.setAAD(Buffer.from(relPath, 'utf8'));
  d.setAuthTag(blob.subarray(MAGIC.length + NONCE, MAGIC.length + NONCE + TAG));
  return Buffer.concat([d.update(blob.subarray(MAGIC.length + NONCE + TAG)), d.final()]);
}

export function isSealed(blob: Buffer): boolean {
  return blob.length >= MAGIC.length + NONCE + TAG && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

/** One JSONL row -> one base64 record, so appends stay O(1). */
export function sealLine(text: string, relPath: string): string {
  const nonce = randomBytes(NONCE);
  const c = createCipheriv('aes-256-gcm', keyFor(relPath), nonce, { authTagLength: TAG });
  c.setAAD(Buffer.from(relPath, 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]).toString('base64');
}

export function openLine(b64: string, relPath: string): string {
  const buf = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', keyFor(relPath), buf.subarray(0, NONCE), { authTagLength: TAG });
  d.setAAD(Buffer.from(relPath, 'utf8'));
  d.setAuthTag(buf.subarray(NONCE, NONCE + TAG));
  return Buffer.concat([d.update(buf.subarray(NONCE + TAG)), d.final()]).toString('utf8');
}

// ---- lifecycle ----

export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 1024) return 'Password is too long.';
  return null;
}

/** Create the vault and unlock it. Caller is responsible for migrating files. */
export async function setupVault(password: string): Promise<void> {
  if (meta) throw Object.assign(new Error('Vault already exists'), { status: 409 });
  const bad = passwordProblem(password);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });

  const salt = randomBytes(32);
  const key = randomBytes(KEY);
  const kek = await deriveKek(password, salt);
  meta = {
    version: 1,
    kdf: { algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    wrapped: wrapDek(kek, key),
    fileSalt: randomBytes(32).toString('base64'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    autoLockMinutes: 0,
    sealed: false,
    failedAttempts: 0,
    lockoutUntil: 0,
  };
  kek.fill(0);
  saveMeta();
  dek = key;
  fileSalt = Buffer.from(meta.fileSalt, 'base64');
  touchActivity();
}

export async function unlockVault(password: string): Promise<void> {
  if (!meta) throw Object.assign(new Error('No vault configured'), { status: 409 });
  const wait = meta.lockoutUntil - Date.now();
  if (wait > 0) {
    throw Object.assign(new Error(`Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`), {
      status: 429,
      code: 'throttled',
    });
  }

  const kek = await deriveKek(password, Buffer.from(meta.kdf.salt, 'base64'), storedKdf(meta));
  const unwrapped = unwrapDek(kek, meta.wrapped);

  if (!unwrapped) {
    kek.fill(0);
    meta.failedAttempts += 1;
    // 0.5s, 1s, 2s, ... capped at 60s. Combined with the ~1s scrypt floor this
    // makes online guessing pointless; offline guessing is capped by scrypt.
    meta.lockoutUntil = Date.now() + Math.min(60_000, 500 * 2 ** Math.min(meta.failedAttempts - 1, 7));
    saveMeta();
    throw Object.assign(new Error('Incorrect password.'), { status: 401, code: 'bad_password' });
  }

  const key = unwrapped.key;
  let dirty = false;
  if (unwrapped.legacy) {
    meta.wrapped = wrapDek(kek, key);
    dirty = true;
  }
  kek.fill(0);

  if (meta.failedAttempts || meta.lockoutUntil) {
    meta.failedAttempts = 0;
    meta.lockoutUntil = 0;
    dirty = true;
  }
  if (dirty) saveMeta();
  dek = key;
  fileSalt = Buffer.from(meta.fileSalt, 'base64');
  touchActivity();
}

/** Re-wraps the DEK under a new password. Bulk data is untouched. */
export async function changePassword(current: string, next: string): Promise<void> {
  if (!meta) throw Object.assign(new Error('No vault configured'), { status: 409 });
  const bad = passwordProblem(next);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });

  const oldKek = await deriveKek(current, Buffer.from(meta.kdf.salt, 'base64'), storedKdf(meta));
  const unwrapped = unwrapDek(oldKek, meta.wrapped);
  oldKek.fill(0);
  if (!unwrapped) throw Object.assign(new Error('Current password is incorrect.'), { status: 401, code: 'bad_password' });
  const key = unwrapped.key;
  // If we were already unlocked, the unwrapped key must match the live one.
  if (dek && !timingSafeEqual(key, dek)) throw new Error('Vault key mismatch.');

  // Fresh salt on every change so old KDF work can never be reused.
  const salt = randomBytes(32);
  const newKek = await deriveKek(next, salt);
  meta.kdf = { algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') };
  meta.wrapped = wrapDek(newKek, key);
  newKek.fill(0);
  saveMeta();
  if (!dek) dek = key;
  else key.fill(0);
  fileSalt = Buffer.from(meta.fileSalt, 'base64');
}

/** True when a full sweep is still owed (fresh vault, or one interrupted mid-run). */
export function needsSweep(): boolean {
  return !!meta && !meta.sealed;
}

export function markSwept(sealed: boolean): void {
  if (!meta || meta.sealed === sealed) return;
  meta.sealed = sealed;
  saveMeta();
}

export function setAutoLockMinutes(mins: number): void {
  if (!meta) throw Object.assign(new Error('No vault configured'), { status: 409 });
  meta.autoLockMinutes = Math.max(0, Math.min(1440, Math.floor(mins) || 0));
  saveMeta();
  touchActivity();
}

/** Verify a password without changing lock state (used before destructive ops). */
export async function verifyPassword(password: string): Promise<boolean> {
  if (!meta) return false;
  const kek = await deriveKek(password, Buffer.from(meta.kdf.salt, 'base64'), storedKdf(meta));
  const unwrapped = unwrapDek(kek, meta.wrapped);
  kek.fill(0);
  if (!unwrapped) return false;
  unwrapped.key.fill(0);
  return true;
}

/** Tear the vault down after the corpus has been decrypted back to plaintext. */
export function destroyVault(): void {
  lock();
  meta = null;
  fileSalt = null;
  try {
    fs.unlinkSync(vaultPath);
  } catch {
    /* already gone */
  }
}

// ---- bulk migration ----

const SKIP = new Set(['vault.json']);

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && !SKIP.has(path.relative(DATA_DIR, full)) && !e.name.endsWith('.tmp')) yield full;
  }
}

/** JSONL files get line-record framing; everything else is one sealed blob. */
function isJsonl(file: string): boolean {
  return file.endsWith('.jsonl');
}

async function convert(file: string, direction: 'encrypt' | 'decrypt'): Promise<boolean> {
  const rel = relOf(file);
  const raw = await fsp.readFile(file);
  let out: Buffer;

  if (isJsonl(file)) {
    const text = raw.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const sealed = lines[0] === JSONL_HEADER;
    if (direction === 'encrypt') {
      if (sealed) return false;
      out = Buffer.from([JSONL_HEADER, ...lines.map((l) => sealLine(l, rel))].join('\n') + '\n', 'utf8');
    } else {
      if (!sealed) return false;
      out = Buffer.from(lines.slice(1).map((l) => openLine(l, rel)).join('\n') + '\n', 'utf8');
    }
  } else {
    const sealed = isSealed(raw);
    if (direction === 'encrypt') {
      if (sealed) return false;
      out = sealBuffer(raw, rel);
    } else {
      if (!sealed) return false;
      out = openBuffer(raw, rel);
    }
  }

  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, out);
  await fsp.rename(tmp, file);
  return true;
}

/**
 * Convert the whole corpus. Requires an unlocked vault. Returns how many files
 * changed. Per-file atomic rename, so a crash mid-run leaves a mix of sealed
 * and plain files — which the readers handle transparently, and a re-run
 * finishes the job.
 */
export async function migrateAll(direction: 'encrypt' | 'decrypt'): Promise<{ changed: number; failed: string[] }> {
  if (!dek) throw lockedError();
  let changed = 0;
  const failed: string[] = [];
  for (const file of walk(DATA_DIR)) {
    try {
      if (await convert(file, direction)) changed += 1;
    } catch (err) {
      failed.push(`${relOf(file)}: ${(err as Error).message}`);
    }
  }
  return { changed, failed };
}

/** Exposed for tests. */
export const __testing = { KDF, scryptSync };
