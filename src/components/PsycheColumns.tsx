import { Children, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Stable column assignment: each section follows the one above in its column. */
export function PsycheColumns({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(1);
  const cards = Children.toArray(children);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setCount(Math.max(1, Math.min(3, Math.floor((element.clientWidth + 12) / 332))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={root} className="mind-psyche-columns" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
    {Array.from({ length: count }, (_, column) => <div className="mind-psyche-column" key={column}>
      {cards.filter((_, index) => index % count === column)}
    </div>)}
  </div>;
}
