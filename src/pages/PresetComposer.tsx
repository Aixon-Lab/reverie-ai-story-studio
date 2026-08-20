/** Preset Composer — the full ST Prompt Manager, visual: drag-reorder, toggle, edit, add, samplers, utility prompts. */
import { useMemo, useState } from 'react';
import { Reorder } from 'framer-motion';
import type { Preset, PresetPrompt, PromptOrderEntry } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';
import { SamplerControls } from '../components/SamplerControls';
import { useConfirm } from '../components/ConfirmDialog';
import { PageLoader } from '../components/GlobeLoader';

export function PresetComposer() {
  const { presets, settings, setPresets, setActivePresetId } = useApp();
  const patch = useApp((s) => s.patchActivePreset);
  const commit = useApp((s) => s.commitActivePreset);
  const preset = useApp((s) => s.activePreset());
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const orderedPrompts = useMemo(() => {
    if (!preset) return [];
    return preset.prompt_order
      .map((o) => ({ order: o, prompt: preset.prompts.find((p) => p.identifier === o.identifier) }))
      .filter((x): x is { order: PromptOrderEntry; prompt: PresetPrompt } => !!x.prompt);
  }, [preset]);

  if (!preset || !settings) return <PageLoader label="Opening the preset…" />;

  function flash(msg: string) {
    setStatus(msg);
    setTimeout(() => setStatus(''), 1600);
  }

  async function commitNow() {
    await commit();
    flash('Saved');
  }

  function setOrder(newOrder: PromptOrderEntry[]) {
    patch({ prompt_order: newOrder });
  }

  function toggle(identifier: string) {
    patch({
      prompt_order: preset!.prompt_order.map((o) =>
        o.identifier === identifier ? { ...o, enabled: !o.enabled } : o),
    });
    void commitNow();
  }

  function updatePrompt(identifier: string, up: Partial<PresetPrompt>) {
    patch({ prompts: preset!.prompts.map((p) => (p.identifier === identifier ? { ...p, ...up } : p)) });
  }

  function addPrompt() {
    const id = `custom-${Date.now().toString(36)}`;
    patch({
      prompts: [...preset!.prompts, { identifier: id, name: 'New Prompt', role: 'system', content: '', system_prompt: false, marker: false }],
      prompt_order: [...preset!.prompt_order, { identifier: id, enabled: true }],
    });
    setEditingId(id);
  }

  function removePrompt(identifier: string) {
    patch({
      prompts: preset!.prompts.filter((p) => p.identifier !== identifier),
      prompt_order: preset!.prompt_order.filter((o) => o.identifier !== identifier),
    });
    void commitNow();
  }

  async function duplicatePreset() {
    const copy = { ...preset!, id: `${preset!.id}-copy-${Date.now().toString(36)}`, name: `${preset!.name} (copy)` };
    const saved = await api.updatePreset(copy.id, copy);
    setPresets([...presets, saved]);
    await setActivePresetId(saved.id);
    flash('Duplicated');
  }

  async function deletePreset() {
    if (presets.length <= 1) {
      setStatus('Keep at least one preset.');
      return;
    }
    const ok = await confirm({
      title: `Delete preset “${preset!.name}”?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete preset',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deletePreset(preset!.id);
      const next = presets.filter((p) => p.id !== preset!.id);
      setPresets(next);
      await setActivePresetId(next[0].id);
      flash('Deleted');
    } catch (err: any) {
      setStatus(err.message ?? 'Delete failed');
    }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '26px 35px' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
          <h1 className="t-display-md">Presets</h1>
          <select className="input" style={{ width: 220 }} value={settings.activePresetId}
            onChange={(e) => setActivePresetId(e.target.value)}>
            {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="input" style={{ width: 200 }} value={preset.name}
            onChange={(e) => patch({ name: e.target.value })} onBlur={commitNow} title="Preset name" />
          <span style={{ flex: 1 }} />
          <span className="t-caption" style={{ color: 'var(--accent)' }}>{status}</span>
          <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
            Import
            <input type="file" accept=".json" style={{ display: 'none' }} onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const imported = await api.importPreset(f.name, JSON.parse(await f.text()));
                setPresets([...presets, imported]);
                await setActivePresetId(imported.id);
                flash('Imported');
              } catch (err: any) { setStatus(`Import failed: ${err.message}`); }
            }} />
          </label>
          <a className="btn btn-secondary btn-sm" href={`/api/presets/${preset.id}/export.json`}>Export</a>
          <button className="btn btn-secondary btn-sm" onClick={() => void duplicatePreset()}>Duplicate</button>
          <button
            className="btn btn-ghost btn-sm btn-danger"
            onClick={() => void deletePreset()}
            disabled={presets.length <= 1}
            title={presets.length <= 1 ? 'Keep at least one preset' : 'Delete this preset'}
          >
            Delete
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 26, alignItems: 'start' }}>
          {/* Prompt order */}
          <section className="panel">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
              <h2 className="t-heading">Prompt Order</h2>
              <span className="t-caption">Drag to reorder · click a name to edit · JSON import/export</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm" onClick={addPrompt}>+ Add Prompt</button>
            </div>
            <Reorder.Group axis="y" as="div" values={orderedPrompts.map((x) => x.order.identifier)}
              onReorder={(ids: string[]) => setOrder(ids.map((id) => preset.prompt_order.find((o) => o.identifier === id)!))}>
              {orderedPrompts.map(({ order, prompt }) => (
                <Reorder.Item key={order.identifier} value={order.identifier} as="div"
                  onDragEnd={() => commitNow()}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px',
                    borderBottom: '1px solid var(--hairline)', background: 'var(--canvas)',
                    opacity: order.enabled ? 1 : 0.45, cursor: 'grab',
                  }}>
                  <span className="t-caption" style={{ cursor: 'grab', userSelect: 'none' }}>⋮⋮</span>
                  <button
                    onClick={() => setEditingId(editingId === prompt.identifier ? null : prompt.identifier)}
                    style={{ background: 'none', border: 'none', color: 'var(--ink)', cursor: 'pointer', textAlign: 'left', flex: 1 }}>
                    <span className="t-label">{prompt.name}</span>
                    <span className="t-caption" style={{ marginLeft: 8 }}>
                      {prompt.marker ? 'Marker — filled by the engine' : `${prompt.role ?? 'system'}${prompt.content ? ` · ${prompt.content.length} chars` : ''}`}
                    </span>
                  </button>
                  {!prompt.marker && !prompt.identifier.match(/^(main|nsfw|jailbreak|enhanceDefinitions)$/) && (
                    <button className="btn btn-ghost btn-sm btn-danger" style={{ height: 32, padding: '0 12px' }}
                      onClick={() => removePrompt(prompt.identifier)}>Remove</button>
                  )}
                  <button className={`chip ${order.enabled ? 'active' : ''}`} style={{ height: 22 }}
                    onClick={() => toggle(order.identifier)}>
                    {order.enabled ? 'On' : 'Off'}
                  </button>
                </Reorder.Item>
              ))}
            </Reorder.Group>

            {editingId && (() => {
              const p = preset.prompts.find((x) => x.identifier === editingId);
              if (!p || p.marker) return null;
              return (
                <div style={{ marginTop: 18, padding: 18, border: '1px solid var(--hairline-strong)', borderRadius: 'var(--r-input)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 14, marginBottom: 12 }}>
                    <div>
                      <label className="field-label">Name</label>
                      <input className="input" value={p.name} onChange={(e) => updatePrompt(p.identifier, { name: e.target.value })} />
                    </div>
                    <div>
                      <label className="field-label">Role</label>
                      <select className="input" value={p.role ?? 'system'}
                        onChange={(e) => updatePrompt(p.identifier, { role: e.target.value as PresetPrompt['role'] })}>
                        <option value="system">System</option>
                        <option value="user">User</option>
                        <option value="assistant">Assistant</option>
                      </select>
                    </div>
                  </div>
                  <label className="field-label">Content (macros like {'{{char}}'} and {'{{user}}'} work here)</label>
                  <textarea className="textarea" rows={6} value={p.content ?? ''}
                    onChange={(e) => updatePrompt(p.identifier, { content: e.target.value })} />
                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Close</button>
                    <button className="btn btn-primary btn-sm" onClick={() => { void commitNow(); setEditingId(null); }}>Save</button>
                  </div>
                </div>
              );
            })()}
          </section>

          {/* Right column: samplers + utility prompts */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
            <section className="panel">
              <h2 className="t-heading" style={{ marginBottom: 16 }}>Generation</h2>
              <SamplerControls />
            </section>
            <section className="panel">
              <h2 className="t-heading" style={{ marginBottom: 6 }}>Utility Prompts</h2>
              <p className="t-caption" style={{ marginBottom: 14 }}>The connective tissue — group nudge, impersonation, chat headers.</p>
              {(Object.entries(preset.utility_prompts) as [keyof Preset['utility_prompts'], string][]).map(([key, value]) => (
                <div key={key} style={{ marginBottom: 12 }}>
                  <label className="field-label">{key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</label>
                  <textarea className="textarea" rows={value.length > 60 ? 2 : 1} style={{ minHeight: 34 }} value={value}
                    onChange={(e) => patch({ utility_prompts: { ...preset.utility_prompts, [key]: e.target.value } })}
                    onBlur={commitNow} />
                </div>
              ))}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
