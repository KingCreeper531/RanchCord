import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { toggleReaction } from '../../lib/actions';
import { isMobileDevice } from '../../lib/platform';
import { placeFloating } from '../ui';
import { EmojiPicker } from './EmojiPicker';

interface State {
  open: { rect: DOMRect; channelId: string; messageId: string } | null;
}
const useReactionPicker = create<State>(() => ({ open: null }));

export function openReactionPicker(rect: DOMRect, channelId: string, messageId: string) {
  useReactionPicker.setState({ open: { rect, channelId, messageId } });
}

export function closeReactionPicker() {
  useReactionPicker.setState({ open: null });
}

export function ReactionPickerHost() {
  const open = useReactionPicker((s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current || isMobileDevice) return setPos(null);
    const el = ref.current;
    const p = placeFloating(open.rect, { width: el.offsetWidth, height: el.offsetHeight }, 'left', 8, 'start');
    setPos({ left: p.left, top: p.top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeReactionPicker();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeReactionPicker();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <>
      {isMobileDevice && <div className="xp-backdrop" />}
      <div
        ref={ref}
        className={`reaction-picker${isMobileDevice ? ' is-sheet' : ''}`}
        style={isMobileDevice ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      >
        <EmojiPicker
          onPick={(p) => {
            const key = p.kind === 'custom' ? `c:${p.emoji.id}` : p.char;
            void toggleReaction(open.channelId, open.messageId, key);
            closeReactionPicker();
          }}
        />
      </div>
    </>,
    document.body,
  );
}
