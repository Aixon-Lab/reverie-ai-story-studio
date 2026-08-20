/** Timeline panel — live path, branches history, checkpoint / fork / restore / deep-swipe. */
import { useMemo, useState } from 'react';
import { Bookmark, GitBranch, Trash2, RotateCcw, Pencil, Save, GitFork } from 'lucide-react';
import type { ChatMessage, TimelineFork, TimelineGraphNode, TimelineState } from '@shared/types';
import { branchPointPreview, pathPreview } from '@shared/engine/timeline';
import { useConfirm } from './ConfirmDialog';

const REASON_LABEL: Record<string, string> = {
  checkpoint: 'Checkpoint',
  swipe_switch: 'Swipe switch',
  deep_swipe: 'Deep swipe',
  manual_fork: 'Branch',
  before_restore: 'Before restore',
  before_truncate: 'Before truncate',
  before_delete: 'Before delete',
};

export interface TimelinePanelProps {
  messages: ChatMessage[];
  timeline: TimelineState | null;
  graph: TimelineGraphNode[];
  warning?: string | null;
  busy: boolean;
  selectedMessageId: string | null;
  /** When set, only show forks that split at this message (from badge click). */
  filterForkMessageId?: string | null;
  onClearForkFilter?: () => void;
  onSelectMessage: (id: string) => void;
  onCheckpoint: (name?: string) => void | Promise<void>;
  onBranchFromMessage: (messageId: string) => void | Promise<void>;
  onRestore: (forkId: string) => void | Promise<void>;
  onRename: (forkId: string, name: string) => void | Promise<void>;
  onDelete: (forkId: string) => void | Promise<void>;
  onDeepSwipe: (messageId: string) => void | Promise<void>;
}

export function TimelinePanel({
  messages,
  timeline,
  graph,
  warning,
  busy,
  selectedMessageId,
  filterForkMessageId,
  onClearForkFilter,
  onSelectMessage,
  onCheckpoint,
  onBranchFromMessage,
  onRestore,
  onRename,
  onDelete,
  onDeepSwipe,
}: TimelinePanelProps) {
  const [checkpointName, setCheckpointName] = useState('');
  const forks = timeline?.forks ?? [];
  const sortedForks = useMemo(() => {
    let list = [...forks].sort((a, b) => b.createdAt - a.createdAt);
    if (filterForkMessageId) {
      list = list.filter(
        (f) =>
          f.forkMessageId === filterForkMessageId ||
          (!f.forkMessageId && f.tipMessageId === filterForkMessageId),
      );
    }
    return list;
  }, [forks, filterForkMessageId]);

  return (
    <div className="timeline-panel">
      <div className="timeline-intro">
        <p className="t-caption">
          <strong>Live path</strong> is what you&apos;re in now. <strong>Branch</strong> on any message
          to save the current future and continue from that beat. Switch paths anytime below.
        </p>
      </div>

      <div className="timeline-toolbar">
        <input
          className="input"
          placeholder="Checkpoint name (optional)"
          value={checkpointName}
          onChange={(e) => setCheckpointName(e.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={busy}
          onClick={() => void onCheckpoint(checkpointName || undefined)}
          title="Bookmark the full current path without leaving it"
        >
          <Save size={14} /> Save checkpoint
        </button>
      </div>

      {warning && <p className="timeline-warning t-caption">{warning}</p>}

      <p className="t-caption timeline-section-label">
        Live path · {messages.length} message{messages.length === 1 ? '' : 's'}
      </p>
      <div className="timeline-path">
        {graph.length === 0 && <p className="t-caption">No messages yet.</p>}
        {graph.map((n) => (
          <div
            key={n.id}
            className={
              'timeline-node' +
              (n.id === selectedMessageId ? ' is-selected' : '') +
              (n.isTip ? ' is-tip' : '') +
              (n.swipeCount > 1 ? ' has-swipes' : '') +
              (n.hiddenFromPrompt ? ' is-hidden' : '')
            }
          >
            <span className="timeline-node-spine" aria-hidden />
            <div className="timeline-node-body">
              <button
                type="button"
                className="timeline-node-main"
                onClick={() => onSelectMessage(n.id)}
                disabled={busy}
              >
                <span className="timeline-node-meta">
                  <span className="timeline-node-name">{n.speakerName}</span>
                  {n.swipeCount > 1 && (
                    <span className="timeline-swipe-halo">
                      {n.swipeIndex + 1}/{n.swipeCount}
                    </span>
                  )}
                  {n.isTip && <span className="timeline-tip-badge">Tip</span>}
                </span>
                <span className="timeline-node-preview">{n.preview || '…'}</span>
              </button>
              <span className="timeline-node-actions">
                {!n.isTip && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={() => void onBranchFromMessage(n.id)}
                    title="Save everything after this as a branch and continue from here"
                  >
                    <GitFork size={12} /> Branch
                  </button>
                )}
                {n.canDeepSwipe && !n.isTip && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={() => void onDeepSwipe(n.id)}
                    title="Deep swipe: save future as branch, regenerate here"
                  >
                    Deep swipe
                  </button>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="timeline-branches-header">
        <p className="t-caption timeline-section-label" style={{ margin: 0 }}>
          <GitBranch size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          Branches · {filterForkMessageId ? `${sortedForks.length} filtered` : forks.length}
        </p>
        {filterForkMessageId && onClearForkFilter && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClearForkFilter}>
            Show all
          </button>
        )}
      </div>
      <div className="timeline-forks">
        {sortedForks.length === 0 && (
          <p className="t-caption timeline-empty">
            {filterForkMessageId
              ? 'No branches saved at this message.'
              : 'No branches yet. On any message, use Branch to save the current future and continue from that beat.'}
          </p>
        )}
        {sortedForks.map((f) => (
          <ForkRow
            key={f.id}
            fork={f}
            activeMessages={messages}
            busy={busy}
            onRestore={() => void onRestore(f.id)}
            onRename={(name) => void onRename(f.id, name)}
            onDelete={() => void onDelete(f.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ForkRow({
  fork,
  activeMessages,
  busy,
  onRestore,
  onRename,
  onDelete,
}: {
  fork: TimelineFork;
  activeMessages: ChatMessage[];
  busy: boolean;
  onRestore: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const confirm = useConfirm();
  const point = branchPointPreview(fork, activeMessages);
  return (
    <div className="timeline-fork-row">
      <div className="timeline-fork-main">
        <span className="timeline-fork-name">
          <Bookmark size={12} /> {fork.name}
        </span>
        <span className="timeline-fork-meta t-caption">
          <span className="timeline-reason-chip">{REASON_LABEL[fork.reason] ?? fork.reason}</span>
          <span>· {new Date(fork.createdAt).toLocaleString()}</span>
        </span>
        <span className="t-caption timeline-fork-point">
          Split after · {point}
        </span>
        <span className="t-caption timeline-fork-preview">{pathPreview(fork.messages)}</span>
      </div>
      <div className="timeline-fork-actions">
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={busy}
          onClick={onRestore}
          title="Switch to this path (current path is saved first)"
        >
          <RotateCcw size={14} /> Switch
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={busy}
          title="Rename"
          onClick={() => {
            const name = prompt('Rename branch', fork.name);
            if (name != null && name.trim()) onRename(name.trim());
          }}
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={busy}
          title="Delete branch"
          onClick={async () => {
            const ok = await confirm({
              title: 'Delete this saved branch?',
              body: 'The live chat is not deleted.',
              confirmLabel: 'Delete branch',
              danger: true,
            });
            if (ok) onDelete();
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
