/** Preset drawer — switch, import, view, delete, and edit samplers. */
import { useRef, useState } from 'react';
import { Eye, Trash2, Upload } from 'lucide-react';
import { api } from '../../api';
import { useApp } from '../../store';
import { SamplerControls } from '../SamplerControls';
import { DrawerHeader } from './DrawerHost';
import { useConfirm } from '../ConfirmDialog';

export function PresetDrawer({ onClose }: { onClose: () => void }) {
  const confirm = useConfirm();
  const { presets, settings, setActivePresetId, setDrawer, loadAll, setPresets } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  if (!settings) return null;

  async function viewPreset(id: string) {
    await setActivePresetId(id);
    setDrawer('presetComposer');
  }

  async function deletePreset(id: string, name: string) {
    if (presets.length <= 1) {
      setNote('Keep at least one preset.');
      return;
    }
    if (!await confirm({
      title: `Delete preset \u201c${name}\u201d?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete preset',
      danger: true,
    })) return;
    const activeId = useApp.getState().settings?.activePresetId;
    setBusyId(id);
    setNote('');
    try {
      await api.deletePreset(id);
      const next = presets.filter((p) => p.id !== id);
      setPresets(next);
      if (activeId === id) {
        const fallback = next[0]?.id;
        if (fallback) await setActivePresetId(fallback);
      }
      setNote(`Deleted “${name}”`);
      setTimeout(() => setNote(''), 2000);
    } catch (e: any) {
      setNote(e.message ?? 'Delete failed');
    } finally {
      setBusyId(null);
    }
  }

  async function importFile(file: File) {
    setNote('');
    try {
      const json = JSON.parse(await file.text());
      const imported = await api.importPreset(file.name, json);
      await loadAll();
      await setActivePresetId(imported.id);
      setNote(`Imported “${imported.name}”`);
      setTimeout(() => setNote(''), 2500);
    } catch (e: any) {
      setNote(e.message ?? 'Import failed — use a valid ST/OpenAI preset JSON');
    }
  }

  return (
    <>
      <DrawerHeader title="Presets" onClose={onClose} />
      <div className="drawer-body">
        <label className="field-label">Active chat preset</label>
        <select
          className="input"
          value={settings.activePresetId}
          onChange={(e) => void setActivePresetId(e.target.value)}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDrawer('presetComposer')}>
            Compose prompts
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} />
            Import JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            multiple
            onChange={async (e) => {
              const files = e.target.files;
              if (!files?.length) return;
              for (const file of Array.from(files)) {
                await importFile(file);
              }
              e.target.value = '';
            }}
          />
        </div>

        {note && (
          <p className="t-caption" style={{ marginTop: 10, color: note.includes('fail') || note.includes('Keep') ? 'var(--danger)' : 'var(--accent)' }}>
            {note}
          </p>
        )}

        <p className="t-section" style={{ margin: '20px 0 10px' }}>All presets</p>
        <p className="t-caption" style={{ marginBottom: 10 }}>
          View opens the prompt composer for that preset. Delete removes it from the library.
        </p>
        <div className="preset-list">
          {presets.map((p) => {
            const active = p.id === settings.activePresetId;
            return (
              <div key={p.id} className={`preset-list-row${active ? ' is-active' : ''}`}>
                <button
                  type="button"
                  className="preset-list-main"
                  onClick={() => void setActivePresetId(p.id)}
                  title="Set active"
                >
                  <span className="preset-list-name">{p.name}</span>
                  <span className="t-caption">
                    {active ? 'Active · ' : ''}
                    ctx {p.max_context?.toLocaleString?.() ?? p.max_context}
                    {p.temperature != null ? ` · temp ${p.temperature}` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn preset-list-action"
                  title="View / edit prompts"
                  aria-label={`View ${p.name}`}
                  onClick={() => void viewPreset(p.id)}
                >
                  <Eye size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn preset-list-action icon-btn-danger"
                  title="Delete preset"
                  aria-label={`Delete ${p.name}`}
                  disabled={busyId === p.id || presets.length <= 1}
                  onClick={() => void deletePreset(p.id, p.name)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>

        <p className="t-section" style={{ margin: '22px 0 10px' }}>Samplers</p>
        <SamplerControls />
      </div>
    </>
  );
}
