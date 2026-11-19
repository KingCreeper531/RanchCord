import { useEffect, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { ui, useUi } from '../store/ui';
import { ScreenShareModal } from './calls/ScreenShareModal';
import { SoundUploadModal, SoundboardModal } from './calls/Soundboard';
import {
  ConfirmModal,
  CustomStatusModal,
  DownloadsModal,
  EmojiUploadModal,
  LightboxModal,
  MessageActionsModal,
  NewDmModal,
  SwitcherModal,
} from './modals/BasicModals';
import { AddGroupModal, CreateChannelModal, EditChannelModal, GroupSettingsModal, InviteModal, TopicModal } from './modals/GroupModals';
import { BanModal, CategoryModal } from './modals/GroupAdmin';
import { ImageCropModal } from './modals/ImageCrop';
import { SettingsModal } from './settings/Settings';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY: Record<string, ComponentType<any>> = {
  confirm: ConfirmModal,
  customStatus: CustomStatusModal,
  newDm: NewDmModal,
  switcher: SwitcherModal,
  lightbox: LightboxModal,
  emojiUpload: EmojiUploadModal,
  downloads: DownloadsModal,
  messageActions: MessageActionsModal,
  addGroup: AddGroupModal,
  invite: InviteModal,
  groupSettings: GroupSettingsModal,
  category: CategoryModal,
  ban: BanModal,
  createChannel: CreateChannelModal,
  editChannel: EditChannelModal,
  topic: TopicModal,
  crop: ImageCropModal,
  settings: SettingsModal,
  soundboard: SoundboardModal,
  soundUpload: SoundUploadModal,
  screenShare: ScreenShareModal,
};

const FULLSCREEN = new Set(['settings', 'lightbox']);
const TOP = new Set(['switcher']);

/** One modal layer. While it animates out it stops catching clicks, so the app underneath responds right away. */
function ModalLayer({ full, top, onClose, children }: { full: boolean; top: boolean; onClose: () => void; children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      className={`ui-modal-layer${full ? ' is-fullscreen' : ''}${top ? ' is-top' : ''}`}
      style={{ pointerEvents: present ? 'auto' : 'none' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: 0.16 }}
    >
      {!full && <div className="ui-modal-scrim" onClick={onClose} />}
      <motion.div
        className="ui-modal-motion"
        initial={full ? { opacity: 0, scale: 1.02 } : { opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={full ? { opacity: 0, scale: 1.02 } : { opacity: 0, scale: 0.97, y: 6 }}
        transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.8 }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

export function ModalHost() {
  const modals = useUi((s) => s.modals);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const top = useUi.getState().modals.at(-1);
      if (!top || top.type === 'settings') return;
      e.stopPropagation();
      ui.closeModal(top.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <AnimatePresence>
      {modals.map((m) => {
        const Component = REGISTRY[m.type];
        if (!Component) return null;
        const close = () => ui.closeModal(m.id);
        const full = FULLSCREEN.has(m.type);
        return (
          <ModalLayer key={m.id} full={full} top={TOP.has(m.type)} onClose={close}>
            <Component {...m.props} onClose={close} />
          </ModalLayer>
        );
      })}
    </AnimatePresence>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return createPortal(
    <div className="ui-toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`ui-toast ui-toast-${t.tone}`}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96, transition: { duration: 0.14 } }}
            transition={{ type: 'spring', stiffness: 500, damping: 34 }}
          >
            {t.tone === 'success' && <CheckCircle size={18} weight="fill" />}
            {t.tone === 'error' && <WarningCircle size={18} weight="fill" />}
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
