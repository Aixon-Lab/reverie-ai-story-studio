/** Home — the character shelf: portrait cards, drag & drop import, groups, recent chats. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Plus, Trash2 } from 'lucide-react';
import type { CharacterCard, ChatMeta, Group } from '@shared/types';
import { api, fileToBase64 } from '../api';
import { useApp } from '../store';
import { Avatar } from '../components/Avatar';
import { GroupMemberStrip } from '../components/GroupMemberStrip';
import { useConfirm } from '../components/ConfirmDialog';
import { PageLoader } from '../components/GlobeLoader';

export function Home() {
  const nav = useNavigate();
  const confirm = useConfirm();
  const refreshCharacters = useApp((s) => s.refreshCharacters);
  const [characters, setCharacters] = useState<CharacterCard[]>(() => useApp.getState().characters);
  const [groups, setGroups] = useState<Group[]>(() => useApp.getState().groups);
  const [chats, setChats] = useState<ChatMeta[]>(() => useApp.getState().chats);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(() => useApp.getState().loaded);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  /** Debounce card click so double-click can open portrait without starting a chat. */
  const cardClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      const [cs, gs, hs] = await Promise.all([api.listCharacters(), api.listGroups(), api.listChats()]);
      setCharacters(cs);
      setGroups(gs);
      setChats(hs);
      // Keep global store current so chat group "+" sees new cards immediately
      useApp.setState({ characters: cs, groups: gs, chats: hs });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const selectedCards = useMemo(
    () => selected.map((id) => characters.find((c) => c.id === id)).filter(Boolean) as CharacterCard[],
    [selected, characters],
  );

  async function importFiles(files: FileList | File[]) {
    setError('');
    for (const file of Array.from(files)) {
      try {
        if (/\.(png|json)$/i.test(file.name)) {
          await api.importCharacter(file.name, await fileToBase64(file));
        } else {
          setError(`${file.name}: only .png and .json character cards are accepted here.`);
        }
      } catch (err: any) {
        setError(`${file.name}: ${err.message}`);
      }
    }
    await reload();
    await refreshCharacters();
  }

  async function startSolo(c: CharacterCard) {
    const chat = await api.createChat({ characterId: c.id, title: c.name });
    nav(`/chat/${chat.id}`);
  }

  async function createGroup() {
    if (selected.length < 2) return;
    const names = characters.filter((c) => selected.includes(c.id)).map((c) => c.name);
    const group = await api.createGroup({ name: names.slice(0, 3).join(' · '), members: selected, turnMode: 'director' });
    const chat = await api.createChat({ groupId: group.id, title: group.name });
    setSelecting(false);
    setSelected([]);
    nav(`/chat/${chat.id}`);
  }

  async function openGroup(g: Group) {
    const existing = chats.find((c) => c.groupId === g.id);
    const chat = existing ?? (await api.createChat({ groupId: g.id, title: g.name }));
    nav(`/chat/${chat.id}`);
  }

  function toggleMember(c: CharacterCard) {
    setSelected((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]));
  }

  function addMember(c: CharacterCard) {
    setSelected((s) => (s.includes(c.id) ? s : [...s, c.id]));
  }

  function removeMember(c: CharacterCard) {
    setSelected((s) => s.filter((x) => x !== c.id));
  }

  const filtered = characters.filter(
    (c) =>
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.tags.some((t) => t.toLowerCase().includes(search.toLowerCase())),
  );

  if (!ready) return <PageLoader label="Opening your world…" />;

  return (
    <div
      style={{ height: '100%', overflowY: 'auto', padding: '35px 62px' }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => {
        // ignore leave events that bubble from children
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
      }}
    >
      {/* Fixed overlay — does not push layout when dragging */}
      {dragOver && (
        <div className="drop-overlay">
          <span className="t-heading" style={{ color: 'var(--accent)' }}>Drop to import cards</span>
        </div>
      )}

      <div style={{ maxWidth: 1128, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 26, gap: 18, flexWrap: 'wrap' }}>
          <div>
            <h1 className="t-display-xl">Your World</h1>
            <p className="t-caption" style={{ marginTop: 6 }}>
              {characters.length
                ? `${characters.length} characters · ${groups.length} groups`
                : 'Drop a character card anywhere to begin'}
            </p>
          </div>
          <div className="btn-row">
            <input
              className="input"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 160 }}
            />
            {selecting ? (
              <>
                <button className="btn btn-ghost" onClick={() => { setSelecting(false); setSelected([]); }}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={selected.length < 2} onClick={() => void createGroup()}>
                  Form Group ({selected.length})
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-secondary" onClick={() => setSelecting(true)} disabled={characters.length < 2}>
                  New Group
                </button>
                <button className="btn btn-secondary" onClick={() => nav('/creator')}>
                  Character Creator
                </button>
                <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
                  Import Cards
                  <input
                    type="file"
                    multiple
                    accept=".png,.json"
                    style={{ display: 'none' }}
                    onChange={(e) => e.target.files && importFiles(e.target.files)}
                  />
                </label>
              </>
            )}
          </div>
        </div>

        {error && <p style={{ color: 'var(--danger)', marginBottom: 18 }}>{error}</p>}

        {/* ST-style group builder: member portraits + trailing + */}
        {selecting && (
          <div className="group-builder-bar">
            <div style={{ minWidth: 0, flex: 1 }}>
              <p className="field-label" style={{ marginBottom: 8 }}>Group cast</p>
              <GroupMemberStrip
                members={selectedCards}
                pool={characters}
                onAdd={addMember}
                onRemove={removeMember}
                size={48}
                canRemove
                emptyHint="Add at least two characters — tap + or cards below"
                addLabel="Add character to group"
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <span className="t-caption">
                {selected.length < 2
                  ? `Need ${2 - selected.length} more`
                  : `${selected.length} members ready`}
              </span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={selected.length < 2}
                onClick={() => void createGroup()}
              >
                Form Group
              </button>
            </div>
          </div>
        )}

        {groups.length > 0 && !selecting && (
          <section style={{ marginBottom: 35 }}>
            <h2 className="t-section" style={{ marginBottom: 12 }}>Groups</h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {groups.map((g) => {
                const members = characters.filter((c) => g.members.includes(c.id));
                const groupChats = chats.filter((c) => c.groupId === g.id).length;
                return (
                  // Wrapper so the delete control is a sibling of the card button
                  // rather than nested inside it — a button inside a button is
                  // invalid and swallows the inner click.
                  <div key={g.id} className="group-card-wrap">
                  <button
                    className="panel panel-clickable"
                    onClick={() => openGroup(g)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '14px 20px',
                      color: 'var(--ink)',
                      width: '100%',
                    }}
                  >
                    <div style={{ display: 'flex' }}>
                      {members.slice(0, 4).map((m, i) => (
                        <div key={m.id} style={{ marginLeft: i ? -12 : 0 }}>
                          <Avatar src={m.avatar} name={m.name} size={32} />
                        </div>
                      ))}
                      {/* Visual affordance that groups grow via + in chat Cast */}
                      <div
                        style={{
                          marginLeft: members.length ? -8 : 0,
                          width: 32,
                          height: 32,
                          borderRadius: 10,
                          border: '1.5px dashed var(--hairline-strong)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--ink-muted)',
                          fontSize: 14,
                        }}
                        title="Open group to add members"
                      >
                        +
                      </div>
                    </div>
                    <span className="t-label">{g.name}</span>
                  </button>
                  <button
                    type="button"
                    className="group-card-delete"
                    title={`Delete group “${g.name}”`}
                    aria-label={`Delete group ${g.name}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      const ok = await confirm({
                        title: `Delete the group “${g.name || 'Untitled'}”?`,
                        body: groupChats
                          ? `This also deletes ${groupChats} group ${groupChats === 1 ? 'conversation' : 'conversations'} and everything the characters remembered in ${groupChats === 1 ? 'it' : 'them'}.\n\nThe characters themselves are not deleted.`
                          : 'No conversations are linked yet. The characters themselves are not deleted.',
                        confirmLabel: 'Delete group',
                        cancelLabel: 'Cancel',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await api.deleteGroup(g.id);
                        await reload();
                      } catch (err: any) {
                        setError(err.message ?? 'Could not delete that group.');
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section>
          {selecting && (
            <p className="t-caption" style={{ marginBottom: 12 }}>
              Click a card to add or remove — same as ST&apos;s + on the character list. Or use the + on the cast strip above.
            </p>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 18 }}>
            {filtered.map((c) => {
              const isSel = selected.includes(c.id);
              return (
                <div
                  key={c.id}
                  className={`char-card${selecting && isSel ? ' is-selected' : ''}`}
                  onClick={() => {
                    if (selecting) {
                      toggleMember(c);
                      return;
                    }
                    if (cardClickTimer.current) clearTimeout(cardClickTimer.current);
                    cardClickTimer.current = setTimeout(() => {
                      cardClickTimer.current = null;
                      void startSolo(c);
                    }, 280);
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    if (cardClickTimer.current) {
                      clearTimeout(cardClickTimer.current);
                      cardClickTimer.current = null;
                    }
                    if (selecting) return;
                    useApp.getState().openPortrait({
                      src: c.avatar || undefined,
                      name: c.name,
                    });
                  }}
                  style={{
                    borderColor: selecting && isSel ? 'var(--accent)' : undefined,
                    boxShadow: selecting && isSel ? '0 0 0 1px var(--accent)' : undefined,
                  }}
                  title={selecting ? undefined : 'Click to chat · double-click portrait to float'}
                >
                  {c.avatar ? (
                    <img className="char-card-img" src={c.avatar} alt={c.name} draggable={false} />
                  ) : (
                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span className="t-display-md t-faint">{c.name.slice(0, 1)}</span>
                    </div>
                  )}
                  {selecting && (
                    <span className="char-card-add-badge" aria-hidden>
                      {isSel ? <Check size={14} strokeWidth={2.5} /> : <Plus size={14} strokeWidth={2.5} />}
                    </span>
                  )}
                  <div className="char-card-scrim">
                    <div className="t-label" style={{ fontSize: 14 }}>{c.name}</div>
                    {c.tags.length > 0 && (
                      <div className="t-caption" style={{ marginTop: 2 }}>{c.tags.slice(0, 3).join(' · ')}</div>
                    )}
                  </div>
                  <div className="char-card-action" style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        nav(`/creator/${c.id}`);
                      }}
                    >
                      Edit
                    </button>
                    {!selecting && (
                      <button
                        className="btn btn-ghost btn-sm btn-danger"
                        title="Permanently delete character"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const ok = await confirm({
                            title: `Delete “${c.name || 'this character'}”?`,
                            body: 'Removes the card and its photos from disk. Chats that used them are not deleted.',
                            confirmLabel: 'Delete character',
                            cancelLabel: 'Cancel',
                            danger: true,
                          });
                          if (!ok) return;
                          try {
                            await api.deleteCharacter(c.id);
                            await reload();
                            await refreshCharacters();
                          } catch (err: any) {
                            setError(err.message ?? 'Delete failed');
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {!characters.length && (
            <div className="dropzone" style={{ padding: 62, textAlign: 'center', marginTop: 18 }}>
              <p className="t-heading" style={{ marginBottom: 8 }}>An Empty Stage</p>
              <p className="t-caption">
                Drag character cards (.png / .json) here, or create one from scratch.
              </p>
            </div>
          )}
        </section>

        {chats.length > 0 && (
          <section style={{ marginTop: 35 }}>
            <h2 className="t-section" style={{ marginBottom: 12 }}>Recent Chats</h2>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {chats.slice(0, 8).map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => nav(`/chat/${ch.id}`)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '12px 4px',
                    borderBottom: '1px solid var(--hairline)',
                    cursor: 'pointer',
                    color: 'var(--ink)',
                    background: 'transparent',
                    borderLeft: 'none',
                    borderRight: 'none',
                    borderTop: 'none',
                    textAlign: 'left',
                    width: '100%',
                    font: 'inherit',
                  }}
                >
                  <span>{ch.title}</span>
                  <span className="t-caption">{new Date(ch.updatedAt).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
