/** Characters drawer — search shelf, start chat, open studio without losing chat. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useApp } from '../../store';
import { Avatar } from '../Avatar';
import { DrawerHeader } from './DrawerHost';
import { useConfirm } from '../ConfirmDialog';
import { characterBlurb, groupBlurb } from '../../lib/characterBlurb';

export function CharactersDrawer({ onClose }: { onClose: () => void }) {
  const confirm = useConfirm();
  const { characters, groups, refreshChats, refreshCharacters, refreshGroups, setDrawer } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return characters;
    return characters.filter((c) => {
      const blob = `${c.name} ${c.tags.join(' ')} ${c.personality} ${c.description}`.toLowerCase();
      return blob.includes(needle);
    });
  }, [characters, q]);

  async function startSolo(characterId: string, title: string) {
    const chat = await api.createChat({ characterId, title });
    await refreshChats();
    setDrawer(null);
    nav(`/chat/${chat.id}`);
  }

  async function startGroup(groupId: string, title: string) {
    const chat = await api.createChat({ groupId, title });
    await refreshChats();
    setDrawer(null);
    nav(`/chat/${chat.id}`);
  }

  async function deletePermanently(id: string, name: string) {
    const ok = await confirm({
      title: `Delete \u201c${name}\u201d?`,
      body: 'Removes the card and its photos from disk. This cannot be undone.',
      confirmLabel: 'Delete character',
      danger: true,
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await api.deleteCharacter(id);
      await refreshCharacters();
      await refreshGroups();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <DrawerHeader title="Library" onClose={onClose} />
      <div className="drawer-body">
        <p className="t-caption" style={{ marginBottom: 10 }}>
          Start a chat from your shelf. To build or edit cards, open Creator. Double-click any avatar to float the portrait.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          style={{ width: '100%', marginBottom: 12 }}
          onClick={() => { setDrawer(null); nav('/creator'); }}
        >
          Open Character Creator
        </button>
        <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />

        {groups.length > 0 && (
          <>
            <p className="t-section" style={{ margin: '16px 0 8px' }}>Groups</p>
            <div className="drawer-card-list">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="drawer-card"
                  onClick={() => void startGroup(g.id, g.name)}
                >
                  <Avatar name={g.name} size={40} />
                  <span className="drawer-card-meta">
                    <span className="drawer-card-name">{g.name}</span>
                    <span className="drawer-card-blurb">{groupBlurb(g, characters)}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        <p className="t-section" style={{ margin: '16px 0 8px' }}>Characters (solo)</p>
        <div className="drawer-card-list">
          {filtered.map((c) => (
            <div key={c.id} className="drawer-card is-row">
              <button
                type="button"
                className="drawer-card-main"
                onClick={() => void startSolo(c.id, c.name)}
              >
                <Avatar src={c.avatar} name={c.name} size={40} characterId={c.id} />
                <span className="drawer-card-meta">
                  <span className="drawer-card-name">{c.name}</span>
                  <span className="drawer-card-blurb">{characterBlurb(c)}</span>
                </span>
              </button>
              <div className="drawer-card-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setDrawer(null); nav(`/creator/${c.id}`); }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-danger"
                  disabled={busyId === c.id}
                  title="Permanently delete character"
                  onClick={() => void deletePermanently(c.id, c.name)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        {!filtered.length && <p className="t-caption">No characters match.</p>}
      </div>
    </>
  );
}
