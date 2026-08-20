/**
 * Skills — the global craft library.
 *
 * One screen owns the whole lifecycle: what exists, what is switched on, what
 * each one costs, and the editor that writes them. The switches sit next to the
 * token cost on purpose — a skill's price is the only thing that decides
 * whether having ten of them is clever or ruinous, and hiding it in a settings
 * panel is how people end up with a context window full of documents nobody
 * chose.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Skill, SkillMode } from '@shared/skills/types';
import { MAX_SKILL_SHARE } from '@shared/skills/types';
import { api, streamSkillDraft, type SkillDraft } from '../api';
import { useApp } from '../store';
import { useConfirm } from '../components/ConfirmDialog';
import { GlobeLoader, PageLoader } from '../components/GlobeLoader';

type Draft = Partial<Skill> & { keywordsText?: string; tagsText?: string };

export function SkillsPage() {
  const { settings, saveSettings } = useApp();
  const confirm = useConfirm();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [rosterTokens, setRosterTokens] = useState(0);
  const [authoring, setAuthoring] = useState(false);
  const [ready, setReady] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const cfg = settings?.skills;

  const refresh = useCallback(async () => {
    try {
      const [list, roster] = await Promise.all([api.listSkills(), api.skillRoster()]);
      setSkills(list);
      setRosterTokens(roster.tokens);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void refresh().catch(console.error); }, [refresh]);

  const flash = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(''), 1600);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) =>
      s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q)
      || s.tags.some((t) => t.toLowerCase().includes(q)));
  }, [skills, query]);

  /** Tokens spent on every turn no matter what — the honest cost of `always`. */
  const alwaysCost = useMemo(
    () => skills.filter((s) => s.enabled && s.mode === 'always').reduce((n, s) => n + s.tokens, 0),
    [skills],
  );

  function openEditor(skill: Skill | null) {
    if (!skill) {
      setSelectedId(null);
      setDraft({
        name: '', description: '', body: '', mode: 'auto', priority: 50,
        stickyTurns: 2, enabled: true, keywordsText: '', tagsText: '',
      });
      return;
    }
    setSelectedId(skill.id);
    setDraft({ ...skill, keywordsText: skill.keywords.join(', '), tagsText: skill.tags.join(', ') });
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draft.name?.trim()) return flash('Give the skill a name first.');
    if (!draft.body?.trim()) return flash('A skill with no document has nothing to teach.');

    const payload: Partial<Skill> = {
      ...draft,
      name: draft.name.trim(),
      description: draft.description?.trim() ?? '',
      keywords: splitField(draft.keywordsText),
      tags: splitField(draft.tagsText),
    };
    delete (payload as Draft).keywordsText;
    delete (payload as Draft).tagsText;

    const saved = selectedId
      ? await api.updateSkill(selectedId, payload)
      : await api.createSkill(payload);
    await refresh();
    setSelectedId(saved.id);
    setDraft({ ...saved, keywordsText: saved.keywords.join(', '), tagsText: saved.tags.join(', ') });
    flash('Saved');
  }

  async function patchSkill(skill: Skill, patch: Partial<Skill>) {
    const saved = await api.updateSkill(skill.id, { ...skill, ...patch });
    setSkills((list) => list.map((s) => (s.id === saved.id ? saved : s)));
    if (selectedId === saved.id) {
      setDraft({ ...saved, keywordsText: saved.keywords.join(', '), tagsText: saved.tags.join(', ') });
    }
    void api.skillRoster().then((r) => setRosterTokens(r.tokens)).catch(() => {});
  }

  async function removeSkill(skill: Skill) {
    const ok = await confirm({
      title: `Delete “${skill.name}”?`,
      body: 'The document is gone for good. Chats that had it armed simply stop using it.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await api.deleteSkill(skill.id);
    if (selectedId === skill.id) { setSelectedId(null); setDraft(null); }
    await refresh();
    flash('Deleted');
  }

  async function onFile(file: File) {
    const text = await file.text();
    try {
      const skill = file.name.endsWith('.json')
        ? await api.importSkill({ filename: file.name, json: JSON.parse(text) })
        : await api.importSkill({ filename: file.name, text });
      await refresh();
      openEditor(skill);
      flash(`Imported ${skill.name}`);
    } catch (err: any) {
      flash(err?.message ?? 'Import failed.');
    }
  }

  async function exportSkill(skill: Skill) {
    const { filename, text } = await api.exportSkill(skill.id);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!settings || !ready) return <PageLoader label="Opening skills…" />;

  return (
    <div className="skills-page">
      <header className="skills-head">
        <div>
          <h1 className="t-display-md">Skills</h1>
          <p className="t-body-lg t-faint" style={{ maxWidth: 620, marginTop: 6 }}>
            Craft documents every character can draw on. Only a one-line summary travels each
            turn; the full document is loaded once a scene actually calls for it, and it takes
            effect from the turn after that.
          </p>
        </div>
        <div className="skills-head-meters">
          <Meter label="Skills" value={String(skills.filter((s) => s.enabled).length)} sub={`${skills.length} total`} />
          <Meter label="Per-turn roster" value={`~${rosterTokens}`} sub="tokens, always sent" />
          <Meter
            label="Always-on"
            value={`~${alwaysCost}`}
            sub={alwaysCost ? 'tokens, every turn' : 'nothing pinned on'}
            warn={alwaysCost > 4000}
          />
        </div>
      </header>

      <section className="panel skills-settings">
        <div className="skills-settings-row">
          <Switch
            checked={cfg?.enabled !== false}
            onChange={(v) => void saveSettings({ skills: { ...cfg!, enabled: v } })}
            label="Skills enabled"
          />
          <label className="skills-field">
            <span className="field-label">Selection</span>
            <select
              className="input"
              value={cfg?.selection ?? 'auto'}
              onChange={(e) => void saveSettings({ skills: { ...cfg!, selection: e.target.value as any } })}
            >
              <option value="auto">Automatic — the story decides</option>
              <option value="manual">Manual — only what I pin</option>
              <option value="off">Off — inject nothing</option>
            </select>
          </label>
          <label className="skills-field">
            <span className="field-label">Max at once</span>
            <input
              className="input" type="number" min={1} max={8}
              value={cfg?.maxActive ?? 3}
              onChange={(e) => void saveSettings({ skills: { ...cfg!, maxActive: Number(e.target.value) } })}
            />
          </label>
          <label className="skills-field">
            <span className="field-label">
              Context share — {Math.round((cfg?.shareOfContext ?? 0.25) * 100)}%
            </span>
            <input
              type="range" min={5} max={Math.round(MAX_SKILL_SHARE * 100)} step={1}
              value={Math.round((cfg?.shareOfContext ?? 0.25) * 100)}
              onChange={(e) => void saveSettings({ skills: { ...cfg!, shareOfContext: Number(e.target.value) / 100 } })}
            />
          </label>
        </div>
        <p className="t-caption t-faint" style={{ marginTop: 10 }}>
          Skills are the last claimant on context: the system prompt, memory and a floor of chat
          history are all served first. When a skill will not fit whole it is cut to its sections,
          then to a summary, then dropped — and every token it does not take goes back to the
          transcript, which is why switching skills off makes replies remember further back.
        </p>
        <div className="skills-settings-row" style={{ marginTop: 12 }}>
          <Switch
            checked={cfg?.inlineSelector !== false}
            onChange={(v) => void saveSettings({ skills: { ...cfg!, inlineSelector: v } })}
            label="Ride the reply (no extra API call)"
          />
          <Switch
            checked={cfg?.scoutFallback !== false}
            onChange={(v) => void saveSettings({ skills: { ...cfg!, scoutFallback: v } })}
            label="Fallback check when a model ignores it"
          />
        </div>
      </section>

      <div className="skills-toolbar">
        <input
          className="input skills-search" placeholder="Search skills…"
          value={query} onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-primary btn-sm" onClick={() => openEditor(null)}>New skill</button>
        <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>Import file</button>
        <button className="btn btn-secondary btn-sm" onClick={() => setAuthoring(true)}>Write one with AI</button>
        {status && <span className="t-caption" style={{ color: 'var(--accent)', alignSelf: 'center' }}>{status}</span>}
        <input
          ref={fileRef} type="file" accept=".md,.txt,.json" style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void onFile(file);
          }}
        />
      </div>

      <div className="skills-body">
        <div className="skills-list">
          {!filtered.length && (
            <div className="panel skills-empty">
              <p className="t-body">
                {skills.length ? 'Nothing matches that search.' : 'No skills yet.'}
              </p>
              <p className="t-caption t-faint">
                A skill is a broad document about doing one thing well — writing a fight, cooking,
                reading a room, seduction. Keep them setting-agnostic so any character in any world
                can adapt them.
              </p>
            </div>
          )}
          {filtered.map((skill) => (
            <article
              key={skill.id}
              className={`panel skill-card${selectedId === skill.id ? ' is-open' : ''}${skill.enabled ? '' : ' is-off'}`}
            >
              <div className="skill-card-head">
                <Switch
                  checked={skill.enabled}
                  onChange={(v) => void patchSkill(skill, { enabled: v })}
                  label=""
                />
                <button className="skill-card-title" onClick={() => openEditor(skill)}>
                  <span className="t-body-lg">{skill.name}</span>
                  <span className="t-caption t-faint">{skill.description || 'No summary — the router is flying blind.'}</span>
                </button>
                <span className={`skill-cost${skill.tokens > 3000 ? ' is-heavy' : ''}`}>~{skill.tokens} tok</span>
              </div>
              <div className="skill-card-foot">
                <ModePicker value={skill.mode} onChange={(mode) => void patchSkill(skill, { mode })} />
                {skill.tags.map((t) => <span key={t} className="chip skill-tag">{t}</span>)}
                <span className="skills-spacer" />
                <button className="btn btn-ghost btn-sm" onClick={() => openEditor(skill)}>Edit</button>
                <button className="btn btn-ghost btn-sm" onClick={() => void exportSkill(skill)}>Export</button>
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => void removeSkill(skill)}>Delete</button>
              </div>
            </article>
          ))}
        </div>

        {draft && (
          <aside className="panel skill-editor">
            <div className="skill-editor-head">
              <h2 className="t-body-lg">{selectedId ? 'Edit skill' : 'New skill'}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => { setDraft(null); setSelectedId(null); }}>Close</button>
            </div>

            <label className="field-label">Name</label>
            <input className="input" value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />

            <label className="field-label" style={{ marginTop: 10 }}>
              One-line summary <span className="t-faint">— the only thing the router reads</span>
            </label>
            <input
              className="input" value={draft.description ?? ''}
              placeholder="When two people are actually trying to hurt each other."
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />

            <div className="skill-editor-grid">
              <label>
                <span className="field-label">Mode</span>
                <select
                  className="input" value={draft.mode ?? 'auto'}
                  onChange={(e) => setDraft({ ...draft, mode: e.target.value as SkillMode })}
                >
                  <option value="auto">Auto — chosen per scene</option>
                  <option value="always">Always on — every turn</option>
                  <option value="manual">Manual — only where pinned</option>
                </select>
              </label>
              <label>
                <span className="field-label">Priority</span>
                <input
                  className="input" type="number" min={0} max={100}
                  value={draft.priority ?? 50}
                  onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                />
              </label>
              <label>
                <span className="field-label">Stays loaded (turns)</span>
                <input
                  className="input" type="number" min={0} max={20}
                  value={draft.stickyTurns ?? 2}
                  onChange={(e) => setDraft({ ...draft, stickyTurns: Number(e.target.value) })}
                />
              </label>
            </div>

            <label className="field-label" style={{ marginTop: 10 }}>Keywords</label>
            <input
              className="input" placeholder="fight, punch, blade, dodge"
              value={draft.keywordsText ?? ''}
              onChange={(e) => setDraft({ ...draft, keywordsText: e.target.value })}
            />
            <p className="t-caption t-faint" style={{ marginTop: 4 }}>
              Local hints only — they decide which skills are worth showing the router, never
              whether one gets used.
            </p>

            <label className="field-label" style={{ marginTop: 10 }}>Tags</label>
            <input
              className="input" placeholder="action, physical"
              value={draft.tagsText ?? ''}
              onChange={(e) => setDraft({ ...draft, tagsText: e.target.value })}
            />

            <label className="field-label" style={{ marginTop: 10 }}>
              Document <span className="t-faint">— ~{estimateClientTokens(draft.body ?? '')} tokens</span>
            </label>
            <textarea
              className="textarea skill-body"
              rows={18}
              placeholder={'## Core principles\n…\n\n## How it reads on the page\n…'}
              value={draft.body ?? ''}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <p className="t-caption t-faint" style={{ marginTop: 4 }}>
              Use <code>##</code> headings: when the budget is tight whole sections are dropped
              from the bottom rather than the text being cut mid-sentence.
            </p>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={() => void saveDraft()}>Save</button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setDraft(null); setSelectedId(null); }}>Cancel</button>
            </div>
          </aside>
        )}
      </div>

      {authoring && (
        <SkillAuthor
          onClose={() => setAuthoring(false)}
          onDraft={(d) => {
            setAuthoring(false);
            setSelectedId(null);
            setDraft({
              ...d, enabled: true, mode: 'auto', priority: 50, stickyTurns: 2,
              keywordsText: d.keywords.join(', '), tagsText: d.tags.join(', '),
            });
          }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------- AI author

function SkillAuthor({ onClose, onDraft }: { onClose: () => void; onDraft: (d: SkillDraft) => void }) {
  const [idea, setIdea] = useState('');
  const [depth, setDepth] = useState<'brief' | 'standard' | 'deep'>('standard');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancelRef = useRef<(() => void) | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => () => cancelRef.current?.(), []);
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [text]);

  function start() {
    if (!idea.trim()) return setError('Say what the skill is about first.');
    setError('');
    setText('');
    setBusy(true);
    cancelRef.current = streamSkillDraft({ idea: idea.trim(), depth }, {
      onDelta: (t) => setText((prev) => prev + t),
      onDone: (draft) => { setBusy(false); onDraft(draft); },
      onError: (message) => { setBusy(false); setError(message); },
    });
  }

  return (
    <div className="skill-modal-root" role="dialog" aria-modal="true">
      <div className="skill-modal-backdrop" onClick={() => !busy && onClose()} />
      <div className="panel skill-modal">
        <div className="skill-editor-head">
          <h2 className="t-body-lg">Write a skill</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => { cancelRef.current?.(); onClose(); }}>Close</button>
        </div>
        <p className="t-caption t-faint" style={{ marginBottom: 10 }}>
          Describe the craft, not the story. The document is written to stay setting-agnostic so
          the same one serves a duelling master and someone who has never thrown a punch — and it
          lands in the editor for you to read before it can affect anything.
        </p>

        <label className="field-label">Idea</label>
        <input
          className="input" autoFocus disabled={busy}
          placeholder="how to write believable close-quarters martial arts"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) start(); }}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <select className="input" style={{ maxWidth: 180 }} value={depth} disabled={busy}
            onChange={(e) => setDepth(e.target.value as any)}>
            <option value="brief">Brief</option>
            <option value="standard">Standard</option>
            <option value="deep">Deep</option>
          </select>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={start}>
            {busy ? <><GlobeLoader size={13} /> Writing…</> : 'Generate'}
          </button>
          {busy && (
            <button className="btn btn-ghost btn-sm" onClick={() => { cancelRef.current?.(); setBusy(false); }}>
              Stop
            </button>
          )}
        </div>

        {error && <p className="t-caption" style={{ color: 'var(--danger, #e5484d)', marginTop: 10 }}>{error}</p>}
        {text && <pre ref={preRef} className="skill-stream">{text}</pre>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Meter({ label, value, sub, warn }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className={`skills-meter${warn ? ' is-warn' : ''}`}>
      <span className="t-caption t-faint">{label}</span>
      <strong>{value}</strong>
      <span className="t-caption t-faint">{sub}</span>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="skill-switch" title={label || (checked ? 'Enabled' : 'Disabled')}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="skill-switch-track"><span className="skill-switch-thumb" /></span>
      {label && <span className="t-body">{label}</span>}
    </label>
  );
}

function ModePicker({ value, onChange }: { value: SkillMode; onChange: (m: SkillMode) => void }) {
  const modes: { id: SkillMode; label: string; title: string }[] = [
    { id: 'auto', label: 'Auto', title: 'The story decides when this loads.' },
    { id: 'always', label: 'Always', title: 'Loaded every turn — spends its full cost forever.' },
    { id: 'manual', label: 'Manual', title: 'Never auto-selected; only where you pin it in a chat.' },
  ];
  return (
    <div className="skill-modes">
      {modes.map((m) => (
        <button
          key={m.id} title={m.title}
          className={`chip skill-mode${value === m.id ? ' active' : ''}`}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function splitField(value?: string): string[] {
  return (value ?? '').split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
}

/** Mirrors the server estimator closely enough to price an editor field. */
function estimateClientTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Math.max(text.split(/\s+/).length * 1.35, text.length / 3.6));
}
