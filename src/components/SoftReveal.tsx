/** Smooth height/opacity open-close for UI that would otherwise jump the layout.
 *  Overflow is clipped only while animating so nested scroll panels (draft previews)
 *  remain scrollable once open. */
import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const EASE = [0.22, 1, 0.36, 1] as const;

export function SoftReveal({
  show,
  children,
  className = '',
  /** Extra bottom gap when open (animated with height) */
  gap = 0,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
  gap?: number;
}) {
  const [clip, setClip] = useState(true);

  useEffect(() => {
    if (!show) setClip(true);
  }, [show]);

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className={`soft-reveal${className ? ` ${className}` : ''}`}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{
            height: { duration: 0.32, ease: EASE },
            opacity: { duration: 0.22, ease: 'easeOut' },
          }}
          onAnimationStart={() => setClip(true)}
          onAnimationComplete={() => {
            // After open, allow nested overflow:auto (draft frames, etc.)
            if (show) setClip(false);
          }}
          style={{ overflow: clip ? 'hidden' : 'visible' }}
        >
          <div className="soft-reveal-inner" style={gap ? { paddingBottom: gap } : undefined}>
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
