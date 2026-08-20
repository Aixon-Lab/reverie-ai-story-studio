/** Wide drawer embedding the Preset Composer so chat never unmounts. */
import { PresetComposer } from '../../pages/PresetComposer';
import { DrawerHeader } from './DrawerHost';

export function ComposerDrawer({ onClose }: { onClose: () => void }) {
  return (
    <>
      <DrawerHeader title="Preset Composer" onClose={onClose} />
      <div className="drawer-body drawer-body-flush">
        <PresetComposer />
      </div>
    </>
  );
}
