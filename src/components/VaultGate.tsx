/**
 * VaultGate — the app's front door.
 *
 * Nothing under it renders until the server holds a decryption key, and any
 * 423 from the API (auto-lock, restart, manual lock) snaps straight back here.
 * The password is only ever held in this component's state and posted once; it
 * is never stored, cached, or written anywhere.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lock, ShieldCheck } from 'lucide-react';
import { GlobeLoader } from './GlobeLoader';
import { api, onVaultLocked, type VaultStatus } from '../api';
import { BrandLogo } from './BrandLogo';
import { passwordStrength } from '../lib/passwordStrength';

type Phase = 'checking' | 'setup' | 'locked' | 'open' | 'offline';

export function VaultGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState('');

  const probe = useCallback(async () => {
    try {
      const s = await api.vault.status();
      setStatus(s);
      setPhase(s.state === 'unlocked' ? 'open' : s.state === 'locked' ? 'locked' : 'setup');
    } catch (err: any) {
      setError(err?.message || 'Cannot reach the Reverie server.');
      setPhase('offline');
    }
  }, []);

  useEffect(() => { probe(); }, [probe]);

  // Server dropped its key mid-session → back to the lock screen.
  useEffect(
    () =>
      onVaultLocked(() => {
        setPhase((p) => (p === 'open' ? 'locked' : p));
      }),
    [],
  );

  if (phase === 'open') return <>{children}</>;

  return (
    <div className="vault-gate">
      <motion.div
        className="vault-card"
        initial={{ opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="vault-brand">
          <BrandLogo size="lg" />
        </div>

        {phase === 'checking' && (
          <p className="vault-hint vault-center">
            <GlobeLoader size={16} /> Checking vault…
          </p>
        )}

        {phase === 'offline' && (
          <>
            <h1 className="vault-title">Server unreachable</h1>
            <p className="vault-hint">{error}</p>
            <button className="vault-btn" onClick={probe}>Retry</button>
          </>
        )}

        {phase === 'locked' && <UnlockForm status={status} onOpen={probe} />}
        {phase === 'setup' && <SetupForm onDone={probe} onSkip={() => setPhase('open')} />}
      </motion.div>
    </div>
  );
}

// ---------- unlock ----------

function UnlockForm({ status, onOpen }: { status: VaultStatus | null; onOpen: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(Math.ceil((status?.lockoutUntil ?? 0) / 1000));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || cooldown > 0 || !password) return;
    setBusy(true);
    setError('');
    try {
      await api.vault.unlock(password);
      setPassword('');
      onOpen();
    } catch (err: any) {
      setError(err?.message || 'Unlock failed.');
      const wait = /in (\d+)s/.exec(err?.message || '');
      if (wait) setCooldown(Number(wait[1]));
      else {
        const s = await api.vault.status().catch(() => null);
        if (s?.lockoutUntil) setCooldown(Math.ceil(s.lockoutUntil / 1000));
      }
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h1 className="vault-title"><Lock size={18} /> Reverie is locked</h1>
      <p className="vault-hint">
        Your chats, characters and API keys are encrypted on disk. Enter your password to open them.
      </p>
      <input
        ref={inputRef}
        className="vault-input"
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy || cooldown > 0}
      />
      <AnimatePresence>
        {error && (
          <motion.p
            className="vault-error"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
      <button className="vault-btn" type="submit" disabled={busy || cooldown > 0 || !password}>
        {busy ? <><GlobeLoader size={15} /> Unlocking…</> : cooldown > 0 ? `Wait ${cooldown}s` : 'Unlock'}
      </button>
      <p className="vault-fineprint">
        There is no recovery. If the password is lost the data cannot be read by anyone, including you.
      </p>
    </form>
  );
}

// ---------- first-run setup ----------

function SetupForm({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);

  const strength = passwordStrength(password);
  const ready = password.length >= 8 && password === confirm && ack && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      await api.vault.setup(password, confirm);
      setPassword('');
      setConfirm('');
      onDone();
    } catch (err: any) {
      setError(err?.message || 'Could not set up encryption.');
    } finally {
      setBusy(false);
    }
  }

  if (!choosing) {
    return (
      <>
        <h1 className="vault-title"><ShieldCheck size={18} /> Encrypt your data</h1>
        <p className="vault-hint">
          Set a password and everything in <code>data/</code> — chats, group chats, characters,
          personas, lorebooks, portraits and API keys — is sealed with AES-256. Without the
          password the files are unreadable to anyone with access to this computer.
        </p>
        <button className="vault-btn" onClick={() => setChoosing(true)}>Set a password</button>
        <button className="vault-btn vault-btn-ghost" onClick={onSkip}>
          Not now — keep data unencrypted
        </button>
        <p className="vault-fineprint">You can turn this on later from Security in the sidebar.</p>
      </>
    );
  }

  return (
    <form onSubmit={submit}>
      <h1 className="vault-title"><ShieldCheck size={18} /> Choose a password</h1>
      <p className="vault-hint">
        Long beats complicated. Four or five unrelated words are far harder to crack than
        <code>P@ssw0rd!</code> and much easier to remember.
      </p>
      <input
        className="vault-input"
        type="password"
        autoComplete="new-password"
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      {password && (
        <div className="vault-strength">
          <div className="vault-strength-track">
            <div className={`vault-strength-bar s${strength.score}`} style={{ width: `${(strength.score + 1) * 20}%` }} />
          </div>
          <span>{strength.label}</span>
        </div>
      )}
      <input
        className="vault-input"
        type="password"
        autoComplete="new-password"
        placeholder="Confirm password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {confirm && confirm !== password && <p className="vault-error">Passwords don't match.</p>}
      <label className="vault-check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand there is no recovery — if I lose this password, the data is gone for good.</span>
      </label>
      {error && <p className="vault-error">{error}</p>}
      <button className="vault-btn" type="submit" disabled={!ready}>
        {busy ? <><GlobeLoader size={15} /> Encrypting your data…</> : 'Encrypt and continue'}
      </button>
      <button className="vault-btn vault-btn-ghost" type="button" onClick={() => setChoosing(false)} disabled={busy}>
        Back
      </button>
    </form>
  );
}
