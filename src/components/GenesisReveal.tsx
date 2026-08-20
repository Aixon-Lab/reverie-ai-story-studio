/** Genesis reveal — a new character enters the story.
 *  With image API: shows generated portrait.
 *  Without: portrait frame holds the full image prompt + Copy; user can generate
 *  externally and drop/paste the image here to save it to the character. */
import { useRef, useState } from 'react';
import type { CharacterCard } from '@shared/types';
import { api } from '../api';
import { fileToBase64Cropped } from '../lib/imageCrop';
import { PromptCard } from './PromptCard';
import { GlobeLoader } from './GlobeLoader';

export function GenesisReveal({ draft, onAccept, onDiscard }: {
  draft: { card: CharacterCard; promptCard: string | null };
  onAccept: (card: CharacterCard) => Promise<void>;
  onDiscard: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState(draft.card);
  const [promptCard] = useState(draft.promptCard);
  const [dragOver, setDragOver] = useState(false);
  const [imgNote, setImgNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function applyPortrait(file: File) {
    if (!file.type.startsWith('image/')) {
      setImgNote('Drop a PNG or JPEG portrait');
      return;
    }
    setBusy(true);
    setImgNote('');
    try {
      const b64 = await fileToBase64Cropped(file);
      const updated = await api.setAvatar(card.id, b64);
      setCard(updated);
      setImgNote('Portrait saved to character');
    } catch (e: any) {
      setImgNote(e.message ?? 'Could not save portrait');
    } finally {
      setBusy(false);
    }
  }

  const needsPortrait = !card.avatar && !!promptCard;

  return (
    <div className="genesis-backdrop" role="dialog" aria-label="New character from Genesis">
      <div className="genesis-modal glass-float">
        <p className="t-caption genesis-kicker">Genesis — a new character enters the story</p>

        <div className="genesis-layout">
          {/* 3:4 portrait frame: image OR prompt placeholder */}
          <div
            className={`genesis-frame${dragOver ? ' is-over' : ''}${needsPortrait ? ' is-prompt' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) void applyPortrait(f);
            }}
            onPaste={(e) => {
              const f = e.clipboardData.files[0];
              if (f) void applyPortrait(f);
            }}
          >
            {card.avatar ? (
              <img src={card.avatar} alt={card.name} className="genesis-avatar-img" />
            ) : promptCard ? (
              <div className="genesis-prompt-fill">
                <p className="t-caption genesis-prompt-label">
                  No image API — full portrait prompt (style-matched). Copy, generate elsewhere, then drop the image here.
                </p>
                <div className="genesis-prompt-scroll">
                  <PromptCard prompt={promptCard} />
                </div>
                <label className="btn btn-secondary btn-sm genesis-drop-btn">
                  Drop or upload portrait
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => e.target.files?.[0] && void applyPortrait(e.target.files[0])}
                  />
                </label>
              </div>
            ) : (
              <div className="genesis-empty-frame">
                <p className="t-caption">Portrait pending</p>
                <label className="btn btn-secondary btn-sm">
                  Upload
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => e.target.files?.[0] && void applyPortrait(e.target.files[0])}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="genesis-body">
            <h2 className="t-display-md">{card.name}</h2>
            {card.tags.length > 0 && (
              <p className="t-caption" style={{ marginTop: 4 }}>{card.tags.join(' · ')}</p>
            )}
            {imgNote && (
              <p className="t-caption" style={{ color: 'var(--accent)', marginTop: 8 }}>{imgNote}</p>
            )}
            <p className="t-body-lg genesis-desc">{card.description}</p>
            <p className="genesis-personality">{card.personality}</p>
            {card.first_mes && (
              <>
                <p className="field-label">Entrance line</p>
                <p className="t-caption genesis-first">{card.first_mes}</p>
              </>
            )}
            <div className="genesis-actions">
              <button type="button" className="btn btn-ghost" onClick={onDiscard} disabled={busy}>
                Discard
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onAccept(card);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <><GlobeLoader size={15} /> Entering…</> : 'Let them enter'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
