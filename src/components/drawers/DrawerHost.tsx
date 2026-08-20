/** Shared slide-over drawer — smooth enter/exit; chat stays mounted underneath. */
import { useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { DrawerId } from '@shared/types';
import { useApp } from '../../store';
import { ApiDrawer } from './ApiDrawer';
import { PresetDrawer } from './PresetDrawer';
import { FormattingDrawer } from './FormattingDrawer';
import { WorldInfoDrawer } from './WorldInfoDrawer';
import { PersonaDrawer } from './PersonaDrawer';
import { CharactersDrawer } from './CharactersDrawer';
import { ComposerDrawer } from './ComposerDrawer';
import { RegexDrawer } from './RegexDrawer';
import { QuickReplyDrawer } from './QuickReplyDrawer';
import { AppearanceDrawer } from './AppearanceDrawer';
import { SecurityDrawer } from './SecurityDrawer';
import { BrainDrawer } from './BrainDrawer';
import { TerminalDrawer } from './TerminalDrawer';
import { SkillsDrawer } from './SkillsDrawer';

const ease = [0.22, 1, 0.36, 1] as const;

export function DrawerHost({ children }: { children: ReactNode }) {
  const { openDrawer, setDrawer } = useApp();

  useEffect(() => {
    if (!openDrawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(null); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [openDrawer, setDrawer]);

  const wide = openDrawer === 'presetComposer';

  return (
    <>
      {children}
      <AnimatePresence>
        {openDrawer && (
          <div className="drawer-root" key="drawer-root">
            <motion.div
              className="drawer-backdrop"
              role="presentation"
              onClick={() => setDrawer(null)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease }}
            />
            <motion.aside
              className={`drawer-panel ${wide ? 'drawer-wide' : ''}`}
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.32, ease }}
            >
              <DrawerBody id={openDrawer} onClose={() => setDrawer(null)} />
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

function DrawerBody({ id, onClose }: { id: NonNullable<DrawerId>; onClose: () => void }) {
  if (id === 'api') return <ApiDrawer onClose={onClose} />;
  if (id === 'preset') return <PresetDrawer onClose={onClose} />;
  if (id === 'formatting') return <FormattingDrawer onClose={onClose} />;
  if (id === 'worldinfo') return <WorldInfoDrawer onClose={onClose} />;
  if (id === 'persona') return <PersonaDrawer onClose={onClose} />;
  if (id === 'characters') return <CharactersDrawer onClose={onClose} />;
  if (id === 'presetComposer') return <ComposerDrawer onClose={onClose} />;
  if (id === 'regex') return <RegexDrawer onClose={onClose} />;
  if (id === 'quickreply') return <QuickReplyDrawer onClose={onClose} />;
  if (id === 'appearance') return <AppearanceDrawer onClose={onClose} />;
  if (id === 'security') return <SecurityDrawer onClose={onClose} />;
  if (id === 'brain') return <BrainDrawer onClose={onClose} />;
  if (id === 'skills') return <SkillsDrawer onClose={onClose} />;
  if (id === 'terminal') return <TerminalDrawer onClose={onClose} />;
  return null;
}

export function DrawerHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="drawer-header">
      <h2 className="t-heading">{title}</h2>
      <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">×</button>
    </div>
  );
}
