/** Character Studio — create/edit a card; avatar via drag-drop, paste, or AI generation. */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CharacterCard, CharacterPhoto } from '@shared/types';
import { MAX_CHARACTER_PHOTOS } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';
import { fileToBase64Cropped } from '../lib/imageCrop';
import { PromptCard } from '../components/PromptCard';
import { PortraitCropEditor } from '../components/PortraitCropEditor';
import { useConfirm } from '../components/ConfirmDialog';
import { GlobeLoader } from '../components/GlobeLoader';

const EMPTY: Partial<CharacterCard> = {
  name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
  tags: [], creator: '', system_prompt: '', post_history_instructions: '',
};

export function CharacterStudio() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [card, setCard] = useState<Partial<CharacterCard>>(EMPTY);
  const [status, setStatus] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [imagePrompt, setImagePrompt] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<{ file: File; url: string } | null>(null);
  /** Remaining files from a multi-select, cropped one after another. */
  const [cropQueue, setCropQueue] = useState<File[]>([]);

  useEffect(() => {
    if (!id) return;
    api.listCharacters().then(async (cs) => {
      const found = cs.find((c) => c.id === id);
      if (!found) {
        setStatus('Character not found');
        return;
      }
      setCard(found);
      /**
       * The card list is served straight from disk and does not run the gallery
       * migration, so a character created before photos existed arrives with no
       * `photos` at all. Asking the photos endpoint adopts their existing
       * portrait as the first entry — without this the gallery looks empty for
       * every pre-existing character.
       */
      try {
        const { photos, activePhotoId } = await api.listPhotos(found.id);
        setCard((c) => ({ ...c, photos, activePhotoId }));
      } catch {
        /* gallery unavailable — the rest of the editor still works */
      }
    });
  }, [id]);

  const set = (k: keyof CharacterCard) => (e: { target: { value: string } }) =>
    setCard((c) => ({ ...c, [k]: e.target.value }));

  const full = (card.photos?.length ?? 0) >= MAX_CHARACTER_PHOTOS;

  async function saveCard() {
    try {
      const saved = card.id ? await api.updateCharacter(card.id, card) : await api.createCharacter(card);
      setCard(saved);
      setStatus('Saved ✓');
      setTimeout(() => setStatus(''), 1500);
      void useApp.getState().refreshCharacters();
      return saved;
    } catch (err: any) {
      setStatus(err.message);
      return null;
    }
  }

  /**
   * Queue one or more files for cropping.
   *
   * Multi-select is the point of the gallery, but a portrait still has to be
   * framed to 3:4 — so the files are queued and the crop editor walks through
   * them one at a time rather than silently squashing a batch.
   */
  function openCrop(files: File | File[]) {
    const images = (Array.isArray(files) ? files : [files]).filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;

    const room = MAX_CHARACTER_PHOTOS - (card.photos?.length ?? 0);
    const accepted = images.slice(0, Math.max(0, room));
    if (accepted.length < images.length) {
      setStatus(
        room <= 0
          ? `Already at ${MAX_CHARACTER_PHOTOS} photos — remove one first.`
          : `Only ${accepted.length} of ${images.length} added — that would pass the ${MAX_CHARACTER_PHOTOS}-photo limit.`,
      );
      setTimeout(() => setStatus(''), 3500);
      if (!accepted.length) return;
    }

    if (pendingCrop?.url) URL.revokeObjectURL(pendingCrop.url);
    const [first, ...rest] = accepted;
    setCropQueue(rest);
    setPendingCrop({ file: first, url: URL.createObjectURL(first) });
  }

  /** Advance to the next queued file, or close the cropper. */
  function nextInQueue() {
    if (pendingCrop?.url) URL.revokeObjectURL(pendingCrop.url);
    const [next, ...rest] = cropQueue;
    if (next) {
      setCropQueue(rest);
      setPendingCrop({ file: next, url: URL.createObjectURL(next) });
    } else {
      setPendingCrop(null);
    }
  }

  async function applyCroppedAvatar(blob: Blob) {
    if (!pendingCrop) return;
    let saved = card as CharacterCard;
    if (!card.id) {
      const s = await saveCard();
      if (!s) return;
      saved = s;
    }
    const b64 = await blobToB64(blob);
    try {
      /**
       * Only the first of a batch takes over the profile picture. Uploading five
       * photos and having the last one silently become the portrait is not what
       * anyone means by "add photos" — the user picks which is shown afterwards.
       */
      const isFirst = !(card.photos?.length);
      const updated = await api.addPhoto(saved.id, b64, { select: isFirst });
      setCard(updated);
      setStatus(cropQueue.length ? `Added — ${cropQueue.length} more to crop` : 'Photo added ✓');
    } catch (err: any) {
      setStatus(err?.message ?? 'Could not add that photo.');
    }
    nextInQueue();
    void useApp.getState().refreshCharacters();
    setTimeout(() => setStatus(''), 2500);
  }

  /** Show a different photo from the gallery. */
  async function choosePhoto(photoId: string) {
    if (!card.id || card.activePhotoId === photoId) return;
    try {
      setCard(await api.selectPhoto(card.id, photoId));
      void useApp.getState().refreshCharacters();
    } catch (err: any) {
      setStatus(err?.message ?? 'Could not switch portrait.');
    }
  }

  async function removePhoto(photoId: string) {
    if (!card.id) return;
    const last = (card.photos?.length ?? 0) <= 1;
    const ok = await confirm({
      title: last ? 'Remove the only photo?' : 'Remove this photo?',
      body: last
        ? 'The character will have no portrait until you add one.'
        : undefined,
      confirmLabel: 'Remove photo',
      danger: true,
    });
    if (!ok) return;
    try {
      setCard(await api.deletePhoto(card.id, photoId));
      void useApp.getState().refreshCharacters();
    } catch (err: any) {
      setStatus(err?.message ?? 'Could not remove that photo.');
    }
  }

  async function generateAvatar() {
    let saved = card as CharacterCard;
    if (!card.id) {
      const s = await saveCard();
      if (!s) return;
      saved = s;
    }
    setGenBusy(true);
    setImagePrompt(null);
    try {
      const res = await api.generateImage({ purpose: 'avatar', characterId: saved.id, aspect: '3:4' });
      if (res.url && res.imageId) {
        const blob = await (await fetch(res.url)).blob();
        const updated = await api.setAvatar(
          saved.id,
          await fileToBase64Cropped(new File([blob], 'avatar.png', { type: blob.type || 'image/png' })),
        );
        setCard(updated);
      } else {
        setImagePrompt(res.prompt);
      }
    } catch (err: any) {
      setStatus(err.message);
    } finally {
      setGenBusy(false);
    }
  }

  return (
    <div
      style={{ height: '100%', overflowY: 'auto', padding: '35px 62px' }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        // Dropping a folder of portraits at once is the natural gesture here.
        openCrop(Array.from(e.dataTransfer.files));
      }}
      onPaste={(e) => {
        openCrop(Array.from(e.clipboardData.files));
      }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, marginBottom: 26, flexWrap: 'wrap' }}>
          <h1 className="t-display-md">{card.id ? card.name || 'Character' : 'New Character'}</h1>
          <span
            className="t-caption"
            style={{ color: status.includes('✓') ? 'var(--accent)' : status ? 'var(--danger)' : undefined, minHeight: 16 }}
          >
            {status}
          </span>
          <span style={{ flex: 1 }} />
          {card.id && (
            <>
              <a className="btn btn-ghost btn-sm" href={`/api/characters/${card.id}/export.json`}>Export .json</a>
              <a className="btn btn-ghost btn-sm" href={`/api/characters/${card.id}/export.png`}>Export .png</a>
              <button
                className="btn btn-ghost btn-sm btn-danger"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete “${card.name || 'this character'}”?`,
                    body: 'Removes the card and avatar. This cannot be undone.',
                    confirmLabel: 'Delete character',
                    danger: true,
                  });
                  if (!ok) return;
                  await api.deleteCharacter(card.id!);
                  void useApp.getState().refreshCharacters();
                  void useApp.getState().refreshGroups();
                  nav('/');
                }}
              >
                Delete permanently
              </button>
            </>
          )}
          <button className="btn btn-primary btn-sm" onClick={saveCard} disabled={!card.name?.trim()}>
            Save
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 26 }}>
          <div>
            <div
              className={`dropzone ${dragOver ? 'over' : ''}`}
              style={{
                aspectRatio: '3/4',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              {card.avatar ? (
                <img
                  src={card.avatar}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--r-card)' }}
                />
              ) : (
                <span className="t-caption" style={{ textAlign: 'center', padding: 18 }}>
                  Drop or paste a portrait,<br />or generate one
                </span>
              )}
            </div>
            <PhotoStrip
              photos={card.photos ?? []}
              activeId={card.activePhotoId}
              saved={!!card.id}
              onSelect={choosePhoto}
              onRemove={removePhoto}
              onAdd={openCrop}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <label
                className="btn btn-secondary btn-sm"
                style={{
                  cursor: full ? 'not-allowed' : 'pointer',
                  flex: 1,
                  opacity: full ? 0.5 : 1,
                }}
                title={full ? `Maximum ${MAX_CHARACTER_PHOTOS} photos — remove one first` : 'Add a photo'}
              >
                {full ? 'Gallery full' : 'Upload'}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  disabled={full}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length) openCrop(files);
                    e.target.value = '';
                  }}
                />
              </label>
              <button
                className="btn btn-secondary btn-sm"
                style={{ flex: 1 }}
                onClick={generateAvatar}
                disabled={genBusy || !card.name?.trim() || full}
                title={full ? `Maximum ${MAX_CHARACTER_PHOTOS} photos — remove one first` : undefined}
              >
                {genBusy ? <><GlobeLoader size={13} /> Generating…</> : 'Generate'}
              </button>
            </div>
            {imagePrompt && (
              <div style={{ marginTop: 12 }}>
                <p className="t-caption" style={{ marginBottom: 8 }}>
                  No image API — run this prompt anywhere and drop the result above:
                </p>
                <PromptCard prompt={imagePrompt} />
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Field label="Name">
              <input className="input" value={card.name ?? ''} onChange={set('name')} placeholder="Who are they?" />
            </Field>
            <Field label="Description — appearance, background, world">
              <textarea className="textarea" rows={6} value={card.description ?? ''} onChange={set('description')} />
            </Field>
            <Field label="Personality — traits, flaws, voice">
              <textarea className="textarea" rows={3} value={card.personality ?? ''} onChange={set('personality')} />
            </Field>
            <Field label="Scenario — where the story starts">
              <textarea className="textarea" rows={2} value={card.scenario ?? ''} onChange={set('scenario')} />
            </Field>
            <Field label="First Message — their opening line">
              <textarea className="textarea" rows={4} value={card.first_mes ?? ''} onChange={set('first_mes')} />
            </Field>
            <Field label="Alternate Greetings (one per block, separated by ---)">
              <textarea
                className="textarea"
                rows={5}
                value={(card.alternate_greetings ?? []).join('\n---\n')}
                onChange={(e) =>
                  setCard((c) => ({
                    ...c,
                    alternate_greetings: e.target.value
                      .split(/\n---\n/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }))
                }
                placeholder="Swipe alternatives for the first message…"
              />
            </Field>
            <Field label="Example Dialogue (separate scenes with <START>)">
              <textarea className="textarea" rows={4} value={card.mes_example ?? ''} onChange={set('mes_example')} />
            </Field>
            <Field label="Tags (comma separated)">
              <input
                className="input"
                value={(card.tags ?? []).join(', ')}
                onChange={(e) =>
                  setCard((c) => ({
                    ...c,
                    tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean),
                  }))
                }
              />
            </Field>
            <Field label="Creator notes">
              <textarea className="textarea" rows={2} value={card.creator_notes ?? ''} onChange={set('creator_notes')} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <Field label="Talkativeness (0–1)">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={Number(card.extensions?.talkativeness ?? 0.5)}
                  onChange={(e) =>
                    setCard((c) => ({
                      ...c,
                      extensions: { ...(c.extensions ?? {}), talkativeness: Number(e.target.value) },
                    }))
                  }
                />
              </Field>
              <Field label="Linked lorebook id">
                <input
                  className="input"
                  value={String(card.extensions?.world ?? '')}
                  onChange={(e) =>
                    setCard((c) => ({
                      ...c,
                      extensions: { ...(c.extensions ?? {}), world: e.target.value },
                    }))
                  }
                  placeholder="lorebook id"
                />
              </Field>
              <label className="fmt-check" style={{ alignSelf: 'end', marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={!!card.extensions?.fav}
                  onChange={(e) =>
                    setCard((c) => ({
                      ...c,
                      extensions: { ...(c.extensions ?? {}), fav: e.target.checked },
                    }))
                  }
                />
                <span>Favorite</span>
              </label>
            </div>
            <details>
              <summary className="t-caption" style={{ cursor: 'pointer', marginBottom: 12 }}>
                Advanced — system prompt, depth prompt, version
              </summary>
              <Field label="System Prompt (overrides preset main prompt; {{original}} embeds it)">
                <textarea className="textarea" rows={3} value={card.system_prompt ?? ''} onChange={set('system_prompt')} />
              </Field>
              <Field label="Post-History Instructions">
                <textarea
                  className="textarea"
                  rows={3}
                  value={card.post_history_instructions ?? ''}
                  onChange={set('post_history_instructions')}
                />
              </Field>
              <Field label="Depth prompt (injected near chat end)">
                <textarea
                  className="textarea"
                  rows={3}
                  value={card.extensions?.depth_prompt?.prompt ?? ''}
                  onChange={(e) =>
                    setCard((c) => ({
                      ...c,
                      extensions: {
                        ...(c.extensions ?? {}),
                        depth_prompt: {
                          depth: c.extensions?.depth_prompt?.depth ?? 4,
                          role: c.extensions?.depth_prompt?.role ?? 'system',
                          prompt: e.target.value,
                        },
                      },
                    }))
                  }
                />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Depth">
                  <input
                    className="input"
                    type="number"
                    value={card.extensions?.depth_prompt?.depth ?? 4}
                    onChange={(e) =>
                      setCard((c) => ({
                        ...c,
                        extensions: {
                          ...(c.extensions ?? {}),
                          depth_prompt: {
                            depth: Number(e.target.value),
                            role: c.extensions?.depth_prompt?.role ?? 'system',
                            prompt: c.extensions?.depth_prompt?.prompt ?? '',
                          },
                        },
                      }))
                    }
                  />
                </Field>
                <Field label="Character version">
                  <input className="input" value={card.character_version ?? ''} onChange={set('character_version')} />
                </Field>
              </div>
            </details>
          </div>
        </div>
      </div>

      {pendingCrop && (
        <PortraitCropEditor
          file={pendingCrop.file}
          imageUrl={pendingCrop.url}
          onCancel={() => {
            // Cancelling one image of a batch skips to the next rather than
            // throwing away everything the user just selected.
            nextInQueue();
          }}
          onApply={applyCroppedAvatar}
        />
      )}
    </div>
  );
}

/**
 * Portrait gallery strip.
 *
 * Click a thumbnail to show it; the shown one is ringed rather than merely
 * highlighted, because "which of these is the actual portrait" is the only
 * question this control exists to answer. Remove appears on hover so ten
 * thumbnails do not read as ten delete buttons.
 *
 * Hidden entirely below two photos: a strip showing one thumbnail identical to
 * the portrait directly above it is pure noise.
 */
function PhotoStrip({
  photos, activeId, saved, onSelect, onRemove, onAdd,
}: {
  photos: CharacterPhoto[];
  activeId?: string;
  /** Photos need a character on disk to attach to. */
  saved: boolean;
  onSelect: (photoId: string) => void;
  onRemove: (photoId: string) => void;
  onAdd: (files: File[]) => void;
}) {
  const active = activeId ?? photos[0]?.id;
  const full = photos.length >= MAX_CHARACTER_PHOTOS;

  return (
    <div className="photo-gallery">
      <div className="photo-gallery-head">
        <span className="field-label" style={{ margin: 0 }}>Photos</span>
        <span className="t-caption">{photos.length} / {MAX_CHARACTER_PHOTOS}</span>
      </div>

      {!saved ? (
        <p className="t-caption photo-gallery-empty">
          Save the character first, then you can add up to {MAX_CHARACTER_PHOTOS} photos here.
        </p>
      ) : (
        <>
          <div className="photo-strip-grid">
            {photos.map((p) => (
              <div key={p.id} className={`photo-thumb${p.id === active ? ' is-active' : ''}`}>
                <button
                  type="button"
                  className="photo-thumb-pick"
                  onClick={() => onSelect(p.id)}
                  title={p.id === active ? 'This is the profile picture' : 'Use as profile picture'}
                  aria-pressed={p.id === active}
                  aria-label={p.id === active ? 'Current profile picture' : 'Use as profile picture'}
                >
                  <img src={p.url} alt={p.label ?? ''} loading="lazy" />
                  {/* Only the unselected ones offer the action — the selected one
                      states its status instead, so the strip reads as a choice. */}
                  {p.id !== active && <span className="photo-thumb-action">Use as profile</span>}
                </button>
                {p.id === active && <span className="photo-thumb-badge">Profile picture</span>}
                <button
                  type="button"
                  className="photo-thumb-remove"
                  title="Delete this photo"
                  aria-label="Delete this photo"
                  onClick={() => onRemove(p.id)}
                >
                  ×
                </button>
              </div>
            ))}

            {!full && (
              <label className="photo-thumb photo-thumb-add" title="Add photos">
                <span>+</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length) onAdd(files);
                    // Reset so re-picking the same file fires onChange again.
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>

          <p className="t-caption photo-gallery-hint">
            {photos.length === 0
              ? 'No photos yet — drop images here, or use the + tile. You can add several at once.'
              : full
                ? `Gallery full. Delete one to add another.`
                : 'Click a photo to make it the profile picture. × deletes it.'}
          </p>
        </>
      )}
    </div>
  );
}

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
