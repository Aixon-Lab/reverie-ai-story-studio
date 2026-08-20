/**
 * The memory of a whole conversation.
 *
 * A group has one scene but several minds, each remembering it from inside their
 * own head. The chat's Brain button used to open exactly one of them — whichever
 * character happened to be next to speak — so the rest of the cast's memory was
 * unreachable without guessing. This is the roster: what everyone is carrying,
 * how close each is to their next consolidation, and one set of dials for all of
 * them. Any face opens that mind in full.
 *
 * Route: `/mind/:chatId`. One character's mind stays at `/mind/:chatId/:characterId`.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity, Brain, Gauge, MessageSquare, RefreshCw, TriangleAlert, VolumeX,
} from 'lucide-react';
import {
  api, type BrainConfigFields, type BrainJob, type ChatMindMember, type ChatMindOverview,
} from '../api';
import { Avatar } from '../components/Avatar';
import { BrainJobProgress } from '../components/BrainJobProgress';
import { GlobeLoader } from '../components/GlobeLoader';

const MAX_SHARE = 1 / 3;

const CADENCE = [1, 2, 4, 6, 10, 20];

export function ChatMindPage() {
  const { chatId } = useParams<{ chatId: string }>();
  const nav = useNavigate();

  const [data, setData] = useState<ChatMindOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  /** The run in flight (or the one that just finished, until dismissed). */
  const [job, setJob] = useState<BrainJob | null>(null);

  const load = useCallback(async () => {
    if (!chatId) return;
    try {
      setData(await api.brain.chat(chatId));
      setError('');
    } catch (err: any) {
      setError(err?.message ?? 'Could not read this conversation’s memory.');
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Passes run in the background on a timer, so a screen that never refreshes
   * shows a stale "3 messages until the next pass" forever.
   */
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 20_000);
    return () => clearInterval(t);
  }, [load]);

  // A run started elsewhere (or before a reload) still belongs on this screen.
  useEffect(() => {
    if (!chatId) return;
    api.brain.activeJob(chatId).then((j) => { if (j) setJob(j); }).catch(() => undefined);
  }, [chatId]);

  /**
   * Follow a live run closely — a bar that updates every 20s is not a bar. The
   * poll stops the moment the run does, and refreshes the cast one last time so
   * the new memory counts land.
   */
  useEffect(() => {
    if (!job || (job.status !== 'planning' && job.status !== 'running')) return;
    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const next = await api.brain.job(job.id);
        if (cancelled) return;
        setJob(next);
        if (next.status !== 'planning' && next.status !== 'running') void load();
      } catch {
        // The server forgot the run (restart, or it aged out). The work is on
        // disk regardless, so drop the bar and re-read the real state.
        if (!cancelled) { setJob(null); void load(); }
      }
    }, 900);
    return () => { cancelled = true; clearInterval(t); };
  }, [job, load]);

  async function patchAll(patch: Partial<BrainConfigFields>) {
    if (!chatId || !data) return;
    // Optimistic: the dials must not lag a round trip.
    setData({
      ...data,
      chatConfig: { ...data.chatConfig, ...patch },
      shared: { ...data.shared, ...patch },
      resolved: { ...data.resolved, ...patch },
      members: data.members.map((m) => (m.config ? { ...m, config: { ...m.config, ...patch } } : m)),
    });
    try {
      const res = await api.brain.chatConfig(chatId, patch);
      setNote(res.applied
        ? `Applied to ${res.applied} mind${res.applied === 1 ? '' : 's'}`
        : 'Saved — minds born here will start with this');
      window.setTimeout(() => setNote(''), 2500);
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Could not save memory settings.');
      await load();
    }
  }

  async function consolidateAll(force = false) {
    if (!chatId) return;
    setError('');
    try {
      // Returns immediately with a job; the bar takes over from here.
      setJob(await api.brain.chatConsolidate(chatId, force));
    } catch (err: any) {
      setError(err?.message ?? 'Consolidation failed.');
    }
  }

  async function cancelRun() {
    if (!job) return;
    try {
      setJob(await api.brain.cancelJob(job.id));
    } catch {
      setJob(null);
    }
  }

  if (!chatId) return <div className="mind-empty">No conversation selected.</div>;

  if (loading) {
    return (
      <div className="mind-empty">
        <GlobeLoader size={36} />
        <p className="t-caption">Reading the cast’s memory…</p>
      </div>
    );
  }

  const cfg = data?.resolved;
  const running = !!job && (job.status === 'planning' || job.status === 'running');
  const withBrains = data?.members.filter((m) => m.hasBrain).length ?? 0;
  const totalMemories = data?.members.reduce((s, m) => s + (m.summary?.counts.total ?? 0), 0) ?? 0;

  return (
    <div className="mind-page mind-cast-page">
      <header className="mind-head">
        <button className="icon-btn" onClick={() => nav(-1)} title="Back">‹</button>
        <Brain size={26} strokeWidth={1.6} />
        <div className="mind-head-meta">
          <h1 className="mind-title">Memory of this scene</h1>
          <p className="t-caption mind-index-sub">
            <button className="mind-chatlink" onClick={() => nav(`/chat/${chatId}`)} title="Back to the conversation">
              <MessageSquare size={12} /> {data?.chatTitle ?? 'this conversation'}
            </button>
            <span>
              {withBrains} of {data?.members.length ?? 0} remembering · {totalMemories} memories in total
            </span>
          </p>
        </div>
        <span style={{ flex: 1 }} />
        <div className="btn-row">
          <button className="btn btn-secondary btn-sm" disabled={running} onClick={() => void consolidateAll(false)}>
            {running ? <><GlobeLoader size={13} /> Running…</> : <><Activity size={14} /> Consolidate all</>}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={running}
            title="Re-read this conversation from the very start, for every character"
            onClick={() => void consolidateAll(true)}
          >
            <RefreshCw size={13} /> Re-read all
          </button>
        </div>
      </header>

      {job && (
        <div className="mind-cast-progress">
          <BrainJobProgress job={job} onCancel={() => void cancelRun()} onDismiss={() => setJob(null)} />
        </div>
      )}

      {error && (
        <div className="mind-banner">
          <TriangleAlert size={15} /> {error}
          <button className="btn btn-ghost btn-sm" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      {note && <p className="t-caption mind-cast-note">{note}</p>}

      {data && !data.globalEnabled && (
        <div className="mind-banner">
          <TriangleAlert size={15} /> Memory is switched off globally — open the Memory drawer to turn
          it back on. Nothing here is deleted meanwhile.
        </div>
      )}

      <section className="mind-cast">
        {data?.members.map((m) => (
          <CastMindCard
            key={m.characterId}
            member={m}
            onOpen={() => nav(`/mind/${encodeURIComponent(chatId)}/${encodeURIComponent(m.characterId)}`)}
          />
        ))}
        {!data?.members.length && (
          <p className="t-caption">No characters in this conversation yet.</p>
        )}
      </section>

      {cfg && (
        <section className="mind-cast-settings">
          <div className="mind-block">
            <p className="field-label"><Activity size={13} /> How often memory forms</p>
            <p className="t-caption">
              Every character in this scene consolidates on this cadence, on its own, in the
              background — each pass is one call to your utility model per character.
            </p>
            <div className="mind-chips">
              {CADENCE.map((n) => (
                <button
                  key={n}
                  className={`chip${cfg.updateEveryMessages === n ? ' active' : ''}`}
                  title={n === 1
                    ? 'One model call per message per character — most responsive, most expensive'
                    : `A pass every ${n} messages`}
                  onClick={() => void patchAll({ updateEveryMessages: n })}
                >
                  {n === 1 ? 'Every msg' : `Every ${n}`}
                </button>
              ))}
            </div>
            <label className="mind-slider">
              <span>
                Consolidate every <b>{cfg.updateEveryMessages}</b>{' '}
                {cfg.updateEveryMessages === 1 ? 'message' : 'messages'}
                {data && data.shared.updateEveryMessages === undefined && <em> mixed across the cast</em>}
              </span>
              <input
                type="range"
                min={1}
                max={40}
                value={cfg.updateEveryMessages}
                onChange={(e) => void patchAll({ updateEveryMessages: Number(e.target.value) })}
              />
            </label>
            <label className="mind-switch">
              <input
                type="checkbox"
                checked={cfg.autoUpdate}
                onChange={(e) => void patchAll({ autoUpdate: e.target.checked })}
              />
              <span>
                <b>Update in the background</b>
                <em>
                  On = every character keeps their memory current by themselves as you play. Off =
                  memory only forms when you press Consolidate here.
                </em>
              </span>
            </label>
          </div>

          <div className="mind-block">
            <p className="field-label"><Gauge size={13} /> Share of the model’s context</p>
            <label className="mind-slider">
              <span>
                Memory may use <b>{Math.round(cfg.shareOfContext * 100)}%</b>
                <em>hard maximum {Math.round(MAX_SHARE * 100)}%</em>
              </span>
              <input
                type="range"
                min={0}
                max={Math.round(MAX_SHARE * 100)}
                value={Math.round(cfg.shareOfContext * 100)}
                onChange={(e) => void patchAll({ shareOfContext: Number(e.target.value) / 100 })}
              />
            </label>
            <p className="t-caption">
              Applies to whichever character is speaking — only their memory is loaded for their
              reply, so the budget is per turn, not per cast.
            </p>
          </div>

          <div className="mind-block">
            <p className="field-label"><Brain size={13} /> What may be remembered</p>
            <label className="mind-switch">
              <input
                type="checkbox"
                checked={cfg.enabled}
                onChange={(e) => void patchAll({ enabled: e.target.checked })}
              />
              <span>
                <b>Characters in this scene remember</b>
                <em>Off = this conversation stops forming memory. Nothing already learned is lost.</em>
              </span>
            </label>
            <label className="mind-switch">
              <input
                type="checkbox"
                checked={cfg.traumaEnabled}
                onChange={(e) => void patchAll({ traumaEnabled: e.target.checked })}
              />
              <span>
                <b>Allow trauma encoding</b>
                <em>
                  Extreme, uncontrollable events lay down a separate sensory trace that resists
                  forgetting, alongside a weaker account of what happened.
                </em>
              </span>
            </label>
            <label className="mind-switch">
              <input
                type="checkbox"
                checked={cfg.intrusionsEnabled}
                onChange={(e) => void patchAll({ intrusionsEnabled: e.target.checked })}
              />
              <span>
                <b>Allow intrusions</b>
                <em>Those traces can surface unbidden when the scene matches them.</em>
              </span>
            </label>
            <p className="t-caption">
              These are this conversation’s settings: they apply to every mind here now, and to any
              character who joins later. A single mind can still be tuned on its own page.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

/** One character's memory at a glance — and the way into the full mind. */
function CastMindCard({ member, onOpen }: { member: ChatMindMember; onOpen: () => void }) {
  const s = member.summary;
  const due = member.pending >= member.cadence;

  return (
    <button
      type="button"
      className={`mind-cast-card${member.hasBrain ? '' : ' is-blank'}`}
      onClick={onOpen}
      title={member.hasBrain
        ? `Open ${member.name}'s mind — memories, psyche, story, log`
        : `${member.name} has not started remembering here yet — open to build their baseline`}
    >
      <Avatar
        src={member.avatar}
        name={member.name}
        characterId={member.characterId}
        size={44}
        shape="square"
        interactive={false}
      />
      <div className="mind-cast-card-meta">
        <span className="mind-cast-card-name">
          {member.name}
          {member.muted && <VolumeX size={12} aria-label="muted" />}
        </span>

        {s ? (
          <>
            <span className="t-caption">
              {s.counts.total} memories · {s.counts.active} active · {s.counts.people} people known
            </span>
            <span className="mind-cast-card-mood">
              {s.mood.label}
              {' · '}
              {member.pending === 0
                ? 'up to date'
                : due
                  ? `${member.pending} unread — a pass is due`
                  : `${member.pending}/${member.cadence} until the next pass`}
            </span>
          </>
        ) : (
          <span className="t-caption">
            {member.missingCard
              ? 'character card is missing from the library'
              : member.muted
                ? 'muted — no memory forms while muted'
                : 'no memory here yet — it starts on its own as you play'}
          </span>
        )}

        {s && !s.enabled && <span className="mind-cast-card-off">memory paused for this character</span>}
      </div>
    </button>
  );
}
