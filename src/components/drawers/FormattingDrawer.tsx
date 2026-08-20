/**
 * Formatting drawer — full ST parity for System / Instruct / Context / Reasoning:
 * select, manual edit, Save, Save As, New, Delete, Import, Export, enable toggles.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSettings, ContextPreset, InstructPreset, ReasoningPreset, SyspromptPreset,
} from '@shared/types';
import {
  defaultContext, defaultInstruct, defaultReasoning, defaultSysprompt,
} from '@shared/codec/formatting';
import { api } from '../../api';
import { useApp } from '../../store';
import { DrawerHeader } from './DrawerHost';
import { useConfirm } from '../ConfirmDialog';

type Tab = 'sysprompt' | 'instruct' | 'context' | 'reasoning';
type AnyFmt = InstructPreset | ContextPreset | SyspromptPreset | ReasoningPreset;

const TAB_LABEL: Record<Tab, string> = {
  sysprompt: 'System',
  instruct: 'Instruct',
  context: 'Context',
  reasoning: 'Reasoning',
};

export function FormattingDrawer({ onClose }: { onClose: () => void }) {
  const confirm = useConfirm();
  const { settings, instruct, context, sysprompt, reasoning, saveSettings, loadAll } = useApp();
  const [tab, setTab] = useState<Tab>('sysprompt');
  const [draft, setDraft] = useState<AnyFmt | null>(null);
  const [status, setStatus] = useState('');
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const lists = useMemo(
    () => ({ instruct, context, sysprompt, reasoning }),
    [instruct, context, sysprompt, reasoning],
  );

  const settingKeys = {
    instruct: 'activeInstructId',
    context: 'activeContextId',
    sysprompt: 'activeSyspromptId',
    reasoning: 'activeReasoningId',
  } as const;

  const activeId = settings
    ? (tab === 'instruct'
      ? settings.activeInstructId
      : tab === 'context'
        ? settings.activeContextId
        : tab === 'sysprompt'
          ? settings.activeSyspromptId
          : settings.activeReasoningId)
    : '';

  const list = lists[tab];

  // Load draft when tab / active / list changes (don't clobber dirty edits of same id)
  useEffect(() => {
    if (!settings) return;
    const found = list.find((x) => x.id === activeId) ?? list[0] ?? blankFor(tab);
    setDraft(JSON.parse(JSON.stringify(found)));
    setDirty(false);
    setStatus('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed on tab/active/list identity
  }, [tab, activeId, list]);

  if (!settings || !draft) return null;

  function flash(msg: string) {
    setStatus(msg);
    setTimeout(() => setStatus(''), 2000);
  }

  function patchDraft(partial: Record<string, unknown>) {
    setDraft((d) => (d ? { ...d, ...partial } as AnyFmt : d));
    setDirty(true);
  }

  async function selectActive(id: string) {
    if (dirty && !await confirm({
      title: 'Discard unsaved edits?',
      body: 'Changes you have made here will be lost.',
      confirmLabel: 'Discard',
      danger: true,
    })) return;
    await saveSettings({ [settingKeys[tab]]: id } as Partial<AppSettings>);
  }

  async function save() {
    if (!draft) return;
    try {
      const saved = await updateFor(tab, draft.id, draft);
      await loadAll();
      await saveSettings({ [settingKeys[tab]]: saved.id } as Partial<AppSettings>);
      setDraft(JSON.parse(JSON.stringify(saved)));
      setDirty(false);
      flash('Saved');
    } catch (err: any) {
      setStatus(err.message);
    }
  }

  async function saveAs() {
    if (!draft) return;
    const name = prompt('Save as new preset name:', `${draft.name} (copy)`);
    if (!name?.trim()) return;
    try {
      const created = await createFor(tab, { ...draft, name: name.trim() });
      await loadAll();
      await saveSettings({ [settingKeys[tab]]: created.id } as Partial<AppSettings>);
      setDraft(JSON.parse(JSON.stringify(created)));
      setDirty(false);
      flash(`Saved as “${created.name}”`);
    } catch (err: any) {
      setStatus(err.message);
    }
  }

  async function createNew() {
    if (dirty && !await confirm({
      title: 'Discard unsaved edits?',
      body: 'Changes you have made here will be lost.',
      confirmLabel: 'Discard',
      danger: true,
    })) return;
    const name = prompt('New preset name:', `New ${TAB_LABEL[tab]}`);
    if (!name?.trim()) return;
    try {
      const blank = blankFor(tab);
      const created = await createFor(tab, { ...blank, name: name.trim() });
      await loadAll();
      await saveSettings({ [settingKeys[tab]]: created.id } as Partial<AppSettings>);
      setDirty(false);
      flash('Created');
    } catch (err: any) {
      setStatus(err.message);
    }
  }

  async function remove() {
    if (!draft) return;
    if (!await confirm({
      title: `Delete \u201c${draft.name}\u201d?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    try {
      await deleteFor(tab, draft.id);
      await loadAll();
      const remaining = (await listFor(tab)).filter((x) => x.id !== draft.id);
      const nextId = remaining[0]?.id ?? blankFor(tab).id;
      await saveSettings({ [settingKeys[tab]]: nextId } as Partial<AppSettings>);
      flash('Deleted');
    } catch (err: any) {
      setStatus(err.message);
    }
  }

  async function importFile(file: File) {
    const json = JSON.parse(await file.text());
    if (tab === 'instruct') await api.importInstruct(file.name, json);
    else if (tab === 'context') await api.importContext(file.name, json);
    else if (tab === 'sysprompt') await api.importSysprompt(file.name, json);
    else await api.importReasoning(file.name, json);
    await loadAll();
    flash('Imported');
  }

  return (
    <>
      <DrawerHeader title="Message format" onClose={onClose} />
      <div className="drawer-body">
        <div className="rail-tabs" style={{ marginBottom: 14 }}>
          {(['sysprompt', 'instruct', 'context', 'reasoning'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              className="rail-tab"
              data-active={tab === t || undefined}
              onClick={async () => {
                if (dirty && tab !== t && !await confirm({
                  title: 'Discard unsaved edits?',
                  body: 'Switching tabs will lose the changes you made here.',
                  confirmLabel: 'Discard',
                  danger: true,
                })) return;
                setTab(t);
              }}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>

        {/* Mode enables (ST power_user toggles) */}
        {tab === 'sysprompt' && (
          <label className="fmt-check">
            <input
              type="checkbox"
              checked={settings.syspromptEnabled}
              onChange={(e) => void saveSettings({ syspromptEnabled: e.target.checked })}
            />
            <span>Enable system prompt</span>
          </label>
        )}
        {tab === 'instruct' && (
          <label className="fmt-check">
            <input
              type="checkbox"
              checked={settings.instructEnabled}
              onChange={(e) => void saveSettings({ instructEnabled: e.target.checked })}
            />
            <span>Enable instruct mode</span>
          </label>
        )}
        {tab === 'reasoning' && (
          <div className="fmt-checks">
            <label className="fmt-check">
              <input
                type="checkbox"
                checked={settings.reasoningSettings.autoParse}
                onChange={(e) =>
                  void saveSettings({
                    reasoningSettings: { ...settings.reasoningSettings, autoParse: e.target.checked },
                  })
                }
              />
              <span>Auto-parse reasoning blocks</span>
            </label>
            <label className="fmt-check">
              <input
                type="checkbox"
                checked={settings.reasoningSettings.addToPrompts}
                onChange={(e) =>
                  void saveSettings({
                    reasoningSettings: { ...settings.reasoningSettings, addToPrompts: e.target.checked },
                  })
                }
              />
              <span>Add reasoning to prompts</span>
            </label>
            <label className="fmt-check">
              <input
                type="checkbox"
                checked={settings.reasoningSettings.autoExpand}
                onChange={(e) =>
                  void saveSettings({
                    reasoningSettings: { ...settings.reasoningSettings, autoExpand: e.target.checked },
                  })
                }
              />
              <span>Auto-expand reasoning UI</span>
            </label>
            <div style={{ marginTop: 8 }}>
              <label className="field-label">Max reasoning additions (0 = unlimited)</label>
              <input
                className="input"
                type="number"
                min={0}
                value={settings.reasoningSettings.maxAdditions}
                onChange={(e) =>
                  void saveSettings({
                    reasoningSettings: {
                      ...settings.reasoningSettings,
                      maxAdditions: Number(e.target.value) || 0,
                    },
                  })
                }
              />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label className="field-label">Active {TAB_LABEL[tab]} preset</label>
            <select className="input" value={activeId} onChange={(e) => void selectActive(e.target.value)}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              {!list.length && <option value={draft.id}>{draft.name}</option>}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void saveAs()}>
            Save As…
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void createNew()}>
            New
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
            Import
          </button>
          <a className="btn btn-ghost btn-sm" href={`/api/${tab}/${encodeURIComponent(draft.id)}/export.json`}>
            Export
          </a>
          <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={() => void remove()}>
            Delete
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await importFile(f);
              e.target.value = '';
            }}
          />
          {status && (
            <span className="t-caption" style={{ color: 'var(--accent)', alignSelf: 'center' }}>{status}</span>
          )}
          {dirty && !status && (
            <span className="t-caption" style={{ color: 'var(--ink-faint)', alignSelf: 'center' }}>Unsaved</span>
          )}
        </div>

        <div style={{ marginTop: 18 }}>
          <label className="field-label">Preset name</label>
          <input
            className="input"
            value={draft.name}
            onChange={(e) => patchDraft({ name: e.target.value })}
          />
        </div>

        {tab === 'sysprompt' && (
          <SyspromptEditor draft={draft as SyspromptPreset} onChange={patchDraft} />
        )}
        {tab === 'instruct' && (
          <InstructEditor draft={draft as InstructPreset} onChange={patchDraft} />
        )}
        {tab === 'context' && (
          <ContextEditor draft={draft as ContextPreset} onChange={patchDraft} />
        )}
        {tab === 'reasoning' && (
          <ReasoningEditor draft={draft as ReasoningPreset} onChange={patchDraft} />
        )}

        <p className="t-caption" style={{ marginTop: 20 }}>
          {list.length} {TAB_LABEL[tab].toLowerCase()} presets · edit freely, then Save or Save As.
        </p>
      </div>
    </>
  );
}

// ---------- field editors ----------

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <label className="field-label">{label}</label>
      {hint && <p className="t-caption" style={{ marginBottom: 6 }}>{hint}</p>}
      {children}
    </div>
  );
}

function SyspromptEditor({ draft, onChange }: {
  draft: SyspromptPreset;
  onChange: (p: Partial<SyspromptPreset>) => void;
}) {
  return (
    <>
      <Field label="Content" hint="Main system prompt. Macros like {{char}} / {{user}} are supported.">
        <textarea
          className="textarea"
          rows={10}
          value={draft.content}
          onChange={(e) => onChange({ content: e.target.value })}
          placeholder="Write the system prompt…"
        />
      </Field>
      <Field label="Post-history instructions" hint="Injected after chat history (ST post_history).">
        <textarea
          className="textarea"
          rows={5}
          value={draft.post_history}
          onChange={(e) => onChange({ post_history: e.target.value })}
          placeholder="Optional post-history block…"
        />
      </Field>
    </>
  );
}

function InstructEditor({ draft, onChange }: {
  draft: InstructPreset;
  onChange: (p: Partial<InstructPreset>) => void;
}) {
  const seq = (
    key: keyof InstructPreset,
    label: string,
  ) => (
    <Field label={label}>
      <input
        className="input"
        value={String(draft[key] ?? '')}
        onChange={(e) => onChange({ [key]: e.target.value })}
        spellCheck={false}
      />
    </Field>
  );

  return (
    <>
      <p className="t-caption" style={{ marginTop: 12 }}>
        Sequences wrap user / model / system turns (ChatML, Llama, etc.). Edit freely, then Save or Save As.
      </p>
      {seq('input_sequence', 'Input sequence (user prefix)')}
      {seq('input_suffix', 'Input suffix')}
      {seq('output_sequence', 'Output sequence (assistant prefix)')}
      {seq('output_suffix', 'Output suffix')}
      {seq('system_sequence', 'System sequence')}
      {seq('system_suffix', 'System suffix')}
      {seq('stop_sequence', 'Stop sequence')}
      {seq('first_input_sequence', 'First input sequence')}
      {seq('last_input_sequence', 'Last input sequence')}
      {seq('first_output_sequence', 'First output sequence')}
      {seq('last_output_sequence', 'Last output sequence')}
      {seq('last_system_sequence', 'Last system sequence')}
      {seq('user_alignment_message', 'User alignment message')}
      {seq('activation_regex', 'Activation regex')}
      {seq('story_string_prefix', 'Story string prefix')}
      {seq('story_string_suffix', 'Story string suffix')}

      <Field label="Names behavior">
        <select
          className="input"
          value={draft.names_behavior}
          onChange={(e) => onChange({ names_behavior: e.target.value })}
        >
          <option value="none">None</option>
          <option value="force">Force (groups)</option>
          <option value="always">Always</option>
        </select>
      </Field>

      <div className="fmt-checks" style={{ marginTop: 12 }}>
        {(
          [
            ['wrap', 'Wrap sequences'],
            ['macro', 'Substitute macros in sequences'],
            ['sequences_as_stop_strings', 'Sequences as stop strings'],
            ['bind_to_context', 'Bind to context template'],
            ['skip_examples', 'Skip example messages'],
            ['system_same_as_user', 'System same as user'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="fmt-check">
            <input
              type="checkbox"
              checked={!!draft[key]}
              onChange={(e) => onChange({ [key]: e.target.checked })}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </>
  );
}

function ContextEditor({ draft, onChange }: {
  draft: ContextPreset;
  onChange: (p: Partial<ContextPreset>) => void;
}) {
  return (
    <>
      <Field
        label="Story string"
        hint="Handlebars-style layout for system/description/personality/scenario/persona."
      >
        <textarea
          className="textarea"
          rows={12}
          value={draft.story_string}
          onChange={(e) => onChange({ story_string: e.target.value })}
          spellCheck={false}
        />
      </Field>
      <Field label="Example separator">
        <input className="input" value={draft.example_separator} onChange={(e) => onChange({ example_separator: e.target.value })} />
      </Field>
      <Field label="Chat start">
        <input className="input" value={draft.chat_start} onChange={(e) => onChange({ chat_start: e.target.value })} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 14 }}>
        <div>
          <label className="field-label">Story position</label>
          <input className="input" type="number" value={draft.story_string_position}
            onChange={(e) => onChange({ story_string_position: Number(e.target.value) })} />
        </div>
        <div>
          <label className="field-label">Story depth</label>
          <input className="input" type="number" value={draft.story_string_depth}
            onChange={(e) => onChange({ story_string_depth: Number(e.target.value) })} />
        </div>
        <div>
          <label className="field-label">Story role</label>
          <input className="input" type="number" value={draft.story_string_role}
            onChange={(e) => onChange({ story_string_role: Number(e.target.value) })} />
        </div>
      </div>
      <div className="fmt-checks" style={{ marginTop: 12 }}>
        <label className="fmt-check">
          <input type="checkbox" checked={draft.use_stop_strings}
            onChange={(e) => onChange({ use_stop_strings: e.target.checked })} />
          <span>Use stop strings</span>
        </label>
        <label className="fmt-check">
          <input type="checkbox" checked={draft.names_as_stop_strings}
            onChange={(e) => onChange({ names_as_stop_strings: e.target.checked })} />
          <span>Names as stop strings</span>
        </label>
        <label className="fmt-check">
          <input type="checkbox" checked={draft.always_force_name2}
            onChange={(e) => onChange({ always_force_name2: e.target.checked })} />
          <span>Always force character name</span>
        </label>
      </div>
    </>
  );
}

function ReasoningEditor({ draft, onChange }: {
  draft: ReasoningPreset;
  onChange: (p: Partial<ReasoningPreset>) => void;
}) {
  return (
    <>
      <Field label="Prefix" hint="Opens a think/reasoning block (e.g. &lt;think&gt;).">
        <input className="input" value={draft.prefix} onChange={(e) => onChange({ prefix: e.target.value })} spellCheck={false} />
      </Field>
      <Field label="Suffix" hint="Closes the block (e.g. &lt;/think&gt;).">
        <input className="input" value={draft.suffix} onChange={(e) => onChange({ suffix: e.target.value })} spellCheck={false} />
      </Field>
      <Field label="Separator">
        <input className="input" value={draft.separator} onChange={(e) => onChange({ separator: e.target.value })} spellCheck={false} />
      </Field>
    </>
  );
}

// ---------- helpers ----------

function blankFor(tab: Tab): AnyFmt {
  if (tab === 'instruct') return defaultInstruct();
  if (tab === 'context') return defaultContext();
  if (tab === 'sysprompt') return defaultSysprompt();
  return defaultReasoning();
}

async function createFor(tab: Tab, body: Partial<AnyFmt>) {
  if (tab === 'instruct') return api.createInstruct(body as Partial<InstructPreset>);
  if (tab === 'context') return api.createContext(body as Partial<ContextPreset>);
  if (tab === 'sysprompt') return api.createSysprompt(body as Partial<SyspromptPreset>);
  return api.createReasoning(body as Partial<ReasoningPreset>);
}

async function updateFor(tab: Tab, id: string, body: AnyFmt) {
  if (tab === 'instruct') return api.updateInstruct(id, body as InstructPreset);
  if (tab === 'context') return api.updateContext(id, body as ContextPreset);
  if (tab === 'sysprompt') return api.updateSysprompt(id, body as SyspromptPreset);
  return api.updateReasoning(id, body as ReasoningPreset);
}

async function deleteFor(tab: Tab, id: string) {
  if (tab === 'instruct') return api.deleteInstruct(id);
  if (tab === 'context') return api.deleteContext(id);
  if (tab === 'sysprompt') return api.deleteSysprompt(id);
  return api.deleteReasoning(id);
}

async function listFor(tab: Tab) {
  if (tab === 'instruct') return api.listInstruct();
  if (tab === 'context') return api.listContext();
  if (tab === 'sysprompt') return api.listSysprompt();
  return api.listReasoning();
}
