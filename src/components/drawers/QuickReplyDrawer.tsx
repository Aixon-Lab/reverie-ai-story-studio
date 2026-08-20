/** Quick Reply sets — ST QR extension lite. */
import { useEffect, useState } from 'react';
import type { QuickReply, QuickReplySet } from '@shared/types';
import { api } from '../../api';
import { useApp } from '../../store';
import { DrawerHeader } from './DrawerHost';

export function QuickReplyDrawer({ onClose }: { onClose: () => void }) {
  const { settings, saveSettings } = useApp();
  const [sets, setSets] = useState<QuickReplySet[]>([]);
  const [setId, setSetId] = useState(settings?.activeQuickReplySetId ?? 'default');
  const [status, setStatus] = useState('');

  useEffect(() => {
    api.listQuickReplies().then((s) => {
      setSets(s);
      if (!s.find((x) => x.id === setId) && s[0]) setSetId(s[0].id);
    }).catch(console.error);
  }, []);

  if (!settings) return null;
  const current = sets.find((s) => s.id === setId) ?? sets[0];

  async function persist(next: QuickReplySet) {
    const saved = await api.updateQuickReplySet(next.id, next);
    setSets((list) => list.map((s) => (s.id === saved.id ? saved : s)));
    setStatus('Saved');
    setTimeout(() => setStatus(''), 1200);
  }

  function patchReply(i: number, p: Partial<QuickReply>) {
    if (!current) return;
    const replies = current.replies.map((r, idx) => (idx === i ? { ...r, ...p } : r));
    void persist({ ...current, replies });
  }

  return (
    <>
      <DrawerHeader title="Quick replies" onClose={onClose} />
      <div className="drawer-body">
        <p className="t-caption" style={{ marginBottom: 12 }}>
          Buttons under the composer. Messages can be plain text or slash commands (e.g. /continue).
        </p>

        <label className="field-label">Active set</label>
        <select
          className="input"
          value={setId}
          onChange={(e) => {
            setSetId(e.target.value);
            void saveSettings({ activeQuickReplySetId: e.target.value });
          }}
        >
          {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={async () => {
            const name = prompt('Set name:', 'My Replies');
            if (!name?.trim()) return;
            const created = await api.createQuickReplySet({ name: name.trim(), replies: [] });
            setSets((s) => [...s, created]);
            setSetId(created.id);
            await saveSettings({ activeQuickReplySetId: created.id });
          }}>New Set</button>
          {current && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => {
              const r: QuickReply = {
                id: `qr-${Date.now()}`,
                label: 'New',
                message: '',
                autoSend: false,
              };
              void persist({ ...current, replies: [...current.replies, r] });
            }}>+ Reply</button>
          )}
          {status && <span className="t-caption" style={{ color: 'var(--accent)', alignSelf: 'center' }}>{status}</span>}
        </div>

        {current?.replies.map((r, i) => (
          <div key={r.id} className="panel" style={{ padding: 12, marginTop: 12 }}>
            <label className="field-label">Label</label>
            <input className="input" value={r.label} onChange={(e) => patchReply(i, { label: e.target.value })} />
            <label className="field-label" style={{ marginTop: 8 }}>Message / command</label>
            <textarea className="textarea" rows={2} value={r.message}
              onChange={(e) => patchReply(i, { message: e.target.value })} />
            <label className="fmt-check" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={r.autoSend}
                onChange={(e) => patchReply(i, { autoSend: e.target.checked })} />
              <span>Auto-send</span>
            </label>
            <button type="button" className="btn btn-ghost btn-sm btn-danger" style={{ marginTop: 8 }}
              onClick={() => void persist({ ...current, replies: current.replies.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
