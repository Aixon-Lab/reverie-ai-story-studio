/** Reverie brand mark: standalone globe, or globe + wordmark. */
import { Link } from 'react-router-dom';

export function BrandLogo({
  size = 'md',
  to = '/',
  showWord = true,
}: {
  size?: 'sm' | 'md' | 'lg';
  to?: string | null;
  showWord?: boolean;
}) {
  const inner = (
    <span className={`brand-logo brand-logo-${size}`}>
      {showWord ? (
        <img
          className="brand-logo-wordmark"
          src="/logo-wordmark.png?v=2"
          alt="Reverie"
          draggable={false}
        />
      ) : (
        <img
          className="brand-logo-mark"
          src="/logo-standalone.png"
          alt="Reverie"
          draggable={false}
        />
      )}
    </span>
  );

  if (to === null) return inner;
  return (
    <Link to={to} className="brand-logo-link" title="Reverie — Home">
      {inner}
    </Link>
  );
}
