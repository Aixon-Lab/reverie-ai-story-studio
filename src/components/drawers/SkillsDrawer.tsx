/**
 * Skills, from inside a conversation.
 *
 * The library page is where skills are written; this is where you see what this
 * particular story is doing with them and overrule it. Kept separate because the
 * two questions are different: "what do I have" is a library problem, "why is
 * she fighting like a monk in a coffee shop" is a chat problem.
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ChatSkillState, Skill } from '@shared/skills/types';
import { api } from '../../api';
import { useApp } from '../../store';
import { DrawerHeader } from './DrawerHost';

export function SkillsDrawer({ onClose }: { onClose: () => void }) {
  /**
   * The route params are not available here.
   *
   * `DrawerHost` wraps the whole shell, so the drawer panel renders *outside*
   * the `<Routes>` tree — `useParams()` returns an empty object and every pin
   * silently did nothing. The pathname is readable anywhere under the router,
   * which is how the left rail already finds the open chat.
   */
  const location = useLocation();
  const chatId = location.pathname.startsWith('/chat/')
    ? decodeURIComponent(location.pathname.slice(6))
    : undefined;
  const nav = useNavigate();
  const { settings } = useApp();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [state, setState] = useState<ChatSkillState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = await api.listSkills();
    setSkills(list);
    if (chatId) setState(await api.chatSkills(chatId));
  }, [chatId]);

  useEffect(() => { void load().catch(console.error); }, [load]);

  const cfg = settings?.skills;
  const off = cfg?.enabled === false || cfg?.selection === 'off';

  async function pin(skillId: string, next: 'force' | 'mute' | 'clear') {
    if (!chatId) return;
    setBusy(true);
    try {
      setState(await api.pinChatSkill(chatId, skillId, next));
    } finally {
      setBusy(false);
    }
  }

  const armed = new Set((state?.active ?? []).map((a) => a.id));
  const forced = new Set(state?.forced ?? []);
  const muted = new Set(state?.muted ?? []);

  /** Loaded now = armed or forced or always-on, minus anything muted here. */
  const isLive = (s: Skill) =>
    !muted.has(s.id) && s.enabled && (forced.has(s.id) || s.mode === 'always' || (armed.has(s.id) && s.mode !== 'manual'));

  const live = skills.filter(isLive);
  const rest = skills.filter((s) => !isLive(s));

  return (
    <>
      <DrawerHeader title="Skills" onClose={onClose} />
      <div className="drawer-body">
        {off ? (
          <p className="t-caption" style={{ marginBottom: 12 }}>
            Skills are switched off globally, so nothing is being injected. Turn them back on from
            the Skills page.
          </p>
        ) : (
          <p className="t-caption" style={{ marginBottom: 12 }}>
            The story picks these as it goes, and a choice takes effect from the next reply. Pin one
            on to force it, or mute it to keep it out of this conversation only.
          </p>
        )}

        {!chatId && (
          <p className="t-caption t-faint">Open a chat to see and override what it is using.</p>
        )}

        {!!live.length && (
          <>
            <p className="field-label">Loaded in this scene</p>
            {live.map((s) => (
              <SkillRow
                key={s.id} skill={s} busy={busy}
                badge={forced.has(s.id) ? 'pinned' : s.mode === 'always' ? 'always' : 'chosen'}
                onForce={() => void pin(s.id, forced.has(s.id) ? 'clear' : 'force')}
                onMute={() => void pin(s.id, 'mute')}
                forced={forced.has(s.id)} muted={false}
              />
            ))}
          </>
        )}

        {!!rest.length && (
          <>
            <p className="field-label" style={{ marginTop: 14 }}>Available</p>
            {rest.map((s) => (
              <SkillRow
                key={s.id} skill={s} busy={busy}
                badge={muted.has(s.id) ? 'muted here' : s.enabled ? 'idle' : 'off'}
                onForce={() => void pin(s.id, 'force')}
                onMute={() => void pin(s.id, muted.has(s.id) ? 'clear' : 'mute')}
                forced={false} muted={muted.has(s.id)}
              />
            ))}
          </>
        )}

        {!skills.length && (
          <p className="t-caption t-faint">
            No skills yet. The Skills page can write one for you from a one-line idea.
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => { onClose(); nav('/skills'); }}>
            Open the Skills library
          </button>
          {chatId && !!armed.size && (
            <button
              className="btn btn-ghost btn-sm" disabled={busy}
              onClick={async () => { setState(await api.clearChatSkills(chatId)); }}
              title="Forget what the story armed. Pins and mutes stay."
            >
              Reset selection
            </button>
          )}
        </div>

        {!!state?.log?.length && (
          <>
            <p className="field-label" style={{ marginTop: 18 }}>Recent decisions</p>
            {state.log.slice(0, 6).map((entry, i) => (
              <p key={i} className="t-caption t-faint" style={{ marginTop: 4 }}>
                after message {entry.at} · {entry.reason} · {entry.via}
              </p>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function SkillRow({ skill, badge, forced, muted, busy, onForce, onMute }: {
  skill: Skill;
  badge: string;
  forced: boolean;
  muted: boolean;
  busy: boolean;
  onForce: () => void;
  onMute: () => void;
}) {
  return (
    <div className="panel skill-row">
      <div className="skill-row-main">
        <span className="t-body">{skill.name}</span>
        <span className="t-caption t-faint">{skill.description}</span>
      </div>
      <span className="chip skill-row-badge">{badge}</span>
      <button
        className={`btn btn-ghost btn-sm${forced ? ' is-active' : ''}`} disabled={busy}
        onClick={onForce}
        title={forced ? 'Stop forcing this skill on' : 'Force this skill on for this chat'}
      >
        {forced ? 'Unpin' : 'Pin'}
      </button>
      <button
        className={`btn btn-ghost btn-sm${muted ? ' is-active' : ''}`} disabled={busy}
        onClick={onMute}
        title={muted ? 'Allow this skill here again' : 'Keep this skill out of this chat'}
      >
        {muted ? 'Unmute' : 'Mute'}
      </button>
    </div>
  );
}
