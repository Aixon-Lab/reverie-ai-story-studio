/** Persona switcher — create, import character cards, become any platform character. */
import { useMemo, useRef, useState } from 'react';
import type { CharacterCard, Persona } from '@shared/types';
import { useApp } from '../../store';
import { api, fileToBase64 } from '../../api';
import { Avatar } from '../Avatar';
import { DrawerHeader } from './DrawerHost';
import { Upload } from 'lucide-react';
import { GlobeLoader } from '../GlobeLoader';

export function PersonaDrawer({ onClose }: { onClose: () => void }) {
  const { settings, personas, characters, setPersonas, refreshCharacters } = useApp();
  const activatePersona = useApp((s) => s.activatePersona);
  const becomeCharacterAction = useApp((s) => s.becomeCharacter);
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('New Persona');
  const [draftDesc, setDraftDesc] = useState('');

  if (!settings) return null;

  const persona = personas.find((p) => p.id === settings.activePersonaId) ?? personas[0];

  const filteredChars = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return characters;
    return characters.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q)) ||
        c.description.toLowerCase().includes(q),
    );
  }, [characters, search]);

  /** Become a character: reuse matching persona or mint one from the card, then activate. */
  async function becomeCharacter(card: CharacterCard) {
    setError('');
    setBusy(true);
    try {
      await becomeCharacterAction(card);
    } catch (err: any) {
      setError(err.message ?? 'Could not become that character');
    } finally {
      setBusy(false);
    }
  }

  async function createPersona() {
    const name = draftName.trim() || 'New Persona';
    const next: Persona = {
      id: `p-${Date.now().toString(36)}`,
      name,
      description: draftDesc.trim(),
    };
    const list = [...personas, next];
    setPersonas(list);
    await api.savePersonas(list);
    await activatePersona(next.id);
    setCreating(false);
    setDraftName('New Persona');
    setDraftDesc('');
  }

  async function importCards(files: FileList | File[]) {
    setError('');
    setBusy(true);
    try {
      let last: CharacterCard | null = null;
      for (const file of Array.from(files)) {
        if (!/\.(png|json)$/i.test(file.name)) {
          setError(`${file.name}: only .png and .json character cards`);
          continue;
        }
        last = await api.importCharacter(file.name, await fileToBase64(file));
      }
      await refreshCharacters();
      if (last) await becomeCharacter(last);
    } catch (err: any) {
      setError(err.message ?? 'Import failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function patchActive(patch: Partial<Persona>) {
    if (!persona) return;
    const list = personas.map((p) => (p.id === persona.id ? { ...p, ...patch } : p));
    setPersonas(list);
  }

  async function commitPersonas() {
    await api.savePersonas(useApp.getState().personas);
  }

  return (
    <>
      <DrawerHeader title="Persona" onClose={onClose} />
      <div className="drawer-body">
        <p className="t-caption" style={{ marginBottom: 12 }}>
          Who <strong>you</strong> play as globally (not group Members). Create, import a card, or become any library character.
        </p>

        {error && (
          <p className="t-caption" style={{ color: 'var(--danger)', marginBottom: 10 }}>{error}</p>
        )}

        <p className="field-label">Active persona</p>
        <div className="persona-active-card">
          {persona ? (
            <>
              <Avatar src={persona.avatar} name={persona.name} size={44} shape="square" interactive={false} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="t-label" style={{ marginBottom: 2 }}>{persona.name}</div>
                <div className="t-caption" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {persona.description || 'No description'}
                </div>
              </div>
            </>
          ) : (
            <span className="t-caption">No persona yet</span>
          )}
        </div>

        {persona && (
          <div style={{ marginBottom: 16 }}>
            <label className="field-label">Name</label>
            <input
              className="input"
              value={persona.name}
              onChange={(e) => void patchActive({ name: e.target.value })}
              onBlur={() => void commitPersonas()}
            />
            <label className="field-label" style={{ marginTop: 12 }}>Description</label>
            <textarea
              className="textarea"
              rows={4}
              value={persona.description}
              onChange={(e) => void patchActive({ description: e.target.value })}
              onBlur={() => void commitPersonas()}
            />
          </div>
        )}

        <div className="btn-row" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => setCreating((c) => !c)}
          >
            + New persona
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            title="Import a character card (.png / .json) — adds to the platform and becomes them"
          >
            {busy ? <GlobeLoader size={14} /> : <Upload size={14} />}
            {busy ? 'Importing…' : 'Import card'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".png,.json,image/png,application/json"
            multiple
            hidden
            onChange={(e) => e.target.files && void importCards(e.target.files)}
          />
        </div>

        {creating && (
          <div className="persona-create-box" style={{ marginBottom: 16 }}>
            <label className="field-label">Name</label>
            <input className="input" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
            <label className="field-label" style={{ marginTop: 8 }}>Description</label>
            <textarea className="textarea" rows={3} value={draftDesc} onChange={(e) => setDraftDesc(e.target.value)} />
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void createPersona()}>
                Create & use
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {personas.length > 0 && (
          <>
            <p className="field-label">Your personas</p>
            <div className="persona-pick-grid" style={{ marginBottom: 18 }}>
              {personas.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`persona-pick${p.id === settings.activePersonaId ? ' is-active' : ''}`}
                  disabled={busy}
                  onClick={() => void activatePersona(p.id)}
                  title={p.name}
                >
                  <Avatar src={p.avatar} name={p.name} size={36} shape="square" interactive={false} />
                  <span className="persona-pick-name">{p.name}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <p className="field-label">Become a character</p>
        <p className="t-caption" style={{ marginBottom: 8 }}>
          Same pool as Home — pick anyone, or import a new card above.
        </p>
        <input
          className="input"
          placeholder="Search characters…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginBottom: 10 }}
        />
        <div className="persona-char-list">
          {filteredChars.length === 0 && (
            <p className="t-caption">No characters yet. Import a card or create one on Home.</p>
          )}
          {filteredChars.map((c) => {
            const isYou =
              settings.activePersonaId === `from-${c.id}` ||
              (persona?.name === c.name && persona?.avatar === c.avatar);
            return (
              <button
                key={c.id}
                type="button"
                className={`persona-char-row${isYou ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => void becomeCharacter(c)}
                title={`Become ${c.name}`}
              >
                <Avatar src={c.avatar} name={c.name} size={36} shape="square" interactive={false} />
                <span className="persona-char-meta">
                  <span className="persona-char-name">{c.name}</span>
                  {c.tags?.length > 0 && (
                    <span className="t-caption">{c.tags.slice(0, 3).join(' · ')}</span>
                  )}
                </span>
                {isYou && <span className="persona-you-badge">You</span>}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
