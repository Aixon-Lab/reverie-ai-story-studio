/** Shared Lucide icons at consistent, usable sizes (not micro glyphs). */
import { useId, type SVGProps } from 'react';
import { GLOBE_DOTS_COMPACT, GLOBE_R_COMPACT, GLOBE_VB, globeHemisphere } from './globeMark';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Home,
  Pencil,
  Plus,
  Settings2,
  SlidersHorizontal,
  TextQuote,
  Trash2,
  User,
  Users,
  Video,
  X,
} from 'lucide-react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number };

const defaults = { size: 20, strokeWidth: 1.75 } as const;

function wrap(Icon: typeof Home) {
  return function Wrapped({ size = defaults.size, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
    return <Icon size={size} strokeWidth={strokeWidth} aria-hidden {...rest} />;
  };
}

/** Dot-matrix globe — the AI mark. Same sphere as the loader; accent → yellow. */
export function IconAi({ size = defaults.size, ...rest }: IconProps) {
  const rawId = useId().replace(/:/g, '');
  const fillId = `aiGlobeFill-${rawId}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${GLOBE_VB} ${GLOBE_VB}`}
      fill="none"
      aria-hidden
      className="icon-ai"
      {...rest}
    >
      <defs>
        <linearGradient id={fillId} x1="5" y1="27" x2="27" y2="5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#d8ff3e" />
          <stop offset="100%" stopColor="#ffe84a" />
        </linearGradient>
      </defs>
      {GLOBE_DOTS_COMPACT.map((d) => (
        <circle
          key={`${d.col}-${d.row}`}
          cx={d.x}
          cy={d.y}
          r={GLOBE_R_COMPACT}
          fill={`url(#${fillId})`}
          opacity={globeHemisphere(d.col, d.row, 5)}
        />
      ))}
    </svg>
  );
}

export const IconHome = wrap(Home);
export const IconApi = wrap(Cpu);
export const IconPreset = wrap(SlidersHorizontal);
export const IconFormat = wrap(TextQuote);
export const IconWorld = wrap(BookOpen);
export const IconPersona = wrap(User);
export const IconCast = wrap(Users);
export const IconEdit = wrap(Pencil);
export const IconDelete = wrap(Trash2);
export const IconClose = wrap(X);
export const IconPlus = wrap(Plus);
export const IconPrev = wrap(ChevronLeft);
export const IconNext = wrap(ChevronRight);
export const IconSettings = wrap(Settings2);
export const IconArrowLeft = wrap(ArrowLeft);
export const IconArrowRight = wrap(ArrowRight);
export const IconDirection = wrap(Video);
