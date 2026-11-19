import { AnimatePresence, motion } from 'motion/react';
import { Phone, PhoneX, VideoCamera } from '@phosphor-icons/react';
import { call } from '../../calls/manager';
import { useCall } from '../../store/call';
import { useData } from '../../store/data';
import { ui } from '../../store/ui';
import { Avatar, Tooltip } from '../ui';

export function IncomingCall() {
  const current = useCall((s) => s.channelId);
  const ringingId = useData((s) => Object.keys(s.rings).find((cid) => cid !== current) ?? null);
  const callerId = useData((s) => (ringingId ? s.rings[ringingId] : null));
  const caller = useData((s) => (callerId ? s.users[callerId] : undefined));
  const entry = ringingId && callerId ? ([ringingId, callerId] as const) : null;
  return (
    <AnimatePresence>
      {entry && (
        <motion.div
          key={entry[0]}
          className="incoming"
          role="alertdialog"
          aria-label="Incoming call"
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        >
          <div className="incoming-avatar">
            <span className="incoming-ring" />
            <span className="incoming-ring incoming-ring-2" />
            <Avatar user={caller} size={84} />
          </div>
          <div className="incoming-name truncate">{caller?.displayName ?? 'Someone'}</div>
          <div className="incoming-sub">Incoming call…</div>
          <div className="incoming-actions">
            <Tooltip label="Decline">
              <button className="incoming-btn is-decline" onClick={() => call.decline(entry[0])} aria-label="Decline">
                <PhoneX size={26} weight="fill" />
              </button>
            </Tooltip>
            <Tooltip label="Accept with video">
              <button
                className="incoming-btn is-video"
                onClick={() => {
                  ui.navigate({ kind: 'dm', channelId: entry[0] });
                  void call.join(entry[0], { video: true });
                }}
                aria-label="Accept with video"
              >
                <VideoCamera size={24} weight="fill" />
              </button>
            </Tooltip>
            <Tooltip label="Accept">
              <button
                className="incoming-btn is-accept"
                onClick={() => {
                  ui.navigate({ kind: 'dm', channelId: entry[0] });
                  void call.join(entry[0]);
                }}
                aria-label="Accept"
              >
                <Phone size={26} weight="fill" />
              </button>
            </Tooltip>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
