import { useState } from 'react';
import { useApp } from '../store';

type AvatarShape = 'square' | 'portrait';

/** Normalize avatar URLs so /api/avatars/id.png?v=… always resolves. */
export function resolveAvatarUrl(src?: string | null, characterId?: string): string | undefined {
  if (src && src.trim()) {
    // Ensure relative API paths work
    if (src.startsWith('/api/')) return src;
    if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:')) {
      return src;
    }
    if (src.includes('avatars/')) return src.startsWith('/') ? src : `/${src}`;
  }
  if (characterId) return `/api/avatars/${characterId}.png`;
  return undefined;
}

/** Avatar. `square` for rails/header; `portrait` (3:4) for chat message rows.
 *  Double-click opens a floating portrait (multiple allowed, same z-level).
 *  When interactive=false, renders a non-button element so parents can be clickable
 *  (never nest <button> inside <button>). */
export function Avatar({
  src,
  name,
  size = 40,
  shape = 'square',
  interactive = true,
  className = '',
  characterId,
}: {
  src?: string;
  name: string;
  size?: number;
  /** square = 1:1 (sidebar/header); portrait = 3:4 (chat) */
  shape?: AvatarShape;
  interactive?: boolean;
  className?: string;
  /** Fallback file lookup if src missing / 404 */
  characterId?: string;
}) {
  const openPortrait = useApp((s) => s.openPortrait);
  const [broken, setBroken] = useState(false);
  const resolved = resolveAvatarUrl(src, characterId);
  const showImg = !!resolved && !broken;
  const initials = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const w = size;
  const h = shape === 'portrait' ? Math.round(size * (4 / 3)) : size;
  const radius = shape === 'portrait'
    ? Math.max(8, Math.round(size * 0.18))
    : Math.max(8, Math.round(size * 0.22));

  const cls = `avatar avatar-${shape}${interactive ? ' avatar-clickable' : ''}${className ? ` ${className}` : ''}`;
  const style = { width: w, height: h, fontSize: size * 0.32, borderRadius: radius };
  const body = showImg ? (
    <img
      src={resolved}
      alt=""
      draggable={false}
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      onError={() => setBroken(true)}
    />
  ) : (
    initials || '?'
  );

  const openFloat = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    openPortrait({ src: showImg ? resolved : undefined, name });
  };

  if (!interactive) {
    return (
      <span
        className={cls}
        style={style}
        title={name}
        aria-hidden={false}
        role="img"
        aria-label={name}
        onDoubleClick={openFloat}
      >
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={cls}
      style={style}
      title={`Double-click to view ${name}`}
      aria-label={`View ${name} portrait`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={openFloat}
    >
      {body}
    </button>
  );
}
