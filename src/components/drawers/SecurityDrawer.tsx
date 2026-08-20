/** Security — vault password, idle auto-lock, lock now. */
import { useEffect, useState } from 'react';
import { Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { GlobeLoader } from '../GlobeLoader';
import { api, notifyVaultLocked, type VaultStatus } from '../../api';
import { passwordStrength } from '../../lib/passwordStrength';
import { DrawerHeader } from './DrawerHost';

const AUTO_LOCK_CHOICES = [0, 5, 15, 30, 60, 240];

export function SecurityDrawer({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.vault.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  const encrypted = status?.state === 'unlocked';

  async function refresh() {
    setStatus(await api.vault.status().catch(() => null));
  }

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      setNote(await fn());
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DrawerHeader title="Security" onClose={onClose} />
      <div className="drawer-body">
        <div className={`sec-status ${encrypted ? 'is-on' : 'is-off'}`}>
          {encrypted ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
          <div>
            <strong>{encrypted ? 'Encryption on' : 'Encryption off'}</strong>
            <p className="t-caption">
              {encrypted
                ? 'Everything in data/ is sealed with AES-256-GCM. The key exists only in memory while unlocked.'
                : 'Chats, characters and API keys are stored as plain files on this computer.'}
            </p>
          </div>
        </div>

        {error && <p className="vault-error">{error}</p>}
        {note && <p className="sec-note">{note}</p>}

        {encrypted ? (
          <>
            <ChangePassword busy={busy} run={run} />
            <AutoLock status={status} busy={busy} run={run} />
            <section className="sec-section">
              <h3 className="sec-h">Lock now</h3>
              <p className="t-caption">Drops the key from memory immediately. You'll need the password again.</p>
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  await api.vault.lock();
                  notifyVaultLocked();
                }}
              >
                <Lock size={15} /> Lock Reverie
              </button>
            </section>
            <TurnOff busy={busy} run={run} />
          </>
        ) : (
          <TurnOn busy={busy} run={run} />
        )}
      </div>
    </>
  );
}

type Run = (fn: () => Promise<string>) => Promise<void>;

function ChangePassword({ busy, run }: { busy: boolean; run: Run }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const strength = passwordStrength(next);
  const ready = !!current && next.length >= 8 && next === confirm && next !== current && !busy;

  return (
    <section className="sec-section">
      <h3 className="sec-h">Change password</h3>
      <p className="t-caption">
        Instant — only the 32-byte master key is re-wrapped, so your chats are never rewritten.
      </p>
      <input className="input" type="password" autoComplete="current-password" placeholder="Current password"
        value={current} onChange={(e) => setCurrent(e.target.value)} />
      <input className="input" type="password" autoComplete="new-password" placeholder="New password"
        value={next} onChange={(e) => setNext(e.target.value)} />
      {next && (
        <div className="vault-strength">
          <div className="vault-strength-track">
            <div className={`vault-strength-bar s${strength.score}`} style={{ width: `${(strength.score + 1) * 20}%` }} />
          </div>
          <span>{strength.label}</span>
        </div>
      )}
      <input className="input" type="password" autoComplete="new-password" placeholder="Confirm new password"
        value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      {confirm && confirm !== next && <p className="vault-error">Passwords don't match.</p>}
      <button
        className="btn btn-primary"
        disabled={!ready}
        onClick={() =>
          run(async () => {
            await api.vault.changePassword(current, next, confirm);
            setCurrent('');
            setNext('');
            setConfirm('');
            return 'Password changed.';
          })
        }
      >
        {busy ? <><GlobeLoader size={15} /> Working…</> : 'Change password'}
      </button>
    </section>
  );
}

function AutoLock({ status, busy, run }: { status: VaultStatus | null; busy: boolean; run: Run }) {
  const mins = status?.autoLockMinutes ?? 0;
  return (
    <section className="sec-section">
      <h3 className="sec-h">Auto-lock when idle</h3>
      <p className="t-caption">Forgets the key after a quiet period, so a walked-away-from machine re-locks itself.</p>
      <div className="sec-chips">
        {AUTO_LOCK_CHOICES.map((m) => (
          <button
            key={m}
            className={`chip ${mins === m ? 'active' : ''}`}
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.vault.setAutoLock(m);
                return m ? `Auto-lock set to ${m} minutes.` : 'Auto-lock turned off.';
              })
            }
          >
            {m === 0 ? 'Never' : m < 60 ? `${m} min` : `${m / 60} hr`}
          </button>
        ))}
      </div>
    </section>
  );
}

function TurnOn({ busy, run }: { busy: boolean; run: Run }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  const strength = passwordStrength(password);
  const ready = password.length >= 8 && password === confirm && ack && !busy;

  return (
    <section className="sec-section">
      <h3 className="sec-h">Turn on encryption</h3>
      <p className="t-caption">
        Seals every existing file, then asks for this password each time Reverie starts.
        Long passphrases of a few unrelated words beat short complicated ones.
      </p>
      <input className="input" type="password" autoComplete="new-password" placeholder="Password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      {password && (
        <div className="vault-strength">
          <div className="vault-strength-track">
            <div className={`vault-strength-bar s${strength.score}`} style={{ width: `${(strength.score + 1) * 20}%` }} />
          </div>
          <span>{strength.label}</span>
        </div>
      )}
      <input className="input" type="password" autoComplete="new-password" placeholder="Confirm password"
        value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <label className="vault-check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand there is no recovery if I lose this password.</span>
      </label>
      <button
        className="btn btn-primary"
        disabled={!ready}
        onClick={() =>
          run(async () => {
            const r = await api.vault.setup(password, confirm);
            setPassword('');
            setConfirm('');
            setAck(false);
            return `Encryption on — ${r.encrypted} files sealed.`;
          })
        }
      >
        {busy ? <><GlobeLoader size={15} /> Encrypting…</> : 'Encrypt my data'}
      </button>
    </section>
  );
}

function TurnOff({ busy, run }: { busy: boolean; run: Run }) {
  const [password, setPassword] = useState('');
  const [open, setOpen] = useState(false);

  return (
    <section className="sec-section sec-danger">
      <h3 className="sec-h">Turn off encryption</h3>
      {!open ? (
        <button className="btn btn-ghost" onClick={() => setOpen(true)}>Decrypt everything…</button>
      ) : (
        <>
          <p className="t-caption">
            Writes every file back out as readable plaintext on this computer. Only do this if you
            want the data portable and unprotected.
          </p>
          <input className="input" type="password" autoComplete="current-password" placeholder="Confirm with your password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <button
            className="btn btn-danger"
            disabled={!password || busy}
            onClick={() =>
              run(async () => {
                const r = await api.vault.disable(password);
                setPassword('');
                setOpen(false);
                return `Encryption off — ${r.decrypted} files decrypted.`;
              })
            }
          >
            {busy ? <><GlobeLoader size={15} /> Decrypting…</> : 'Turn off encryption'}
          </button>
        </>
      )}
    </section>
  );
}
