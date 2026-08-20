/** Global shell: left rail (chats + tools) + lean top bar (brand + model). No duplicated controls. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { DrawerId } from '@shared/types';
import { useApp } from '../store';
import { api } from '../api';
import { Avatar } from './Avatar';
import { DrawerHost } from './drawers/DrawerHost';
import { PortraitFloat } from './PortraitFloat';
import { SoftReveal } from './SoftReveal';
import {
  IconApi, IconCast, IconFormat, IconHome, IconPreset, IconSettings, IconWorld,
} from './Icons';
import {
  BookMarked, Brain, ChevronUp, Layers, Paintbrush, PenLine, Plus, ShieldCheck, Sparkles,
  SquareTerminal as TerminalIcon, Zap,
} from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { PageLoader } from './GlobeLoader';
import { useConfirm } from './ConfirmDialog';
import { characterBlurb, groupBlurb } from '../lib/characterBlurb';

export function Shell({ children }: { children: ReactNode }) {
  const { loaded, loadAll, settings } = useApp();
  useEffect(() => { if (!loaded) loadAll().catch(console.error); }, [loaded, loadAll]);

  // Push appearance tokens so chat CSS can fine-tune the messages area
  useEffect(() => {
    const root = document.documentElement;
    const raw = settings?.appearance?.chatBackground?.trim() ?? '';
    const bg = raw || '';
    if (bg) {
      root.style.setProperty('--chat-bg', bg);
      root.dataset.chatBgCustom = '1';
    } else {
      root.style.removeProperty('--chat-bg');
      delete root.dataset.chatBgCustom;
    }
  }, [settings?.appearance?.chatBackground]);

  return (
    <DrawerHost>
      <div className="shell">
        <LeftRail />
        <div className="shell-main">
          <TopBar />
          <main className="shell-content">
            {loaded ? children : <PageLoader label="Loading your world…" />}
          </main>
        </div>
      </div>
      <PortraitFloat />
    </DrawerHost>
  );
}

/** Always-visible tool drawers (not nested). */
const DRAWER_PRIMARY: {
  id: NonNullable<DrawerId>;
  label: string;
  Icon: typeof IconApi;
}[] = [
  { id: 'api', label: 'API', Icon: IconApi },
  { id: 'preset', label: 'Presets', Icon: IconPreset },
  { id: 'formatting', label: 'Format', Icon: IconFormat },
  { id: 'characters', label: 'Library', Icon: IconCast },
];

/** Nested under More: Creator (route) + Lore / Regex / Replies / Appearance drawers */
const DRAWER_MORE: {
  id: NonNullable<DrawerId>;
  label: string;
  Icon: typeof IconApi;
}[] = [
  { id: 'worldinfo', label: 'Lore', Icon: IconWorld },
  { id: 'regex', label: 'Regex', Icon: IconSettings },
  { id: 'quickreply', label: 'Replies', Icon: ({ size }: { size?: number }) => <Zap size={size ?? 20} strokeWidth={1.75} /> },
  {
    id: 'appearance',
    label: 'Appearance',
    Icon: ({ size }: { size?: number }) => <Paintbrush size={size ?? 20} strokeWidth={1.75} />,
  },
  {
    id: 'brain',
    label: 'Memory',
    Icon: ({ size }: { size?: number }) => <BookMarked size={size ?? 20} strokeWidth={1.75} />,
  },
  {
    id: 'skills',
    label: 'Skills',
    Icon: ({ size }: { size?: number }) => <Sparkles size={size ?? 20} strokeWidth={1.75} />,
  },
  {
    id: 'security',
    label: 'Security',
    Icon: ({ size }: { size?: number }) => <ShieldCheck size={size ?? 20} strokeWidth={1.75} />,
  },
  {
    id: 'terminal',
    label: 'Terminal',
    Icon: ({ size }: { size?: number }) => <TerminalIcon size={size ?? 20} strokeWidth={1.75} />,
  },
];

const MORE_DRAWER_IDS = new Set(DRAWER_MORE.map((d) => d.id));

function LeftRail() {
  const nav = useNavigate();
  const location = useLocation();
  const confirm = useConfirm();
  const chatId = location.pathname.startsWith('/chat/') ? decodeURIComponent(location.pathname.slice(6)) : undefined;
  const onCreator = location.pathname.startsWith('/creator')
    || location.pathname.startsWith('/character')
    || location.pathname.startsWith('/mind');
  const { chats, characters, groups, refreshChats, refreshGroups, toggleDrawer, openDrawer } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState('');
  const [picking, setPicking] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [newPopupOpen, setNewPopupOpen] = useState(false);
  const [newPopupQ, setNewPopupQ] = useState('');
  const moreRef = useRef<HTMLDivElement>(null);
  const newPopupRef = useRef<HTMLDivElement>(null);

  const moreHasActive =
    onCreator || (!!openDrawer && MORE_DRAWER_IDS.has(openDrawer as NonNullable<DrawerId>));

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!newPopupOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (newPopupRef.current && !newPopupRef.current.contains(e.target as Node)) setNewPopupOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNewPopupOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [newPopupOpen]);

  const filtered = useMemo(
    () => chats.filter((c) => !search || c.title.toLowerCase().includes(search.toLowerCase())),
    [chats, search],
  );

  function chatAvatar(chat: (typeof chats)[number]) {
    if (chat.characterId) return characters.find((c) => c.id === chat.characterId)?.avatar;
    const g = groups.find((x) => x.id === chat.groupId);
    if (g) return characters.find((c) => c.id === g.members[0])?.avatar;
    return undefined;
  }

  async function newChatWith(characterId?: string, groupId?: string, title?: string) {
    const chat = await api.createChat({ characterId, groupId, title: title ?? 'New chat' });
    await refreshChats();
    setPicking(false);
    setNewPopupOpen(false);
    setNewPopupQ('');
    nav(`/chat/${chat.id}`);
  }

  const popupPool = useMemo(() => {
    const q = newPopupQ.trim().toLowerCase();
    const gs = groups.filter((g) => !q || g.name.toLowerCase().includes(q));
    const cs = characters.filter((c) => {
      if (!q) return true;
      const blob = `${c.name} ${c.tags.join(' ')} ${c.personality} ${c.description}`.toLowerCase();
      return blob.includes(q);
    });
    return { gs, cs };
  }, [groups, characters, newPopupQ]);

  if (collapsed) {
    return (
      <aside className="left-rail left-rail-collapsed">
        <div className="rail-collapsed-top" ref={newPopupRef}>
          <button className="icon-btn" title="Expand sidebar" onClick={() => setCollapsed(false)} aria-label="Expand sidebar">
            »
          </button>
          <button
            type="button"
            className={`rail-new-chat-fab${newPopupOpen ? ' is-open' : ''}`}
            title="New chat"
            aria-label="New chat"
            aria-expanded={newPopupOpen}
            onClick={() => setNewPopupOpen((o) => !o)}
          >
            <Plus size={18} strokeWidth={2.25} />
          </button>
          {newPopupOpen && (
            <div className="rail-new-popup" role="dialog" aria-label="Start a new chat">
              <div className="rail-new-popup-head">
                <p className="field-label" style={{ marginBottom: 6 }}>Start with…</p>
                <input
                  className="input"
                  placeholder="Search…"
                  value={newPopupQ}
                  onChange={(e) => setNewPopupQ(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="rail-new-popup-list">
                {popupPool.gs.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className="rail-pick-card"
                    onClick={() => void newChatWith(undefined, g.id, g.name)}
                  >
                    <Avatar
                      src={characters.find((c) => c.id === g.members[0])?.avatar}
                      name={g.name}
                      characterId={g.members[0]}
                      size={40}
                      interactive={false}
                    />
                    <span className="rail-pick-meta">
                      <span className="rail-pick-name">{g.name}</span>
                      <span className="rail-pick-blurb">{groupBlurb(g, characters)}</span>
                    </span>
                  </button>
                ))}
                {popupPool.cs.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="rail-pick-card"
                    onClick={() => void newChatWith(c.id, undefined, c.name)}
                  >
                    <Avatar src={c.avatar} name={c.name} characterId={c.id} size={40} interactive={false} />
                    <span className="rail-pick-meta">
                      <span className="rail-pick-name">{c.name}</span>
                      <span className="rail-pick-blurb">{characterBlurb(c, 96)}</span>
                    </span>
                  </button>
                ))}
                {!popupPool.gs.length && !popupPool.cs.length && (
                  <p className="t-caption" style={{ padding: 12 }}>No matches.</p>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="left-rail-scroll" style={{ alignItems: 'center' }}>
          {filtered.slice(0, 12).map((c) => (
            <button
              key={c.id}
              onClick={() => nav(`/chat/${c.id}`)}
              title={c.title}
              style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: chatId === c.id ? 1 : 0.55, padding: 0 }}
            >
              <Avatar src={chatAvatar(c)} name={c.title} size={36} interactive={false} />
            </button>
          ))}
        </div>
        <nav className="left-rail-nav left-rail-nav-icons">
          <NavLink to="/" title="Home" className={({ isActive }) => `rail-icon-btn${isActive ? ' is-active' : ''}`}>
            <IconHome size={22} />
          </NavLink>
          {DRAWER_PRIMARY.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`rail-icon-btn${openDrawer === d.id ? ' is-active' : ''}`}
              title={d.label}
              onClick={() => toggleDrawer(d.id)}
            >
              <d.Icon size={22} />
            </button>
          ))}
          <div className="rail-more rail-more-collapsed" ref={moreRef}>
            <button
              type="button"
              className={`rail-icon-btn rail-more-icon-btn${moreOpen ? ' is-open' : ''}${moreHasActive ? ' is-active' : ''}`}
              title="More tools"
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              onClick={() => setMoreOpen((o) => !o)}
            >
              <Layers size={20} strokeWidth={1.6} />
            </button>
            {moreOpen && (
              <div className="rail-more-popup rail-more-popup-right" role="menu">
                <NavLink
                  to="/creator"
                  role="menuitem"
                  className={({ isActive }) => `rail-more-pop-item${isActive ? ' is-active' : ''}`}
                  onClick={() => setMoreOpen(false)}
                >
                  <PenLine size={16} strokeWidth={1.75} />
                  <span>Creator</span>
                </NavLink>
                <NavLink
                  to="/mind"
                  role="menuitem"
                  className={({ isActive }) => `rail-more-pop-item${isActive ? ' is-active' : ''}`}
                  onClick={() => setMoreOpen(false)}
                >
                  <Brain size={16} strokeWidth={1.75} />
                  <span>Minds</span>
                </NavLink>
                {DRAWER_MORE.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="menuitem"
                    className={`rail-more-pop-item${openDrawer === d.id ? ' is-active' : ''}`}
                    onClick={() => {
                      toggleDrawer(d.id);
                      setMoreOpen(false);
                    }}
                  >
                    <d.Icon size={16} />
                    <span>{d.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>
      </aside>
    );
  }

  return (
    <aside className="left-rail">
      <div style={{ display: 'flex', gap: 8, padding: '12px 12px 8px', alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => setPicking((p) => !p)}>
          + New Chat
        </button>
        <button className="icon-btn" title="Collapse" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar">
          «
        </button>
      </div>

      <SoftReveal show={picking}>
        <div className="rail-pick-panel">
          <p className="field-label" style={{ margin: '0 0 8px' }}>Start with…</p>
          <div className="rail-pick-list">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                className="rail-pick-card"
                onClick={() => void newChatWith(undefined, g.id, g.name)}
              >
                <Avatar
                  src={characters.find((c) => c.id === g.members[0])?.avatar}
                  name={g.name}
                  characterId={g.members[0]}
                  size={40}
                  interactive={false}
                />
                <span className="rail-pick-meta">
                  <span className="rail-pick-name">{g.name}</span>
                  <span className="rail-pick-blurb">{groupBlurb(g, characters)}</span>
                </span>
              </button>
            ))}
            {characters.map((c) => (
              <button
                key={c.id}
                type="button"
                className="rail-pick-card"
                onClick={() => void newChatWith(c.id, undefined, c.name)}
              >
                <Avatar src={c.avatar} name={c.name} characterId={c.id} size={40} interactive={false} />
                <span className="rail-pick-meta">
                  <span className="rail-pick-name">{c.name}</span>
                  <span className="rail-pick-blurb">{characterBlurb(c)}</span>
                </span>
              </button>
            ))}
            {!groups.length && !characters.length && (
              <p className="t-caption" style={{ padding: '8px 4px' }}>
                No characters yet — import a card or open Creator.
              </p>
            )}
          </div>
        </div>
      </SoftReveal>

      <div style={{ padding: '0 12px 8px' }}>
        <input className="input" placeholder="Search chats…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="left-rail-scroll" style={{ padding: '0 8px' }}>
        {filtered.map((c) => (
          <RailRow
            key={c.id}
            active={chatId === c.id}
            label={c.title}
            sub={new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            avatar={chatAvatar(c)}
            onClick={() => nav(`/chat/${c.id}`)}
            onDelete={async () => {
              const wasGroup = !!c.groupId;
              const name = (c.title || 'this chat').trim();
              const ok = await confirm({
                title: wasGroup ? `Delete group chat “${name}”?` : `Delete chat “${name}”?`,
                body: wasGroup
                  ? 'This permanently removes the whole group and every chat linked to it, plus those conversations’ memories.\n\nThe characters themselves are not deleted.'
                  : 'This permanently deletes the conversation and its messages.\n\nThe character is not deleted.',
                confirmLabel: wasGroup ? 'Delete group chat' : 'Delete chat',
                cancelLabel: 'Cancel',
                danger: true,
              });
              if (!ok) return;
              await api.deleteChat(c.id);
              await refreshChats();
              if (wasGroup) await refreshGroups();
              if (chatId === c.id) nav('/');
            }}
          />
        ))}
        {!filtered.length && <p className="t-caption" style={{ padding: 12 }}>No chats yet — start one above.</p>}
      </div>

      <nav className="left-rail-nav">
        <NavLink
          to="/"
          className={({ isActive }) => `rail-nav-link${isActive ? ' is-active' : ''}`}
        >
          <IconHome size={20} />
          <span>Home</span>
        </NavLink>
        {DRAWER_PRIMARY.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`rail-nav-link${openDrawer === d.id ? ' is-active' : ''}`}
            onClick={() => toggleDrawer(d.id)}
          >
            <d.Icon size={20} />
            <span>{d.label}</span>
          </button>
        ))}

        <div
          className={`rail-more${moreOpen ? ' is-open' : ''}${moreHasActive ? ' has-active' : ''}`}
          ref={moreRef}
        >
          <button
            type="button"
            className="rail-more-trigger"
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            onClick={() => setMoreOpen((o) => !o)}
          >
            <Layers size={18} strokeWidth={1.6} className="rail-more-trigger-icon" />
            <span className="rail-more-trigger-label">More</span>
            <ChevronUp size={14} className={`rail-more-chevron${moreOpen ? ' is-open' : ''}`} />
          </button>
          {moreOpen && (
            <div className="rail-more-popup" role="menu" aria-label="More tools">
              <NavLink
                to="/creator"
                role="menuitem"
                className={({ isActive }) => `rail-more-pop-item${isActive ? ' is-active' : ''}`}
                onClick={() => setMoreOpen(false)}
              >
                <PenLine size={16} strokeWidth={1.75} />
                <span>Creator</span>
              </NavLink>
              <NavLink
                to="/mind"
                role="menuitem"
                className={({ isActive }) => `rail-more-pop-item${isActive ? ' is-active' : ''}`}
                onClick={() => setMoreOpen(false)}
              >
                <Brain size={16} strokeWidth={1.75} />
                <span>Minds</span>
              </NavLink>
              {DRAWER_MORE.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="menuitem"
                  className={`rail-more-pop-item${openDrawer === d.id ? ' is-active' : ''}`}
                  onClick={() => {
                    toggleDrawer(d.id);
                    setMoreOpen(false);
                  }}
                >
                  <d.Icon size={16} />
                  <span>{d.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </nav>
    </aside>
  );
}

function RailRow({ label, sub, avatar, onClick, onDelete, active }: {
  label: string; sub?: string; avatar?: string; onClick: () => void; onDelete?: () => void; active?: boolean;
}) {
  return (
    <div className="rail-row" data-active={active || undefined} onClick={onClick}>
      <Avatar src={avatar} name={label} size={36} interactive={false} />
      <div className="rail-row-meta">
        <div className="rail-row-label">{label}</div>
        {sub && <div className="rail-row-sub">{sub}</div>}
      </div>
      {onDelete && (
        <button
          type="button"
          className="rail-delete"
          title="Delete chat"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** Top bar: brand · you-as-character chip · model chip. Persona drawer opens from the chip. */
function TopBar() {
  const { settings, secretKeys, personas, characters, toggleDrawer, openDrawer } = useApp();
  if (!settings) return <header className="top-bar" />;

  const hasKey =
    secretKeys.includes(`text.${settings.textConnection.provider}.apiKey`) ||
    settings.textConnection.provider === 'custom';

  const activePersona =
    personas.find((p) => p.id === settings.activePersonaId) ?? personas[0];
  // Prefer portrait from matching library character when user “became” them
  const linkedChar = activePersona
    ? characters.find(
        (c) =>
          activePersona.id === `from-${c.id}`
          || (c.name === activePersona.name && (!!activePersona.avatar ? c.avatar === activePersona.avatar : true)),
      )
    : undefined;
  const youName = activePersona?.name ?? 'You';
  const youAvatar = activePersona?.avatar ?? linkedChar?.avatar;
  const youCharId = linkedChar?.id ?? (activePersona?.id.startsWith('from-') ? activePersona.id.slice(5) : undefined);
  const personaOpen = openDrawer === 'persona';

  return (
    <header className="top-bar">
      <BrandLogo size="md" />
      <span style={{ flex: 1 }} />

      <button
        type="button"
        className={`you-chip${personaOpen ? ' is-open' : ''}`}
        onClick={() => toggleDrawer('persona')}
        title={`Playing as ${youName} — click to switch who you are`}
        aria-label={`Playing as ${youName}`}
        aria-pressed={personaOpen}
      >
        <span className="you-chip-ring">
          <Avatar
            src={youAvatar}
            name={youName}
            characterId={youCharId}
            size={28}
            shape="square"
            interactive={false}
          />
        </span>
        <span className="you-chip-meta">
          <span className="you-chip-kicker">Playing as</span>
          <span className="you-chip-name">{youName}</span>
        </span>
      </button>

      <button
        type="button"
        className="btn btn-secondary btn-sm model-chip"
        onClick={() => toggleDrawer('api')}
        title={hasKey ? 'Open API connection' : 'No API key set — open API'}
      >
        <span className="status-dot" data-ok={hasKey || undefined} />
        {settings.textConnection.model.split('/').pop()}
      </button>
    </header>
  );
}
