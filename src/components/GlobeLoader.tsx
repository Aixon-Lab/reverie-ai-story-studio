/** Dot-matrix globe loader — longitude flux across a sphere of dots. */
import type { SVGProps } from 'react';
import {
  GLOBE_DOTS_COMPACT,
  GLOBE_DOTS_FULL,
  GLOBE_R_COMPACT,
  GLOBE_R_FULL,
  GLOBE_VB,
} from './globeMark';

type GlobeLoaderProps = SVGProps<SVGSVGElement> & {
  size?: number;
  /** Visible caption sits beside the mark in a flex row; omit for icon-only. */
  label?: string;
  title?: string;
};

export function GlobeLoader({
  size = 22,
  label,
  title,
  className,
  ...rest
}: GlobeLoaderProps) {
  const full = size >= 28;
  const dots = full ? GLOBE_DOTS_FULL : GLOBE_DOTS_COMPACT;
  const r = full ? GLOBE_R_FULL : GLOBE_R_COMPACT;
  const mark = (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${GLOBE_VB} ${GLOBE_VB}`}
      fill="none"
      className={['globe-loader', className].filter(Boolean).join(' ')}
      role={label ? undefined : 'status'}
      aria-label={label ? undefined : (title ?? 'Loading')}
      aria-hidden={label ? true : undefined}
      {...rest}
    >
      {dots.map((d) => (
        <circle
          key={`${d.col}-${d.row}`}
          className="globe-loader-dot"
          cx={d.x}
          cy={d.y}
          r={r}
          style={{ ['--col' as string]: d.col, ['--row' as string]: d.row }}
        />
      ))}
    </svg>
  );

  if (!label) return mark;
  return (
    <span className="globe-loader-inline" role="status" aria-label={title ?? label}>
      {mark}
      <span>{label}</span>
    </span>
  );
}

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="page-loader" role="status" aria-live="polite">
      <GlobeLoader size={52} />
      <p className="t-caption">{label}</p>
    </div>
  );
}
