import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CloudArrowUp, Hash, List, Phone, UserPlus, Users, VideoCamera, UserCircle } from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { call } from '../../calls/manager';
import { sendMessage } from '../../lib/actions';
import { isMobileDevice } from '../../lib/platform';
import { EmojiText } from '../../lib/twemoji';
import { useCall } from '../../store/call';
import { dmRecipient, displayNameIn, useData } from '../../store/data';
import { ui, useUi } from '../../store/ui';
import type { KlipyEmbed } from '../../types';
import { CallStage } from '../calls/CallStage';
import { ExpressionPicker } from '../pickers/ExpressionPicker';
import { Avatar, Button, IconButton, presenceLabel } from '../ui';
import { Composer, type ComposerHandle } from './Composer';
import { MessageList } from './MessageList';

function TypingIndicator({ channelId }: { channelId: string }) {
  const groupId = useData((s) => s.channels[channelId]?.groupId ?? null);
  const names = useData(
    useShallow((s) =>
      Object.keys(s.typing[channelId] ?? {})
        .filter((id) => id !== s.me?.id)
        .map((id) => displayNameIn(s, id, groupId)),
    ),
  );
  let text: React.ReactNode = null;
  if (names.length === 1) text = <><strong>{names[0]}</strong> is typing…</>;
  else if (names.length === 2) text = <><strong>{names[0]}</strong> and <strong>{names[1]}</strong> are typing…</>;
  else if (names.length === 3) text = <><strong>{names[0]}</strong>, <strong>{names[1]}</strong> and <strong>{names[2]}</strong> are typing…</>;
  else if (names.length > 3) text = 'Several people are typing…';
  return (
    <div className="typing" aria-live="polite">
      {text && (
        <>
          <span className="typing-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="truncate">{text}</span>
        </>
      )}
    </div>
  );
}

export function MobileMenuButton() {
  if (!isMobileDevice && window.innerWidth > 760) return null;
  return (
    <IconButton label="Open menu" className="chat-header-menu" onClick={() => ui.setMobilePane('nav')}>
      <List size={22} />
    </IconButton>
  );
}

function ChatHeader({ channelId }: { channelId: string }) {
  const channel = useData((s) => s.channels[channelId]);
  const recipient = useData((s) => dmRecipient(s, channelId));
  const presence = useData((s) => (recipient ? s.presences[recipient.id] ?? 'offline' : 'offline'));
  const membersOpen = useUi((s) => s.prefs.membersOpen);
  const inCallHere = useCall((s) => s.channelId === channelId);
  if (!channel) return null;
  const isDm = channel.type === 'dm';
  return (
    <header className="chat-header">
      <MobileMenuButton />
      {isDm ? (
        <button className="chat-header-title" onClick={(e) => recipient && ui.showProfile(recipient.id, e.currentTarget)}>
          <Avatar user={recipient} size={26} presence={presence} />
          <span className="chat-header-name truncate">{recipient?.displayName ?? 'Direct message'}</span>
          <span className="chat-header-sub truncate">
            {recipient?.customStatus ? <EmojiText text={recipient.customStatus} /> : presenceLabel[presence]}
          </span>
        </button>
      ) : (
        <div className="chat-header-title">
          <Hash size={22} className="chat-header-hash" />
          <span className="chat-header-name truncate">{channel.name}</span>
          {channel.topic && (
            <>
              <span className="chat-header-divider" />
              <button className="chat-header-topic truncate" onClick={() => ui.openModal('topic', { channelId })}>
                {channel.topic}
              </button>
            </>
          )}
        </div>
      )}
      <div className="chat-header-actions">
        {isDm && !inCallHere && (
          <>
            <IconButton label="Start voice call" onClick={() => void call.join(channelId)}>
              <Phone size={20} weight="fill" />
            </IconButton>
            <IconButton label="Start video call" onClick={() => void call.join(channelId, { video: true })}>
              <VideoCamera size={21} weight="fill" />
            </IconButton>
          </>
        )}
        {isDm && recipient && (
          <IconButton label="Profile" onClick={(e) => ui.showProfile(recipient.id, e.currentTarget)}>
            <UserCircle size={22} />
          </IconButton>
        )}
        {!isDm && (
          <>
            <IconButton label="Invite people" onClick={() => ui.openModal('invite', { groupId: channel.groupId })}>
              <UserPlus size={20} />
            </IconButton>
            <IconButton
              label={membersOpen ? 'Hide member list' : 'Show member list'}
              active={membersOpen && !isMobileDevice}
              onClick={() => {
                if (isMobileDevice || window.innerWidth <= 760) ui.setMobilePane('side');
                else ui.setPrefs({ membersOpen: !membersOpen });
              }}
            >
              <Users size={21} weight={membersOpen ? 'fill' : 'regular'} />
            </IconButton>
          </>
        )}
      </div>
    </header>
  );
}

function DmCallBar({ channelId }: { channelId: string }) {
  const others = useData(useShallow((s) => Object.keys(s.voice[channelId] ?? {})));
  const name = useData((s) => (others[0] ? s.users[others[0]]?.displayName ?? 'Someone' : ''));
  const inCallHere = useCall((s) => s.channelId === channelId);
  if (inCallHere) return <CallStage channelId={channelId} variant="dm" />;
  if (!others.length) return null;
  return (
    <div className="dm-callbar">
      <span className="dm-callbar-pulse" />
      <span className="truncate">
        <strong>{name}</strong> {others.length > 1 ? `and ${others.length - 1} more are` : 'is'} in a call
      </span>
      <Button size="sm" icon={<Phone size={16} weight="fill" />} onClick={() => void call.join(channelId)}>
        Join
      </Button>
      <Button size="sm" variant="secondary" icon={<VideoCamera size={16} weight="fill" />} onClick={() => void call.join(channelId, { video: true })}>
        Join with video
      </Button>
    </div>
  );
}

export function ChatView({ channelId }: { channelId: string }) {
  const channel = useData((s) => s.channels[channelId]);
  const recipient = useData((s) => dmRecipient(s, channelId));
  const blocked = useData((s) => (recipient ? s.relationships[recipient.id]?.type === 2 : false));
  const [picker, setPicker] = useState<'emoji' | 'gifs' | 'stickers' | null>(null);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const dragDepth = useRef(0);

  useEffect(() => setPicker(null), [channelId]);

  if (!channel) return <div className="chat" />;
  const placeholder = channel.type === 'dm' ? `Message @${recipient?.displayName ?? 'someone'}` : `Message #${channel.name}`;

  const sendKlipy = (embed: KlipyEmbed) => {
    const replyToId = useUi.getState().replyTo[channelId] ?? null;
    ui.setReply(channelId, undefined);
    void sendMessage(channelId, { content: '', embeds: [embed], replyToId });
    setPicker(null);
  };

  return (
    <section
      className="chat"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const files = [...e.dataTransfer.files];
        if (files.length) composer.current?.addFiles(files);
      }}
    >
      <ChatHeader channelId={channelId} />
      {channel.type === 'dm' && <DmCallBar channelId={channelId} />}
      <MessageList channelId={channelId} />
      <div className="chat-footer">
        <AnimatePresence>
          {picker && (
            <motion.div
              className="picker-anchor"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.1 } }}
              transition={{ duration: 0.16, ease: [0.22, 0.8, 0.24, 1] }}
            >
              <ExpressionPicker
                tab={picker}
                onTab={setPicker}
                onClose={() => setPicker(null)}
                onEmoji={(text) => ui.insertIntoComposer(channelId, text)}
                onKlipy={sendKlipy}
              />
            </motion.div>
          )}
        </AnimatePresence>
        {blocked ? (
          <div className="composer-blocked">
            You blocked this person. <button onClick={() => recipient && ui.showProfile(recipient.id, document.body)}>Manage</button>
          </div>
        ) : (
          <Composer
            ref={composer}
            channelId={channelId}
            placeholder={placeholder}
            pickerOpen={picker}
            onPicker={(tab) => setPicker((cur) => (cur === tab ? null : tab))}
          />
        )}
        <TypingIndicator channelId={channelId} />
      </div>
      {dragging && (
        <div className="chat-drop">
          <div className="chat-drop-card">
            <CloudArrowUp size={56} weight="duotone" />
            <strong>Upload to {channel.type === 'dm' ? recipient?.displayName : `#${channel.name}`}</strong>
            <span>Drop files here to attach them</span>
          </div>
        </div>
      )}
    </section>
  );
}
