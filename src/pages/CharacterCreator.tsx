/**
 * Character Creator — import card / pick existing / drop portrait,
 * 3:4 crop, domain-pack AI (gist + vision), full ST card editor.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Upload, UserRound, AlertTriangle, Check, X, ClipboardPaste } from 'lucide-react';
import { IconAi } from '../components/Icons';
import { GlobeLoader, PageLoader } from '../components/GlobeLoader';
import type { CharacterCard, CharacterPhoto } from '@shared/types';
import { MAX_CHARACTER_PHOTOS } from '@shared/types';
import {
  SETTING_LABELS,
  emptyPack,
  packToDescription,
  packToPersonality,
  type CharacterCreatorPack,
  type SettingKind,
} from '@shared/engine/characterDomains';
import { api, fileToBase64 } from '../api';
import { useApp } from '../store';
import { PortraitCropEditor } from '../components/PortraitCropEditor';
import { useConfirm } from '../components/ConfirmDialog';

const EMPTY: Partial<CharacterCard> = {
  name: '',
  description: '',
  personality: '',
  // No `scenario`: meeting context is authored per-chat in the Author's Note.
  // Imported ST cards may still carry one; it is preserved, never authored here.
  first_mes: '',
  mes_example: '',
  tags: [],
  creator: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  extensions: {},
};

type EntryMode = 'hub' | 'edit';

/** A cropped portrait held in memory until the character exists on disk. */
type StagedPhoto = { id: string; b64: string; url: string };

export function CharacterCreator() {
  const { id } = useParams<{ id?: string }>();
  const [search] = useSearchParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const characters = useApp((s) => s.characters);
  const refreshCharacters = useApp((s) => s.refreshCharacters);

  const [mode, setMode] = useState<EntryMode>(id || search.get('new') === '1' ? 'edit' : 'hub');
  const [card, setCard] = useState<Partial<CharacterCard>>(EMPTY);
  const [pack, setPack] = useState<CharacterCreatorPack>(emptyPack('modern'));
  const [setting, setSetting] = useState<SettingKind>('modern');
  const [gist, setGist] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'gist' | 'vision' | 'save' | null>(null);
  const [booting, setBooting] = useState(!!(id || undefined));
  const [poolQ, setPoolQ] = useState('');
  const [pendingCrop, setPendingCrop] = useState<{ file: File; url: string } | null>(null);
  const [visionConfirm, setVisionConfirm] = useState(false);
  /** Where a scan would run right now — probed when the confirm dialog opens. */
  const [localVision, setLocalVision] = useState<Awaited<ReturnType<typeof api.localVisionStatus>> | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [pendingAvatarB64, setPendingAvatarB64] = useState<string | null>(null);
  /** Portrait gallery (max MAX_CHARACTER_PHOTOS). Loaded separately — the card list does not carry it. */
  const [photos, setPhotos] = useState<CharacterPhoto[]>([]);
  /**
   * The cap, as reported by the server.
   *
   * The bundled constant is only the starting guess. A built `dist/` can be
   * older than the running server, and when the two disagreed the gallery let
   * you pick and crop a photo the server then refused to store — the work was
   * done and thrown away at the last step. Whoever actually enforces the limit
   * is the only honest source for it, so the number is taken from the same
   * endpoint that lists the photos.
   */
  const [maxPhotos, setMaxPhotos] = useState(MAX_CHARACTER_PHOTOS);
  const [activePhotoId, setActivePhotoId] = useState<string | undefined>();
  /**
   * Photos cropped before the character exists on disk. They behave exactly like
   * saved ones (pick the profile, delete, up to ten) and are uploaded in order by
   * `saveCard`, so nobody has to save a half-finished card just to attach a
   * second portrait.
   */
  const [staged, setStaged] = useState<StagedPhoto[]>([]);
  const [stagedActiveId, setStagedActiveId] = useState<string | undefined>();
  /** Remaining files from a multi-select, cropped one after another. */
  const [cropQueue, setCropQueue] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const cardFileRef = useRef<HTMLInputElement>(null);

  const loadId = id || search.get('id') || undefined;

  useEffect(() => {
    void refreshCharacters();
  }, [refreshCharacters]);

  // Probe on open so the dialog states where the image actually goes, rather
  // than promising local and discovering otherwise after the user consents.
  useEffect(() => {
    if (!visionConfirm) return;
    let live = true;
    setLocalVision(null);
    api.localVisionStatus()
      .then((s) => {
        if (!live) return;
        setLocalVision(s);
        // Load the model while they read the dialog. Loading it costs tens of
        // seconds the first time, and doing it here hides almost all of that
        // behind a decision the user is making anyway.
        if (s.available && s.engineReady && s.weightsReady && !s.running) {
          void api.localVisionWarmup().catch(() => {});
        }
      })
      .catch(() => { /* dialog falls back to neutral copy */ });
    return () => { live = false; };
  }, [visionConfirm]);

  useEffect(() => {
    if (!loadId) {
      setBooting(false);
      return;
    }
    setMode('edit');
    setBooting(true);
    api.listCharacters().then((cs) => {
      const found = cs.find((c) => c.id === loadId);
      if (!found) {
        setError('Character not found');
        return;
      }
      applyCard(found);
    }).catch((e) => setError(e.message))
      .finally(() => setBooting(false));
  }, [loadId]);

  function applyCard(c: CharacterCard) {
    clearStaged();
    setCard(c);
    setAvatarPreview(c.avatar ?? null);
    setPendingAvatarB64(null);
    void loadPhotos(c.id);
    const ext = c.extensions as Record<string, unknown> | undefined;
    const saved = ext?.creatorPack as CharacterCreatorPack | undefined;
    if (saved?.physical) {
      setPack(saved);
      setSetting(saved.setting || 'modern');
    } else {
      setPack(emptyPack(setting));
    }
    setMode('edit');
  }

  /** Drop every trace of whatever character was last open. */
  function resetDraft() {
    clearStaged();
    setCard({ ...EMPTY });
    setPack(emptyPack(setting));
    setGist('');
    setPhotos([]);
    setActivePhotoId(undefined);
    if (avatarPreview?.startsWith('blob:')) URL.revokeObjectURL(avatarPreview);
    setAvatarPreview(null);
    setPendingAvatarB64(null);
    setError('');
    setStatus('');
    if (loadId) nav('/creator');
  }

  function clearStaged() {
    setStaged((prev) => {
      for (const p of prev) URL.revokeObjectURL(p.url);
      return [];
    });
    setStagedActiveId(undefined);
  }

  function startBlank() {
    resetDraft();
    setMode('edit');
  }

  /** Back to the library — the hub must not keep editing state alive behind it. */
  function backToHub() {
    resetDraft();
    setMode('hub');
    nav('/creator');
  }

  /**
   * Hub upload / paste / drop always starts a *new* character. Reusing the card
   * still sitting in state is how a portrait ended up bolted onto whichever
   * character was saved last.
   */
  function beginNewFromMedia(files: File | File[]) {
    resetDraft();
    onImageFile(files, { forNew: true });
  }

  /** Route dropped/pasted images by where the user actually is. */
  function deliverImages(files: File | File[]) {
    if (mode === 'hub') beginNewFromMedia(files);
    else onImageFile(files);
  }

  async function importCardFile(file: File) {
    setError('');
    try {
      if (!/\.(png|json)$/i.test(file.name)) {
        setError('Import .png or .json character cards');
        return;
      }
      const b64 = await fileToBase64(file);
      const imported = await api.importCharacter(file.name, b64);
      await refreshCharacters();
      applyCard(imported);
      nav(`/creator/${imported.id}`);
      setStatus('Card imported');
    } catch (e: any) {
      setError(e.message ?? 'Import failed');
    }
  }

  /**
   * Pull the gallery for a saved character.
   *
   * Separate from the card because the card list is served straight off disk and
   * carries no photos; this call also runs the server-side migration that adopts
   * a pre-gallery portrait as photo #1, so existing characters are never shown an
   * empty strip while their portrait is visible right above it.
   */
  async function loadPhotos(characterId?: string) {
    if (!characterId) {
      setPhotos([]);
      setActivePhotoId(undefined);
      return;
    }
    try {
      const r = await api.listPhotos(characterId);
      setPhotos(r.photos);
      setActivePhotoId(r.activePhotoId);
      if (Number.isFinite(r.max) && r.max > 0) setMaxPhotos(r.max);
    } catch {
      setPhotos([]);
    }
  }

  /**
   * `forNew` means "these belong to a character that does not exist yet" — the
   * hub uses it because `card` may still hold the character saved a moment ago
   * and state updates from the reset have not landed in this closure.
   */
  function onImageFile(files: File | File[], opts?: { forNew?: boolean }) {
    const images = (Array.isArray(files) ? files : [files]).filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      setError('Drop an image or character card');
      return;
    }

    // Refuse the overflow up front rather than failing after the crop.
    // Unsaved characters count their staged crops; saved ones count what is on disk.
    const used = opts?.forNew ? 0 : card.id ? photos.length : staged.length;
    const room = maxPhotos - used;
    const accepted = images.slice(0, Math.max(0, room));
    if (accepted.length < images.length) {
      setError(room <= 0
        ? `Already at ${maxPhotos} photos — delete one first.`
        : `Only ${accepted.length} of ${images.length} taken — ${maxPhotos} is the limit.`);
      if (!accepted.length) return;
    }

    if (pendingCrop?.url) URL.revokeObjectURL(pendingCrop.url);
    const [first, ...rest] = accepted;
    setCropQueue(rest);
    setPendingCrop({ file: first, url: URL.createObjectURL(first) });
    setMode('edit');
    // Keep the "only N of M taken" warning if there was one.
    if (accepted.length === images.length) setError('');
    setStatus(rest.length ? `Crop portrait 1 of ${accepted.length}` : 'Crop portrait to 3:4');
  }

  /** Advance to the next queued file, or close the cropper. */
  function nextInQueue() {
    if (pendingCrop?.url) URL.revokeObjectURL(pendingCrop.url);
    const [next, ...rest] = cropQueue;
    if (next) {
      setCropQueue(rest);
      setPendingCrop({ file: next, url: URL.createObjectURL(next) });
      setStatus(`Crop portrait — ${rest.length + 1} left`);
    } else {
      setPendingCrop(null);
    }
  }

  async function choosePhoto(photoId: string) {
    if (!card.id) {
      const pick = staged.find((p) => p.id === photoId);
      if (!pick) return;
      setStagedActiveId(pick.id);
      setAvatarPreview(pick.url);
      setPendingAvatarB64(pick.b64);
      setStatus('Profile picture set — saved with the character');
      return;
    }
    if (photoId === activePhotoId) return;
    try {
      const updated = await api.selectPhoto(card.id, photoId);
      setCard(updated);
      setActivePhotoId(updated.activePhotoId);
      setAvatarPreview(updated.avatar ?? null);
      setPendingAvatarB64(null);
      await refreshCharacters();
      setStatus('Profile picture updated ✓');
    } catch (e: any) {
      setError(e?.message ?? 'Could not switch the profile picture.');
    }
  }

  async function removePhoto(photoId: string) {
    if (!card.id) {
      const rest = staged.filter((p) => p.id !== photoId);
      const gone = staged.find((p) => p.id === photoId);
      if (!gone) return;
      URL.revokeObjectURL(gone.url);
      setStaged(rest);
      if (stagedActiveId === photoId) {
        const next = rest[0];
        setStagedActiveId(next?.id);
        setAvatarPreview(next?.url ?? null);
        setPendingAvatarB64(next?.b64 ?? null);
      }
      setStatus(rest.length ? 'Photo removed' : 'No photos staged');
      return;
    }
    const last = photos.length <= 1;
    const ok = await confirm({
      title: last ? 'Delete the only photo?' : 'Delete this photo?',
      body: last
        ? 'The character will have no portrait until you add one.'
        : undefined,
      confirmLabel: 'Delete photo',
      danger: true,
    });
    if (!ok) return;
    try {
      const updated = await api.deletePhoto(card.id, photoId);
      setCard(updated);
      setAvatarPreview(updated.avatar ?? null);
      await loadPhotos(card.id);
      await refreshCharacters();
      setStatus('Photo deleted');
    } catch (e: any) {
      setError(e?.message ?? 'Could not delete that photo.');
    }
  }

  const deliverRef = useRef(deliverImages);
  deliverRef.current = deliverImages;

  /** Click-to-paste: reads the system clipboard (needs a user gesture + permission). */
  async function pastePortraitFromClipboard() {
    setError('');
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (!type) continue;
          const blob = await item.getType(type);
          const ext = type.split('/')[1]?.split('+')[0] || 'png';
          deliverImages(new File([blob], `clipboard.${ext}`, { type }));
          return;
        }
        setError('No image on clipboard — copy a portrait, then Paste or Ctrl+V');
        return;
      }
      setError('Clipboard read not available here — click the portrait and press Ctrl+V');
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? '');
      if (/denied|permission|not allowed/i.test(msg)) {
        setError('Clipboard permission denied — click the portrait and press Ctrl+V instead');
      } else {
        setError(msg || 'Could not read clipboard — try Ctrl+V on the portrait');
      }
    }
  }

  // Ctrl+V / Cmd+V anywhere on this page while Creator is open (hub or editor).
  // Image on clipboard always becomes the portrait crop; text-only paste is left alone.
  useEffect(() => {
    function onDocPaste(e: ClipboardEvent) {
      const file = imageFileFromClipboard(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      deliverRef.current(file);
    }
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  }, []);

  async function applyCroppedPortrait(blob: Blob) {
    if (!pendingCrop) return;
    const b64 = await blobToB64(blob);

    /**
     * An unsaved character has nowhere to put a photo yet, so crops pile up in
     * `staged` — a full gallery in memory — and `saveCard` uploads them all.
     * A saved one goes straight into the gallery on disk.
     */
    if (!card.id) {
      const url = URL.createObjectURL(blob);
      const entry: StagedPhoto = { id: `staged-${Date.now()}-${staged.length}`, b64, url };
      const isFirst = staged.length === 0;
      setStaged((prev) => [...prev, entry]);
      if (isFirst) {
        setStagedActiveId(entry.id);
        setAvatarPreview(url);
        setPendingAvatarB64(b64);
      }
      nextInQueue();
      setStatus(cropQueue.length
        ? `Staged — ${cropQueue.length} more to crop`
        : `Portrait cropped 3:4 — save to keep ${staged.length + 1 > 1 ? 'them' : 'it'}`);
      return;
    }

    try {
      // Only the first photo of an empty gallery takes over the profile picture;
      // a batch must not have its last image silently hijack the portrait.
      const isFirst = photos.length === 0;
      const updated = await api.addPhoto(card.id, b64, { select: isFirst });
      setCard(updated);
      if (isFirst) setAvatarPreview(updated.avatar ?? null);
      await loadPhotos(card.id);
      await refreshCharacters();
      setStatus(cropQueue.length ? `Added — ${cropQueue.length} more to crop` : 'Photo added ✓');
    } catch (e: any) {
      setError(e?.message ?? 'Could not add that photo.');
    }
    nextInQueue();
  }

  async function saveCard() {
    if (!card.name?.trim()) {
      setError('Name is required');
      return;
    }
    setBusy('save');
    setError('');
    try {
      const payload: Partial<CharacterCard> = {
        ...card,
        name: card.name.trim(),
        tags: card.tags ?? [],
        extensions: {
          ...(card.extensions ?? {}),
          creatorPack: { ...pack, setting, gist: gist || pack.gist },
        },
      };
      const saved = card.id
        ? await api.updateCharacter(card.id, payload)
        : await api.createCharacter(payload);
      let final = saved;
      if (staged.length) {
        // Upload in the order they were cropped; only the chosen one takes the
        // profile slot, so a batch never has its last image hijack the portrait.
        const activeId = stagedActiveId ?? staged[0].id;
        for (const p of staged) {
          final = await api.addPhoto(saved.id, p.b64, { select: p.id === activeId });
        }
        clearStaged();
        await loadPhotos(saved.id);
        setPendingAvatarB64(null);
      } else if (pendingAvatarB64) {
        final = await api.setAvatar(saved.id, pendingAvatarB64);
        setPendingAvatarB64(null);
      }
      setCard(final);
      setAvatarPreview(final.avatar ?? avatarPreview);
      await refreshCharacters();
      setStatus('Saved ✓');
      if (!id) nav(`/creator/${final.id}`, { replace: true });
    } catch (e: any) {
      setError(e.message ?? 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function deleteCharacterPermanently() {
    if (!card.id) return;
    const name = card.name?.trim() || 'this character';
    const ok = await confirm({
      title: `Delete “${name}”?`,
      body: 'This removes the card and avatar from disk. Chats that used them are not auto-deleted.',
      confirmLabel: 'Delete character',
      danger: true,
    });
    if (!ok) return;
    setBusy('save');
    setError('');
    try {
      await api.deleteCharacter(card.id);
      await refreshCharacters();
      void useApp.getState().refreshGroups();
      setStatus('Deleted permanently');
      setMode('hub');
      clearStaged();
      setCard({ ...EMPTY });
      setPhotos([]);
      setActivePhotoId(undefined);
      setAvatarPreview(null);
      setPendingAvatarB64(null);
      nav('/creator', { replace: true });
    } catch (e: any) {
      setError(e.message ?? 'Delete failed');
    } finally {
      setBusy(null);
    }
  }

  /** Card fields exactly as the editor shows them — empty ones omitted. */
  function currentCardFields(): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    const put = (k: string, v?: string) => {
      if (v?.trim()) fields[k] = v.trim();
    };
    put('name', card.name);
    put('description', card.description);
    put('personality', card.personality);
    put('first_mes', card.first_mes);
    put('mes_example', card.mes_example);
    put('system_prompt', card.system_prompt);
    put('post_history_instructions', card.post_history_instructions);
    if (card.tags?.length) fields.tags = card.tags;
    return fields;
  }

  /**
   * The brief driving a generation: the gist box, or — when it is empty because
   * the user is steering by editing the card instead — the description they just
   * wrote. Something always has to carry the intent.
   */
  function liveBrief(): string {
    return gist.trim() || card.description?.trim() || '';
  }

  /**
   * AI Fill — and re-Fill. Every run reads the editor as it stands *now*: the
   * gist box plus whatever the user has since typed into the card fields. Edit
   * the description and press the button again and the card follows the edit,
   * rather than replaying the gist that produced the last result.
   */
  async function runGistAi() {
    const brief = liveBrief();
    if (!brief && !pack.physical?.visualKeywords?.length && !pack.physical?.hair?.color) {
      setError('Write a gist of the character (or run image analysis first)');
      return;
    }
    setBusy('gist');
    setError('');
    try {
      /**
       * Only portrait-derived physicals are locked. Physicals the model invented
       * on an earlier run must stay negotiable, otherwise "make her blonde" in
       * the description loses to the black hair it chose the first time.
       */
      const visionLocked = !!pack.visionAnalyzedAt && !!pack.physical;
      const res = await api.generateCharacter({
        gist: brief || 'Complete the character from physical analysis and setting.',
        setting,
        nameHint: card.name,
        physicalLock: visionLocked ? pack.physical : undefined,
        existingPartial: currentCardFields(),
      });
      const nextPack = (res.pack as CharacterCreatorPack) ?? pack;
      if (nextPack.physical) nextPack.physical.age = Math.max(19, Number(nextPack.physical.age) || 22);
      setPack({ ...nextPack, setting, gist });
      setCard((c) => ({
        ...c,
        name: res.name || c.name,
        description: res.description || (nextPack.physical ? packToDescription(nextPack) : c.description),
        personality: res.personality || (nextPack.psyche ? packToPersonality(nextPack) : c.personality),
        first_mes: res.first_mes || c.first_mes,
        mes_example: res.mes_example || c.mes_example,
        tags: res.tags?.length ? res.tags : c.tags,
        system_prompt: res.system_prompt || c.system_prompt,
        post_history_instructions: res.post_history_instructions || c.post_history_instructions,
        creator_notes: res.creator_notes || c.creator_notes,
      }));
      setStatus('AI filled card + domains');
    } catch (e: any) {
      setError(e.message ?? 'Generation failed');
    } finally {
      setBusy(null);
    }
  }

  async function runVisionAi() {
    setVisionConfirm(false);
    const b64 = pendingAvatarB64 || (avatarPreview?.startsWith('data:') ? avatarPreview.split(',')[1] : null);
    let imageBase64 = b64;
    let mime = 'image/png';
    if (!imageBase64 && avatarPreview && avatarPreview.startsWith('/')) {
      // fetch stored avatar
      try {
        const blob = await (await fetch(avatarPreview)).blob();
        mime = blob.type || 'image/png';
        imageBase64 = await blobToB64(blob);
      } catch {
        setError('Could not read avatar for analysis');
        return;
      }
    }
    if (!imageBase64) {
      setError('Upload or crop a portrait first');
      return;
    }
    setBusy('vision');
    setError('');
    try {
      const res = await api.analyzeCharacterImage(imageBase64, mime);
      const physical = res.physical as CharacterCreatorPack['physical'];
      if (physical) physical.age = Math.max(19, Number(physical.age) || 22);
      const next = {
        ...pack,
        setting,
        physical: { ...pack.physical, ...physical },
        visionAnalyzedAt: res.analyzedAt,
      };
      setPack(next);
      // seed description from physical immediately
      setCard((c) => ({
        ...c,
        description: packToDescription(next) + (c.description ? `\n\n${c.description}` : ''),
      }));
      setStatus(
        res.local
          ? `Scanned on this device (${res.model ?? 'local model'}) — image never left your computer. `
            + 'Run AI gist to complete psyche & lore.'
          : 'Vision: physical details filled — run AI gist to complete psyche & lore',
      );
    } catch (e: any) {
      setError(e.message ?? 'Image analysis failed');
    } finally {
      setBusy(null);
    }
  }

  const filteredPool = useMemo(() => {
    const q = poolQ.trim().toLowerCase();
    if (!q) return characters;
    return characters.filter(
      (c) => c.name.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [characters, poolQ]);

  if (booting) return <PageLoader label="Opening character…" />;

  // ---------- HUB ----------
  if (mode === 'hub') {
    return (
      <div className="creator-page">
        <div className="creator-inner">
          <header className="creator-header">
            <div>
              <h1 className="t-display-md">Character Creator</h1>
              <p className="t-caption" style={{ marginTop: 6 }}>
                Import a card, pick someone from your library, or drop / paste a portrait and let AI build the rest.
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={startBlank}>
              Blank character
            </button>
          </header>

          <div
            className="creator-drop-hero"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const dropped = Array.from(e.dataTransfer.files);
              const f = dropped[0];
              if (!f) return;
              if (/\.(png|json)$/i.test(f.name) && !f.type.startsWith('image/')) void importCardFile(f);
              else if (f.type.startsWith('image/') || /\.png$/i.test(f.name)) {
                // Prefer portrait crop; use import if user holds Alt? Always crop for creator flow.
                // If JSON-like name without image/* try import
                if (f.type === 'application/json' || f.name.endsWith('.json')) void importCardFile(f);
                else beginNewFromMedia(dropped);
              }
            }}
          >
            <Upload size={28} />
            <div>
              <div className="t-heading">Drop, paste, or upload a portrait / card</div>
              <p className="t-caption">
                Drag &amp; drop · Ctrl+V / Paste button · file picker · .png/.json cards import · images get 3:4 crop
              </p>
            </div>
            <div className="btn-row">
              <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                Upload
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    // Always a brand-new character — never the one last edited.
                    if (files.length) beginNewFromMedia(files);
                    e.target.value = '';
                  }}
                />
              </label>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void pastePortraitFromClipboard()}>
                <ClipboardPaste size={14} />
                Paste
              </button>
              <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                Import card
                <input
                  ref={cardFileRef}
                  type="file"
                  accept=".png,.json,image/png,application/json"
                  hidden
                  onChange={(e) => e.target.files?.[0] && void importCardFile(e.target.files[0])}
                />
              </label>
            </div>
          </div>

          <section style={{ marginTop: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <h2 className="t-section" style={{ margin: 0 }}>Your library</h2>
              <input
                className="input"
                placeholder="Search…"
                value={poolQ}
                onChange={(e) => setPoolQ(e.target.value)}
                style={{ maxWidth: 220 }}
              />
            </div>
            <div className="creator-pool">
              {filteredPool.map((c) => (
                <div key={c.id} className="creator-pool-card">
                  <button
                    type="button"
                    className="creator-pool-open"
                    onClick={() => {
                      applyCard(c);
                      nav(`/creator/${c.id}`);
                    }}
                  >
                    {c.avatar ? (
                      <img
                        className="creator-pool-img"
                        src={c.avatar}
                        alt=""
                        title="Double-click to open floating portrait"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          useApp.getState().openPortrait({ src: c.avatar, name: c.name });
                        }}
                      />
                    ) : (
                      <span className="creator-pool-fallback" aria-hidden>
                        {c.name.slice(0, 1)}
                      </span>
                    )}
                    <span className="creator-pool-scrim">
                      <span className="creator-pool-name">{c.name}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="creator-pool-delete"
                    title="Permanently delete character"
                    aria-label={`Delete ${c.name}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      const ok = await confirm({
                        title: `Delete “${c.name}”?`,
                        body: 'Removes the card and avatar from disk. This cannot be undone.',
                        confirmLabel: 'Delete character',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await api.deleteCharacter(c.id);
                        await refreshCharacters();
                        void useApp.getState().refreshGroups();
                        if (card.id === c.id) {
                          setMode('hub');
                          setCard({ ...EMPTY });
                          nav('/creator', { replace: true });
                        }
                      } catch (err: any) {
                        setError(err.message ?? 'Delete failed');
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
              {!filteredPool.length && <p className="t-caption">No characters yet — import or create one.</p>}
            </div>
          </section>
        </div>
      </div>
    );
  }

  // ---------- EDIT ----------
  return (
    <div className="creator-page">
      <div className="creator-inner">
        <header className="creator-header">
          <div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={backToHub}>
              ← Library
            </button>
            <h1 className="t-display-md" style={{ marginTop: 8 }}>
              {card.id ? card.name || 'Edit character' : 'New character'}
            </h1>
          </div>
          <div className="btn-row">
            {card.id && (
              <>
                <a className="btn btn-ghost btn-sm" href={`/api/characters/${card.id}/export.json`}>Export JSON</a>
                <a className="btn btn-ghost btn-sm" href={`/api/characters/${card.id}/export.png`}>Export PNG</a>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-danger"
                  disabled={busy === 'save'}
                  onClick={() => void deleteCharacterPermanently()}
                  title="Permanently delete this character card and avatar"
                >
                  Delete permanently
                </button>
              </>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy === 'save' || !card.name?.trim()}
              onClick={() => void saveCard()}
            >
              {busy === 'save' ? <><GlobeLoader size={15} /> Saving…</> : 'Save'}
            </button>
          </div>
        </header>

        {(status || error) && (
          <p className="t-caption" style={{ color: error ? 'var(--danger)' : 'var(--accent)', marginBottom: 12 }}>
            {error || status}
          </p>
        )}

        <div className="creator-grid">
          {/* Portrait column */}
          <div className="creator-portrait-col">
            <div
              className="creator-portrait"
              role="button"
              tabIndex={0}
              title="Drop an image, press Ctrl+V, or use Paste / Upload"
              aria-label="Portrait — drop, paste, or upload an image"
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add('is-dragover');
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                e.currentTarget.classList.remove('is-dragover');
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('is-dragover');
                // Dropping several portraits at once is the natural gesture.
                onImageFile(Array.from(e.dataTransfer.files));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void pastePortraitFromClipboard();
                }
              }}
            >
              {avatarPreview ? (
                <img
                  src={avatarPreview}
                  alt=""
                  draggable={false}
                  title="Double-click to open floating portrait"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    useApp.getState().openPortrait({
                      src: avatarPreview,
                      name: card.name?.trim() || 'Portrait',
                    });
                  }}
                />
              ) : (
                <div className="creator-portrait-empty">
                  <UserRound size={32} />
                  <span className="t-caption">Drop · Ctrl+V · Paste · Upload</span>
                  <span className="t-caption" style={{ opacity: 0.75 }}>3:4 crop after pick</span>
                </div>
              )}
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', flex: 1 }}>
                Upload
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length) onImageFile(files);
                    // Reset so re-picking the same file fires onChange again.
                    e.target.value = '';
                  }}
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ flex: 1 }}
                title="Paste image from clipboard"
                onClick={() => void pastePortraitFromClipboard()}
              >
                <ClipboardPaste size={14} />
                Paste
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ flex: 1 }}
                disabled={!avatarPreview || busy === 'vision'}
                title="Analyze portrait with vision AI"
                onClick={() => setVisionConfirm(true)}
              >
                {busy === 'vision' ? <GlobeLoader size={14} /> : <IconAi size={14} />}
                {busy === 'vision' ? 'Scanning…' : 'Scan'}
              </button>
            </div>
            <PhotoGallery
              photos={card.id
                ? photos.map((p) => ({ id: p.id, url: p.url, label: p.label }))
                : staged.map((p, i) => ({ id: p.id, url: p.url, label: `Staged ${i + 1}` }))}
              activeId={card.id ? activePhotoId : stagedActiveId}
              saved={!!card.id}
              max={maxPhotos}
              onSelect={choosePhoto}
              onRemove={removePhoto}
              onAdd={onImageFile}
            />
            <p className="t-caption" style={{ marginTop: 8 }}>
              All three work: file upload, drag &amp; drop, or clipboard paste (button or Ctrl+V).
              Scan fills physical domains from the image (confirm first), then AI Fill for psyche &amp; lore.
            </p>
          </div>

          {/* Editor column */}
          <div className="creator-fields">
            <div className="creator-ai-panel">
              <label className="field-label">Setting world</label>
              <select
                className="input"
                value={setting}
                onChange={(e) => {
                  const s = e.target.value as SettingKind;
                  setSetting(s);
                  setPack((p) => ({ ...p, setting: s }));
                }}
              >
                {(Object.keys(SETTING_LABELS) as SettingKind[]).map((k) => (
                  <option key={k} value={k}>{SETTING_LABELS[k]}</option>
                ))}
              </select>
              <label className="field-label" style={{ marginTop: 12 }}>Gist — who are they?</label>
              <textarea
                className="textarea"
                rows={3}
                value={gist}
                onChange={(e) => setGist(e.target.value)}
                placeholder="e.g. Cold elven princess who fled a political marriage; soft spot for street musicians…"
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginTop: 10, width: '100%' }}
                disabled={busy === 'gist'}
                onClick={() => void runGistAi()}
              >
                {busy === 'gist' ? <GlobeLoader size={16} /> : <IconAi size={16} />}
                {busy === 'gist'
                  ? 'Generating domains…'
                  : card.description?.trim()
                    ? 'AI Fill again — rebuild from what’s in the fields now'
                    : 'AI Fill — full card from gist'}
              </button>
              <p className="t-caption" style={{ marginTop: 8 }}>
                Builds age 19+, body, psyche, lore/modern blocks as JSON, then ST description fields.
                Portrait-scanned physicals are kept as-is. Press it again any time — it re-reads the
                gist <em>and</em> your edited fields, so changing the description changes the result.
                No scenario: set the scene per-chat in the Author&apos;s Note.
              </p>
            </div>

            <Field label="Name">
              <input
                className="input"
                value={card.name ?? ''}
                onChange={(e) => setCard((c) => ({ ...c, name: e.target.value }))}
                placeholder="Character name"
              />
            </Field>
            <Field label="Description">
              <textarea
                className="textarea"
                rows={5}
                value={card.description ?? ''}
                onChange={(e) => setCard((c) => ({ ...c, description: e.target.value }))}
              />
            </Field>
            <Field label="Personality">
              <textarea
                className="textarea"
                rows={3}
                value={card.personality ?? ''}
                onChange={(e) => setCard((c) => ({ ...c, personality: e.target.value }))}
              />
            </Field>
            {/*
              No Scenario editor: the scene is set per-chat in the Author's Note.
              An imported card that already carries one keeps it (nothing is
              deleted behind the user's back) but it is shown read-only with a
              way out, so it can't quietly fight the note.
            */}
            {card.scenario?.trim() && (
              <div className="creator-legacy-scenario">
                <div className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1 }}>Scenario (imported)</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setCard((c) => ({ ...c, scenario: '' }))}
                  >
                    Clear
                  </button>
                </div>
                <p className="t-caption" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{card.scenario}</p>
                <p className="t-caption" style={{ marginTop: 6, opacity: 0.75 }}>
                  Scenarios now come from each chat&apos;s Author&apos;s Note. This one came in with the card —
                  clear it if it conflicts with how you want to open a scene.
                </p>
              </div>
            )}
            <Field label="First message">
              <textarea
                className="textarea"
                rows={4}
                value={card.first_mes ?? ''}
                onChange={(e) => setCard((c) => ({ ...c, first_mes: e.target.value }))}
              />
            </Field>
            <Field label="Example dialogue">
              <textarea
                className="textarea"
                rows={3}
                value={card.mes_example ?? ''}
                onChange={(e) => setCard((c) => ({ ...c, mes_example: e.target.value }))}
              />
            </Field>
            <Field label="Tags (comma-separated)">
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
            <Field label="System prompt">
              <textarea
                className="textarea"
                rows={2}
                value={card.system_prompt ?? ''}
                onChange={(e) => setCard((c) => ({ ...c, system_prompt: e.target.value }))}
              />
            </Field>
            <Field label="Post-history instructions">
              <textarea
                className="textarea"
                rows={2}
                value={card.post_history_instructions ?? ''}
                onChange={(e) => setCard((c) => ({ ...c, post_history_instructions: e.target.value }))}
              />
            </Field>

            <details className="creator-domains" open>
              <summary className="field-label" style={{ cursor: 'pointer' }}>
                Domain pack (compact JSON)
              </summary>
              <p className="t-caption" style={{ margin: '8px 0' }}>
                Token-efficient structured sheet. Age always ≥ 19. Edit carefully or regenerate with AI.
              </p>
              <textarea
                className="textarea"
                rows={14}
                spellCheck={false}
                value={JSON.stringify({ ...pack, setting }, null, 2)}
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value) as CharacterCreatorPack;
                    if (parsed.physical) parsed.physical.age = Math.max(19, Number(parsed.physical.age) || 19);
                    setPack(parsed);
                    if (parsed.setting) setSetting(parsed.setting);
                  } catch {
                    /* allow mid-edit invalid JSON */
                  }
                }}
              />
            </details>
          </div>
        </div>
      </div>

      {/* Crop modal — full WYSIWYG editor (drag + zoom + edge-clamped pan) */}
      {pendingCrop && (
        <PortraitCropEditor
          file={pendingCrop.file}
          imageUrl={pendingCrop.url}
          onCancel={() => {
            // Cancelling one image of a batch skips to the next rather than
            // discarding everything that was just selected.
            nextInQueue();
          }}
          onApply={applyCroppedPortrait}
          title="Edit portrait"
          applyLabel="Apply portrait"
        />
      )}

      {/* Vision confirm */}
      {visionConfirm && (
        <div className="creator-modal-backdrop" role="dialog" aria-label="Confirm image analysis">
          <div className="creator-modal creator-modal-sm">
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <AlertTriangle size={22} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <div>
                <h2 className="t-heading">Analyze portrait?</h2>
                {localVision === null && (
                  <p className="t-caption" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <GlobeLoader size={14} /> Checking for an on-device vision model…
                  </p>
                )}
                {localVision?.available && (
                  <p className="t-caption" style={{ marginTop: 8 }}>
                    The portrait is described <strong>on this machine</strong> by{' '}
                    {localVision.label ?? localVision.model}, running inside Reverie. The image
                    never leaves your computer — only the extracted text (body, face, hair, eyes,
                    clothing) is kept, and only that text is ever sent to a cloud model later. No
                    API tokens are used for this step.
                    {localVision.engineReady && localVision.weightsReady
                      ? ' Expect a few seconds once the model is loaded; the first scan after '
                        + 'startup also loads it into memory.'
                      : ` First run downloads the engine and model (~${localVision.approxDownloadMb} MB) `
                        + 'into the Reverie folder. That happens once; after it, scanning works offline.'}
                  </p>
                )}
                {localVision && !localVision.available && (
                  <p className="t-caption" style={{ marginTop: 8 }}>
                    {localVision.error ?? 'On-device scanning is unavailable.'}
                    {localVision.strict && ' Strict local mode is on, so the scan will stop rather '
                      + 'than upload your portrait.'}
                  </p>
                )}
                {localVision && !localVision.available && !localVision.strict && (
                  <p className="t-caption" style={{ marginTop: 8 }}>
                    <strong>No on-device model is available, and strict local mode is off.</strong>{' '}
                    The image itself will be uploaded to your cloud vision model and will use API
                    tokens. Turn strict mode back on if you would rather it never leave this machine.
                  </p>
                )}
              </div>
            </div>
            <div className="btn-row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setVisionConfirm(false)}>
                <X size={16} /> Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!!localVision && !localVision.available && localVision.strict}
                onClick={() => void runVisionAi()}
              >
                {busy === 'vision' ? <GlobeLoader size={16} /> : <IconAi size={16} />}{' '}
                {busy === 'vision'
                  ? 'Scanning…'
                  : localVision?.available ? 'Scan on this device' : 'Yes, analyze'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="field-label">{label}</span>
      {children}
    </label>
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

/** Prefer clipboard image files; screenshots often only appear on items, not files. */
function imageFileFromClipboard(data: DataTransfer | null | undefined): File | null {
  if (!data) return null;
  const fromList = Array.from(data.files ?? []).find((f) => f.type.startsWith('image/'));
  if (fromList) return fromList;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

// re-export old name for any imports
export { CharacterCreator as CharacterStudio };

/**
 * Portrait gallery — up to ten photos, one of which is the profile picture.
 *
 * Works identically before and after the first save: an unsaved character shows
 * its staged crops here (uploaded on save), so nobody has to save a card just to
 * attach a second photo. The selected photo is ringed and badged rather than
 * merely tinted, because "which of these is the actual profile picture" is the
 * only question this exists to answer.
 */
function PhotoGallery({
  photos, activeId, saved, max, onSelect, onRemove, onAdd,
}: {
  photos: { id: string; url: string; label?: string }[];
  activeId?: string;
  /** False while the photos are staged in memory rather than on disk. */
  saved: boolean;
  /** The cap the *server* enforces, so the strip can never promise a slot it lacks. */
  max: number;
  onSelect: (photoId: string) => void;
  onRemove: (photoId: string) => void;
  onAdd: (files: File[]) => void;
}) {
  const active = activeId ?? photos[0]?.id;
  const full = photos.length >= max;

  return (
    <div className="photo-gallery">
      <div className="photo-gallery-head">
        <span className="field-label" style={{ margin: 0 }}>Photos</span>
        <span className="t-caption">{photos.length} / {max}</span>
      </div>

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
              {p.id !== active && <span className="photo-thumb-action">Use as profile</span>}
            </button>
            {p.id === active && <span className="photo-thumb-badge">Profile</span>}
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
          <label className="photo-thumb photo-thumb-add" title="Add photos (you can pick several)">
            <span>+</span>
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) onAdd(files);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>

      <p className="t-caption photo-gallery-hint">
        {photos.length === 0
          ? `No photos yet — use + to add several at once (max ${max}).`
          : full
            ? 'Gallery full — delete one to add another.'
            : 'Click a photo to make it the profile picture. × deletes it.'}
        {!saved && photos.length > 0 && ' They upload when you save.'}
      </p>
    </div>
  );
}
