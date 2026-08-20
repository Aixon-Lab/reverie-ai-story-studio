/**
 * What a consolidation run is actually doing.
 *
 * Reading a long conversation is a few minutes of model calls. The old spinner
 * said "Consolidating…" for all of it, which is indistinguishable from a hang —
 * and it *was* a hang, often. This shows the shape of the work: how much of the
 * whole run is done, which character is being read right now, and how many
 * memories each of them has formed as it goes.
 *
 * The bar is chunk-based because chunks are the unit of real progress: each one
 * is a finished model call whose result is already saved. Stopping is safe for
 * the same reason, which is why Stop sits right on the bar.
 */
import { Square } from 'lucide-react';
import type { BrainJob, BrainJobMember } from '../api';
import { jobPercent } from '@shared/brain/jobProgress';
import { GlobeLoader } from './GlobeLoader';

export function BrainJobProgress({
  job, onCancel, onDismiss,
}: {
  job: BrainJob;
  onCancel?: () => void;
  onDismiss?: () => void;
}) {
  const live = job.status === 'planning' || job.status === 'running';
  // Same arithmetic the server uses, so the bar cannot tell a different story.
  const pct = jobPercent(job, !live);
  const encoded = job.members.reduce((s, m) => s + m.encoded, 0);
  const current = job.members.find((m) => m.characterId === job.currentCharacterId);

  return (
    <section className={`brain-job is-${job.status}`} aria-live="polite">
      <header className="brain-job-head">
        <span className="brain-job-title">
          {live && <GlobeLoader size={14} title="Working" />}
          {job.status === 'planning' && 'Working out how much there is to read…'}
          {job.status === 'running' && (
            current
              ? <>Reading <b>{current.name}</b>’s side of the scene</>
              : <>{job.kind === 'reread' ? 'Re-reading' : 'Consolidating'} the conversation</>
          )}
          {job.status === 'done' && <>Finished — {encoded} {encoded === 1 ? 'memory' : 'memories'} formed or updated</>}
          {job.status === 'cancelled' && <>Stopped — everything read so far was kept</>}
          {job.status === 'error' && <>Consolidation failed: {job.error}</>}
        </span>

        <span className="brain-job-count">
          {job.chunks > 0 && `${Math.min(job.chunksDone, job.chunks)}/${job.chunks} passes`}
        </span>

        {live && onCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} title="Stop after the current pass">
            <Square size={11} /> Stop
          </button>
        )}
        {!live && onDismiss && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>Dismiss</button>
        )}
      </header>

      <div
        className="brain-job-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Consolidation progress"
      >
        <i className={`brain-job-fill${live ? ' is-live' : ''}`} style={{ width: `${pct}%` }} />
      </div>

      <ul className="brain-job-members">
        {job.members.map((m) => (
          <MemberRow key={m.characterId} member={m} active={m.characterId === job.currentCharacterId} />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({ member, active }: { member: BrainJobMember; active: boolean }) {
  const pct = member.chunks > 0
    ? Math.min(100, Math.round((member.chunksDone / member.chunks) * 100))
    : member.status === 'done' ? 100 : 0;

  return (
    <li className={`brain-job-member is-${member.status}${active ? ' is-active' : ''}`}>
      <span className="brain-job-member-name">{member.name}</span>
      <span className="brain-job-member-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="brain-job-member-note">
        {member.status === 'skipped' && (member.reason ?? 'skipped')}
        {member.status === 'error' && (member.error ?? 'failed')}
        {member.status === 'pending' && (member.messages ? `${member.messages} to read` : 'up to date')}
        {(member.status === 'running' || member.status === 'done') && (
          member.encoded
            ? `${member.encoded} ${member.encoded === 1 ? 'memory' : 'memories'}`
            : member.status === 'done' ? (member.reason ?? 'nothing new to keep') : 'reading…'
        )}
      </span>
    </li>
  );
}
