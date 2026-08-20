/** World Info — lorebook list + full entry editor (ST parity). */
import { useRef, useState } from 'react';
import type { Lorebook, WIEntry } from '@shared/types';
import { WILogic, WIPosition } from '@shared/types';
import { api } from '../../api';
import { useApp } from '../../store';
import { DrawerHeader } from './DrawerHost';
import { useConfirm } from '../ConfirmDialog';

function blankEntry(uid: number): WIEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    selective: false,
    selectiveLogic: WILogic.AND_ANY,
    order: 100,
    position: WIPosition.Before,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    role: 0,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
  };
}

export function WorldInfoDrawer({ onClose }: { onClose: () => void }) {
  const confirm = useConfirm();
  const { settings, lorebooks, saveSettings, refreshLorebooks } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Lorebook | null>(null);
  const [entryIdx, setEntryIdx] = useState(0);
  const [status, setStatus] = useState('');
  if (!settings) return null;

  const wi = settings.wiSettings;
  const book = draft ?? lorebooks.find((b) => b.id === editingId) ?? null;
  const entry = book?.entries[entryIdx] ?? null;

  async function openBook(id: string) {
    const b = lorebooks.find((x) => x.id === id);
    if (!b) return;
    setEditingId(id);
    setDraft(JSON.parse(JSON.stringify(b)));
    setEntryIdx(0);
  }

  async function saveBook() {
    if (!draft) return;
    await api.updateLorebook(draft.id, draft);
    await refreshLorebooks();
    setStatus('Saved');
    setTimeout(() => setStatus(''), 1500);
  }

  async function createBook() {
    const name = prompt('Lorebook name:', 'New Lorebook');
    if (!name?.trim()) return;
    const created = await api.createLorebook({ name: name.trim(), entries: [blankEntry(0)] });
    await refreshLorebooks();
    const globals = useApp.getState().settings?.globalLorebooks ?? [];
    await saveSettings({ globalLorebooks: [...globals, created.id] });
    openBook(created.id);
  }

  function patchEntry(patch: Partial<WIEntry>) {
    if (!draft || !entry) return;
    const entries = draft.entries.map((e, i) => (i === entryIdx ? { ...e, ...patch } : e));
    setDraft({ ...draft, entries });
  }

  function addEntry() {
    if (!draft) return;
    const uid = Math.max(0, ...draft.entries.map((e) => e.uid)) + 1;
    setDraft({ ...draft, entries: [...draft.entries, blankEntry(uid)] });
    setEntryIdx(draft.entries.length);
  }

  function deleteEntry() {
    if (!draft || draft.entries.length < 1) return;
    const entries = draft.entries.filter((_, i) => i !== entryIdx);
    setDraft({ ...draft, entries });
    setEntryIdx(Math.max(0, entryIdx - 1));
  }

  // ---- list view ----
  if (!draft) {
    return (
      <>
        <DrawerHeader title="Lorebooks" onClose={onClose} />
        <div className="drawer-body">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void createBook()}>New Lorebook</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>Import</button>
            <input ref={fileRef} type="file" accept=".json" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const book = await api.importLorebook(f.name, JSON.parse(await f.text()));
              await refreshLorebooks();
              await saveSettings({ globalLorebooks: [...settings.globalLorebooks, book.id] });
              e.target.value = '';
            }} />
          </div>

          {lorebooks.length === 0 && <p className="t-caption">No lorebooks — create one or import ST world info JSON.</p>}
          {lorebooks.map((b) => {
            const on = settings.globalLorebooks.includes(b.id);
            return (
              <div key={b.id} className="panel" style={{ padding: 12, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={on}
                    title="Enable globally"
                    onChange={() => {
                      const globalLorebooks = on
                        ? settings.globalLorebooks.filter((id) => id !== b.id)
                        : [...settings.globalLorebooks, b.id];
                      void saveSettings({ globalLorebooks });
                    }}
                  />
                  <button type="button" className="t-label" style={{ background: 'none', border: 'none', color: 'var(--ink)', cursor: 'pointer', flex: 1, textAlign: 'left' }}
                    onClick={() => openBook(b.id)}>
                    {b.name}
                  </button>
                  <span className="t-caption">{b.entries.length} entries</span>
                  <a className="btn btn-ghost btn-sm" href={`/api/lorebooks/${b.id}/export.json`}>Export</a>
                  <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={async () => {
                    if (!await confirm({
                      title: `Delete \u201c${b.name}\u201d?`,
                      body: 'The lorebook and all of its entries are removed.',
                      confirmLabel: 'Delete lorebook',
                      danger: true,
                    })) return;
                    await api.deleteLorebook(b.id);
                    await refreshLorebooks();
                    await saveSettings({ globalLorebooks: settings.globalLorebooks.filter((id) => id !== b.id) });
                  }}>Delete</button>
                </div>
              </div>
            );
          })}

          <p className="t-section" style={{ margin: '20px 0 10px' }}>Scan settings</p>
          <label className="field-label">Depth</label>
          <input className="input" type="number" value={wi.depth}
            onChange={(e) => void saveSettings({ wiSettings: { ...wi, depth: Number(e.target.value) } })} />
          <label className="field-label" style={{ marginTop: 10 }}>Budget %</label>
          <input className="input" type="number" value={wi.budgetPercent}
            onChange={(e) => void saveSettings({ wiSettings: { ...wi, budgetPercent: Number(e.target.value) } })} />
          <label className="field-label" style={{ marginTop: 10 }}>Min activations</label>
          <input className="input" type="number" value={wi.minActivations}
            onChange={(e) => void saveSettings({ wiSettings: { ...wi, minActivations: Number(e.target.value) } })} />
          <label className="field-label" style={{ marginTop: 10 }}>Max recursion steps</label>
          <input className="input" type="number" value={wi.maxRecursionSteps}
            onChange={(e) => void saveSettings({ wiSettings: { ...wi, maxRecursionSteps: Number(e.target.value) } })} />
          {(['recursive', 'caseSensitive', 'matchWholeWords'] as const).map((k) => (
            <label key={k} className="fmt-check" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={wi[k]}
                onChange={(e) => void saveSettings({ wiSettings: { ...wi, [k]: e.target.checked } })} />
              <span>{k === 'recursive' ? 'Recursive' : k === 'caseSensitive' ? 'Case sensitive' : 'Match whole words'}</span>
            </label>
          ))}
        </div>
      </>
    );
  }

  // ---- editor view ----
  return (
    <>
      <DrawerHeader title={draft.name} onClose={() => { setDraft(null); setEditingId(null); }} />
      <div className="drawer-body">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setDraft(null); setEditingId(null); }}>← Books</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveBook()}>Save</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={addEntry}>+ Entry</button>
          {status && <span className="t-caption" style={{ color: 'var(--accent)', alignSelf: 'center' }}>{status}</span>}
        </div>

        <label className="field-label">Book name</label>
        <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />

        <label className="field-label" style={{ marginTop: 12 }}>Entries</label>
        <select className="input" value={entryIdx} onChange={(e) => setEntryIdx(Number(e.target.value))}>
          {draft.entries.map((e, i) => (
            <option key={e.uid} value={i}>
              {e.comment || e.key.join(', ') || `Entry ${e.uid}`}{e.disable ? ' (off)' : ''}
            </option>
          ))}
        </select>

        {entry && (
          <>
            <label className="field-label" style={{ marginTop: 12 }}>Comment / title</label>
            <input className="input" value={entry.comment} onChange={(e) => patchEntry({ comment: e.target.value })} />

            <label className="field-label" style={{ marginTop: 10 }}>Primary keys (comma-separated)</label>
            <input className="input" value={entry.key.join(', ')}
              onChange={(e) => patchEntry({ key: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />

            <label className="field-label" style={{ marginTop: 10 }}>Secondary keys</label>
            <input className="input" value={entry.keysecondary.join(', ')}
              onChange={(e) => patchEntry({ keysecondary: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />

            <label className="field-label" style={{ marginTop: 10 }}>Content</label>
            <textarea className="textarea" rows={6} value={entry.content}
              onChange={(e) => patchEntry({ content: e.target.value })} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
              <div>
                <label className="field-label">Order</label>
                <input className="input" type="number" value={entry.order}
                  onChange={(e) => patchEntry({ order: Number(e.target.value) })} />
              </div>
              <div>
                <label className="field-label">Position</label>
                <select className="input" value={entry.position}
                  onChange={(e) => patchEntry({ position: Number(e.target.value) as WIPosition })}>
                  <option value={0}>Before char</option>
                  <option value={1}>After char</option>
                  <option value={2}>AN top</option>
                  <option value={3}>AN bottom</option>
                  <option value={4}>At depth</option>
                  <option value={5}>EM top</option>
                  <option value={6}>EM bottom</option>
                </select>
              </div>
              <div>
                <label className="field-label">Depth (at-depth)</label>
                <input className="input" type="number" value={entry.depth}
                  onChange={(e) => patchEntry({ depth: Number(e.target.value) })} />
              </div>
              <div>
                <label className="field-label">Role (at-depth)</label>
                <select className="input" value={entry.role}
                  onChange={(e) => patchEntry({ role: Number(e.target.value) as 0 | 1 | 2 })}>
                  <option value={0}>System</option>
                  <option value={1}>User</option>
                  <option value={2}>Assistant</option>
                </select>
              </div>
              <div>
                <label className="field-label">Probability %</label>
                <input className="input" type="number" value={entry.probability}
                  onChange={(e) => patchEntry({ probability: Number(e.target.value) })} />
              </div>
              <div>
                <label className="field-label">Selective logic</label>
                <select className="input" value={entry.selectiveLogic}
                  onChange={(e) => patchEntry({ selectiveLogic: Number(e.target.value) as WILogic })}>
                  <option value={0}>AND ANY</option>
                  <option value={1}>NOT ALL</option>
                  <option value={2}>NOT ANY</option>
                  <option value={3}>AND ALL</option>
                </select>
              </div>
              <div>
                <label className="field-label">Inclusion group</label>
                <input className="input" value={entry.group}
                  onChange={(e) => patchEntry({ group: e.target.value })} />
              </div>
              <div>
                <label className="field-label">Group weight</label>
                <input className="input" type="number" value={entry.groupWeight}
                  onChange={(e) => patchEntry({ groupWeight: Number(e.target.value) })} />
              </div>
            </div>

            <div className="fmt-checks" style={{ marginTop: 10 }}>
              {([
                ['constant', 'Constant (always on)'],
                ['selective', 'Selective (use secondary keys)'],
                ['disable', 'Disabled'],
                ['useProbability', 'Use probability'],
                ['excludeRecursion', 'Exclude recursion'],
                ['preventRecursion', 'Prevent recursion'],
                ['groupOverride', 'Group override'],
              ] as const).map(([k, label]) => (
                <label key={k} className="fmt-check">
                  <input type="checkbox" checked={!!entry[k]}
                    onChange={(e) => patchEntry({ [k]: e.target.checked })} />
                  <span>{label}</span>
                </label>
              ))}
            </div>

            <button type="button" className="btn btn-ghost btn-sm btn-danger" style={{ marginTop: 12 }} onClick={deleteEntry}>
              Delete entry
            </button>
          </>
        )}
      </div>
    </>
  );
}
