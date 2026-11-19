import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Hash, UserPlus } from '@phosphor-icons/react';
import { ackChannel, blockUser, loadLatest, loadOlder, openDm, removeRelationship, sendFriendRequest } from '../../lib/actions';
import { formatDate, sameDay } from '../../lib/format';
import { attachMessageGestures } from '../../lib/messageGestures';
import { dmRecipient, emptyMessages, isUnread, useData } from '../../store/data';
import { PERM, can } from '../../lib/perms';
import { ui, useUi } from '../../store/ui';
import { REL } from '../../types';
import { Avatar, Button, Spinner } from '../ui';
import { MessageItem } from './MessageItem';

const GROUP_WINDOW = 7 * 60 * 1000;

function ChannelStart({ channelId }: { channelId: string }) {
  const channel = useData((s) => s.channels[channelId]);
  const recipient = useData((s) => dmRecipient(s, channelId));
  const rel = useData((s) => (recipient ? s.relationships[recipient.id]?.type : undefined));
  if (!channel) return null;
  if (channel.type === 'dm' && recipient) {
    return (
      <div className="chat-start">
        <Avatar user={recipient} size={80} />
        <h1>{recipient.displayName}</h1>
        <div className="chat-start-handle">{recipient.username}</div>
        <p>
          This is the beginning of your direct message history with <strong>{recipient.displayName}</strong>.
        </p>
        <div className="chat-start-actions">
          {rel === REL.FRIEND && (
            <Button size="sm" variant="secondary" onClick={() => void removeRelationship(recipient.id)}>
              Remove friend
            </Button>
          )}
          {rel === undefined && (
            <Button size="sm" onClick={() => void sendFriendRequest(recipient.username).catch((e) => ui.toast(e.message, 'error'))}>
              Add friend
            </Button>
          )}
          {rel === REL.OUTGOING && (
            <Button size="sm" variant="secondary" disabled>
              Friend request sent
            </Button>
          )}
          {rel !== REL.BLOCKED && (
            <Button size="sm" variant="secondary" onClick={() => void blockUser(recipient.id)}>
              Block
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="chat-start">
      <div className="chat-start-hash">
        <Hash size={42} weight="bold" />
      </div>
      <h1>Welcome to #{channel.name}!</h1>
      <p>This is the start of the #{channel.name} channel.{channel.topic ? ` ${channel.topic}` : ''}</p>
      {channel.groupId && (
        <div className="chat-start-actions">
          <Button size="sm" variant="secondary" icon={<UserPlus size={16} weight="bold" />} onClick={() => ui.openModal('invite', { groupId: channel.groupId })}>
            Invite friends
          </Button>
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="chat-skeleton" aria-hidden>
      {[0.62, 0.38, 0.8, 0.5, 0.7, 0.3].map((w, i) => (
        <div key={i} className="chat-skeleton-row">
          <span className="ui-skeleton chat-skeleton-avatar" />
          <div className="chat-skeleton-lines">
            <span className="ui-skeleton" style={{ width: 120, height: 12 }} />
            <span className="ui-skeleton" style={{ width: `${w * 100}%`, height: 14 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function MessageList({ channelId }: { channelId: string }) {
  const cm = useData((s) => s.messages[channelId] ?? emptyMessages);
  const meId = useData((s) => s.me!.id);
  const groupId = useData((s) => s.channels[channelId]?.groupId ?? null);
  const canManage = useData((s) => can(s, groupId, PERM.MANAGE_MESSAGES));
  const jumpTo = useUi((s) => s.jumpTo);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevFirst = useRef<string | null>(null);
  const prevHeight = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [newSince, setNewSince] = useState<string | null>(null);
  const perms = useRef({ meId, canManage });
  perms.current = { meId, canManage };

  // Touch screens: swipe a message right to reply; on iPhones, hold it for its menu.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !('ontouchstart' in window)) return;
    return attachMessageGestures(el, {
      channelId,
      onHold: (messageId) => {
        const m = useData.getState().messages[channelId]?.list.find((x) => x.id === messageId);
        if (!m) return;
        const { meId: me, canManage: manage } = perms.current;
        const mine = m.author.id === me;
        const canEdit = mine && !m.pending && !m.failed && Boolean(m.content || m.attachments.length);
        const canDelete = !m.pending && (mine || manage);
        ui.openModal('messageActions', { channelId, messageId, canEdit, canDelete });
      },
    });
  }, [channelId]);

  // Remember where the "new messages" line goes when the channel opens.
  useEffect(() => {
    const s = useData.getState();
    setNewSince(isUnread(s, channelId) ? s.readStates[channelId]?.lastReadId ?? '0' : null);
    atBottom.current = true;
    prevFirst.current = null;
    setShowJump(false);
  }, [channelId]);

  useEffect(() => {
    if (!cm.loaded || cm.stale) void loadLatest(channelId);
  }, [channelId, cm.loaded, cm.stale]);

  // Keep the view anchored: stick to the bottom for new messages, keep position when older ones load above.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = cm.list[0]?.id ?? null;
    if (prevFirst.current && first && first < prevFirst.current && !atBottom.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [cm.list, channelId]);

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      prevHeight.current = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [channelId]);

  // Mark as read while looking at the bottom of the channel.
  const lastId = useData((s) => s.channels[channelId]?.lastMessageId);
  const visible = useUi((s) => s.visible && s.focused);
  useEffect(() => {
    if (atBottom.current && visible && cm.loaded && lastId) ackChannel(channelId, lastId);
  }, [channelId, lastId, visible, cm.loaded]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottom.current = bottom;
    setShowJump(!bottom && el.scrollHeight - el.scrollTop - el.clientHeight > 600);
    if (el.scrollTop < 600) {
      const c = useData.getState().messages[channelId];
      if (c?.hasMore && !c.loading && c.loaded) void loadOlder(channelId);
    }
    if (bottom) {
      const s = useData.getState();
      const id = s.channels[channelId]?.lastMessageId;
      if (id && isUnread(s, channelId)) ackChannel(channelId, id);
    }
  }, [channelId]);

  // Jump to a message (from a reply), loading older history if needed.
  useEffect(() => {
    if (!jumpTo || jumpTo.channelId !== channelId) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 25 && !cancelled; i++) {
        const box = scroller.current;
        const el = box?.querySelector<HTMLElement>(`[data-mid="${jumpTo.messageId}"]`);
        if (box && el) {
          atBottom.current = false;
          // Scroll only the message list. scrollIntoView would also nudge the panels around it.
          const offset = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
          box.scrollTo({ top: box.scrollTop + offset - (box.clientHeight - el.offsetHeight) / 2, behavior: 'smooth' });
          setHighlight(jumpTo.messageId);
          setTimeout(() => !cancelled && setHighlight(null), 1800);
          return;
        }
        const c = useData.getState().messages[channelId];
        if (!c?.hasMore) break;
        atBottom.current = false;
        await loadOlder(channelId);
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!cancelled) ui.toast("Couldn't find that message", 'error');
    })();
    return () => {
      cancelled = true;
    };
  }, [jumpTo, channelId]);

  const jumpToPresent = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const list = cm.list;
  let newLineDrawn = false;

  return (
    <div className="chat-messages-wrap">
      <div ref={scroller} className="chat-scroller scroll" onScroll={onScroll}>
        <div ref={content} className="chat-content">
          {cm.loaded && !cm.hasMore && <ChannelStart channelId={channelId} />}
          {cm.loaded && cm.hasMore && (
            <div className="chat-loading-more">{cm.loading ? <Spinner /> : <span className="chat-load-hint">Scroll up for older messages</span>}</div>
          )}
          {!cm.loaded && !cm.error && <Skeleton />}
          {cm.error && !cm.loaded && (
            <div className="chat-error">
              <p>{cm.error}</p>
              <Button size="sm" variant="secondary" onClick={() => void loadLatest(channelId)}>
                Try again
              </Button>
            </div>
          )}
          {list.map((m, i) => {
            const prev = list[i - 1];
            const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
            const continued =
              !newDay &&
              !!prev &&
              prev.author.id === m.author.id &&
              prev.type === 'default' &&
              m.type === 'default' &&
              m.createdAt - prev.createdAt < GROUP_WINDOW &&
              !prev.failed;
            const showNew = !newLineDrawn && newSince !== null && !m.pending && m.id > newSince && m.author.id !== meId;
            if (showNew) newLineDrawn = true;
            return (
              <Fragment key={m.nonce ?? m.id}>
                {newDay && (
                  <div className={`chat-divider${showNew ? ' is-new' : ''}`}>
                    <span>{formatDate(m.createdAt)}</span>
                    {showNew && <em>NEW</em>}
                  </div>
                )}
                {showNew && !newDay && (
                  <div className="chat-divider is-new is-bare">
                    <em>NEW</em>
                  </div>
                )}
                <MessageItem
                  message={m}
                  continued={continued && !showNew}
                  groupId={groupId}
                  meId={meId}
                  canManage={canManage}
                  highlighted={highlight === m.id}
                />
              </Fragment>
            );
          })}
          <div className="chat-bottom-spacer" />
        </div>
      </div>
      {showJump && (
        <button className="chat-jump" onClick={jumpToPresent}>
          You're viewing older messages
          <span>
            Jump to present <ArrowDown size={14} weight="bold" />
          </span>
        </button>
      )}
    </div>
  );
}

export { openDm };
