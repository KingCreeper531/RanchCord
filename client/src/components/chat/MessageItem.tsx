import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowBendUpLeft,
  ArrowRight,
  CopySimple,
  DotsThree,
  DownloadSimple,
  File,
  FileAudio,
  FileVideo,
  PencilSimple,
  Smiley,
  SmileyMeh,
  Trash,
  ArrowClockwise,
  At,
  Bomb,
  Star,
  PushPin,
  PushPinSlash,
  LinkSimple,
} from '@phosphor-icons/react';
import { deleteMessage, discardMessage, editMessage, retryMessage, toggleReaction, previewInvite, joinInvite, isFavorite, toggleFavorite, pinMessage, unpinMessage, type InvitePreview } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { downloadUrl, fileUrl, publicOrigin } from '../../lib/server';
import { formatBytes, formatFull, formatTime, formatTimestamp, plural } from '../../lib/format';
import { fit } from '../../lib/image';
import { InlineMarkdown, Markdown, CustomEmojiImage } from '../../lib/markdown';
import { isMobileDevice } from '../../lib/platform';
import { Emoji } from '../../lib/twemoji';
import { useData, displayNameIn } from '../../store/data';
import { memberColor } from '../../lib/perms';
import { ui, useUi } from '../../store/ui';
import type { Attachment, KlipyEmbed, Message, Reaction } from '../../types';
import { Avatar, Button, Spinner, Tooltip, openMenu, type MenuItem } from '../ui';
import { openReactionPicker } from '../pickers/ReactionPicker';
import { LinkCard, previewableLinks } from './LinkCard';
import { openMemberMenu } from '../memberMenu';

const JOIN_LINES = [
  'just showed up. Pass the ranch!',
  'joined the group. Everyone say hi!',
  'is here. Grab a carrot stick.',
  'slid into the group.',
  'arrived. The ranch is fresh.',
  'just landed. Make some room!',
  'hopped in. Welcome!',
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* ---------------- attachments ---------------- */

/** Enter or Space on something that acts like a button. */
const onActivate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  fn();
};

/** A GIF someone uploaded, as something that can go in favorites. */
const attachmentGif = (a: Attachment): KlipyEmbed => ({
  kind: 'media',
  type: 'gif',
  slug: `att:${a.id}`,
  title: a.filename,
  url: a.url,
  mp4: null,
  webp: null,
  preview: null,
  width: a.width || 300,
  height: a.height || 300,
});

function ImageAttachment({ a, single }: { a: Attachment; single: boolean }) {
  const size = a.width && a.height ? fit(a.width, a.height, single ? 520 : 300, single ? 380 : 300) : { width: 300, height: 220 };
  const open = () => ui.openModal('lightbox', { src: fileUrl(a.url), filename: a.filename });
  return (
    <div
      className="att-image"
      role="button"
      tabIndex={0}
      style={{ width: size.width, aspectRatio: `${size.width} / ${size.height}` } as CSSProperties}
      onClick={open}
      onKeyDown={onActivate(open)}
      aria-label={`Open ${a.filename}`}
    >
      <img src={fileUrl(a.url)} alt={a.filename} loading="lazy" decoding="async" draggable={false} />
      {a.contentType === 'image/gif' && <FavoriteButton e={attachmentGif(a)} />}
    </div>
  );
}

function VideoAttachment({ a }: { a: Attachment }) {
  const size = a.width && a.height ? fit(a.width, a.height, 520, 380) : { width: 420, height: 236 };
  return (
    <video
      className="att-video"
      style={{ width: size.width, aspectRatio: `${size.width} / ${size.height}` }}
      src={fileUrl(a.url)}
      controls
      preload="metadata"
      playsInline
    />
  );
}

function FileAttachment({ a }: { a: Attachment }) {
  const audio = a.contentType.startsWith('audio/');
  const Icon = audio ? FileAudio : a.contentType.startsWith('video/') ? FileVideo : File;
  return (
    <div className={`att-file${audio ? ' is-audio' : ''}`}>
      <div className="att-file-row">
        <Icon size={34} weight="duotone" className="att-file-icon" />
        <div className="att-file-meta">
          <a className="att-file-name truncate" href={downloadUrl(a.url)} target="_blank" rel="noreferrer" download={a.filename}>
            {a.filename}
          </a>
          <span className="att-file-size">{formatBytes(a.size)}</span>
        </div>
        <a className="att-file-dl" href={downloadUrl(a.url)} download={a.filename} target="_blank" rel="noreferrer" aria-label="Download">
          <DownloadSimple size={20} />
        </a>
      </div>
      {audio && <audio src={fileUrl(a.url)} controls preload="none" />}
    </div>
  );
}

function Attachments({ list }: { list: Attachment[] }) {
  const images = list.filter((a) => a.contentType.startsWith('image/'));
  const others = list.filter((a) => !a.contentType.startsWith('image/'));
  return (
    <div className="msg-attachments">
      {images.length > 0 && (
        <div className={`att-images${images.length > 1 ? ' is-grid' : ''}`}>
          {images.map((a) => (
            <ImageAttachment key={a.id} a={a} single={images.length === 1} />
          ))}
        </div>
      )}
      {others.map((a) =>
        a.contentType.startsWith('video/') && /\.(mp4|webm|m4v|mov)$/i.test(a.filename) ? <VideoAttachment key={a.id} a={a} /> : <FileAttachment key={a.id} a={a} />,
      )}
    </div>
  );
}

/* ---------------- embeds ---------------- */

function FavoriteButton({ e }: { e: KlipyEmbed }) {
  const fav = useData((s) => isFavorite(s.favorites, e));
  return (
    <button
      className={`embed-fav${fav ? ' is-fav' : ''}`}
      onClick={(ev) => {
        ev.stopPropagation();
        toggleFavorite(e)
          .then((on) => ui.toast(on ? 'Added to favorites' : 'Removed from favorites', 'success'))
          .catch((err) => ui.toast(errorMessage(err), 'error'));
      }}
      aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={fav}
    >
      <Star size={18} weight={fav ? 'fill' : 'bold'} />
    </button>
  );
}

function KlipyCard({ e }: { e: KlipyEmbed }) {
  if (e.type === 'sticker') {
    const s = fit(e.width, e.height, 180, 180);
    return (
      <div className="embed-sticker-wrap" style={{ width: s.width, height: s.height }}>
        <img className="embed-sticker" src={fileUrl(e.webp ?? e.url)} alt={e.title || 'Sticker'} title={e.title} style={{ width: s.width, height: s.height }} loading="lazy" draggable={false} />
        <FavoriteButton e={e} />
      </div>
    );
  }
  const s = fit(e.width, e.height, 400, 320);
  const open = () =>
    ui.openModal(
      'lightbox',
      e.mp4
        ? { src: fileUrl(e.mp4), kind: 'video', poster: e.preview ? fileUrl(e.preview) : null, filename: e.title || 'GIF', original: fileUrl(e.url), download: false }
        : { src: fileUrl(e.webp ?? e.url), filename: e.title || 'GIF', original: fileUrl(e.url), download: e.kind === 'media' && e.url.startsWith('/files/') },
    );
  return (
    <div
      className="embed-gif"
      role="button"
      tabIndex={0}
      style={{ width: s.width, aspectRatio: `${s.width} / ${s.height}` }}
      title={e.title}
      onClick={open}
      onKeyDown={onActivate(open)}
    >
      {e.mp4 ? (
        <video src={fileUrl(e.mp4)} autoPlay loop muted playsInline poster={e.preview ? fileUrl(e.preview) : undefined} />
      ) : (
        <img src={fileUrl(e.webp ?? e.url)} alt={e.title || 'GIF'} loading="lazy" draggable={false} />
      )}
      <span className="embed-gif-tag">GIF</span>
      <FavoriteButton e={e} />
    </div>
  );
}

const inviteCache = new Map<string, Promise<InvitePreview | null>>();

function InviteCard({ code }: { code: string }) {
  const [invite, setInvite] = useState<InvitePreview | null | undefined>(undefined);
  const [joining, setJoining] = useState(false);
  const joined = useData((s) => (invite ? Boolean(s.groups[invite.group.id]) : false));
  useEffect(() => {
    let cancelled = false;
    if (!inviteCache.has(code)) inviteCache.set(code, previewInvite(code).catch(() => null));
    void inviteCache.get(code)!.then((r) => !cancelled && setInvite(r));
    return () => {
      cancelled = true;
    };
  }, [code]);
  if (invite === undefined) return <div className="invite-card is-loading"><Spinner /></div>;
  return (
    <div className="invite-card">
      <div className="invite-card-label">{invite ? "You've been invited to join a group" : 'Invite'}</div>
      <div className="invite-card-body">
        {invite ? (
          <>
            <div className="invite-card-icon">
              {invite.group.icon ? <img src={fileUrl(invite.group.icon)} alt="" /> : <span>{invite.group.name.slice(0, 2)}</span>}
            </div>
            <div className="invite-card-text">
              <strong className="truncate">{invite.group.name}</strong>
              <span>
                <i className="dot dot-online" /> {invite.group.onlineCount} online <i className="dot" /> {plural(invite.group.memberCount, 'member')}
              </span>
            </div>
            <Button
              size="sm"
              variant={joined ? 'secondary' : 'primary'}
              loading={joining}
              onClick={async () => {
                if (joined) {
                  const s = useData.getState();
                  const g = s.groups[invite.group.id];
                  ui.navigate({ kind: 'group', groupId: g.id, channelId: g.channelIds.find((id) => s.channels[id]?.type === 'text') ?? null });
                  return;
                }
                setJoining(true);
                try {
                  await joinInvite(code);
                } catch (err) {
                  ui.toast((err as Error).message, 'error');
                } finally {
                  setJoining(false);
                }
              }}
            >
              {joined ? 'Joined' : 'Join'}
            </Button>
          </>
        ) : (
          <div className="invite-card-text">
            <strong>Invalid invite</strong>
            <span>This invite may have expired.</span>
          </div>
        )}
      </div>
    </div>
  );
}

const IMAGE_URL = /https?:\/\/[^\s<>]+\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s<>]*)?(?=$|[\s<>])/gi;
const INVITE_URL = /https?:\/\/[^\s<>]+\/invite\/([A-Za-z0-9]{6,16})\b/g;

/** A picture from a link in a message. Linked GIFs can be starred too. */
function LinkImage({ src }: { src: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const gif = /\.gif(?:$|[?#])/i.test(src);
  const open = () => {
    const name = src.split(/[?#]/)[0].split('/').pop() ?? '';
    let filename = name;
    try {
      filename = decodeURIComponent(name);
    } catch {
      /* keep it as it is */
    }
    ui.openModal('lightbox', { src, filename, download: false });
  };
  return (
    <div className="embed-image" role="button" tabIndex={0} onClick={open} onKeyDown={onActivate(open)}>
      <img
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onLoad={(ev) => setSize({ width: ev.currentTarget.naturalWidth || 300, height: ev.currentTarget.naturalHeight || 300 })}
      />
      {gif && (
        <FavoriteButton
          e={{
            kind: 'media',
            type: 'gif',
            slug: `url:${hash(src).toString(36)}${src.length.toString(36)}`,
            title: '',
            url: src,
            mp4: null,
            webp: null,
            preview: null,
            width: size?.width ?? 300,
            height: size?.height ?? 300,
          }}
        />
      )}
    </div>
  );
}

function LinkEmbeds({ content }: { content: string }) {
  const { images, invites, links } = useMemo(() => {
    if (!content.includes('http')) return { images: [], invites: [], links: [] };
    // Links wrapped in <...> don't get previews, like on Discord.
    const stripped = content.replace(/<https?:\/\/[^\s>]+>/g, '');
    const images = [...new Set(stripped.match(IMAGE_URL) ?? [])].slice(0, 4);
    return {
      images,
      invites: [...new Set([...stripped.matchAll(INVITE_URL)].map((m) => m[1]))].slice(0, 3),
      links: previewableLinks(stripped, (url) => images.includes(url) || /\/invite\/[A-Za-z0-9]{6,16}\b/.test(url)),
    };
  }, [content]);
  if (!images.length && !invites.length && !links.length) return null;
  return (
    <div className="msg-embeds">
      {invites.map((code) => (
        <InviteCard key={code} code={code} />
      ))}
      {links.map((url) => (
        <LinkCard key={url} url={url} />
      ))}
      {images.map((src) => (
        <LinkImage key={src} src={src} />
      ))}
    </div>
  );
}

/* ---------------- reactions ---------------- */

function ReactionEmoji({ emoji }: { emoji: string }) {
  if (emoji.startsWith('c:')) return <CustomEmojiImage id={emoji.slice(2)} name="emoji" className="reaction-custom" />;
  return <Emoji char={emoji} />;
}

function Reactions({ message }: { message: Message }) {
  return (
    <div className="msg-reactions">
      {message.reactions.map((r: Reaction) => (
        <button
          key={r.emoji}
          className={`reaction${r.me ? ' is-mine' : ''}`}
          onClick={() => void toggleReaction(message.channelId, message.id, r.emoji)}
        >
          <ReactionEmoji emoji={r.emoji} />
          <span className="reaction-count">{r.count}</span>
        </button>
      ))}
      <Tooltip label="Add reaction">
        <button
          className="reaction reaction-add"
          aria-label="Add reaction"
          onClick={(e) => openReactionPicker(e.currentTarget.getBoundingClientRect(), message.channelId, message.id)}
        >
          <SmileyMeh size={16} />
        </button>
      </Tooltip>
    </div>
  );
}

/* ---------------- edit box ---------------- */

function decodeForEdit(content: string): string {
  const s = useData.getState();
  return content
    .replace(/<@([0-9A-HJKMNP-TV-Z]{26})>/g, (m, id: string) => (s.users[id] ? `@${s.users[id].username}` : m))
    .replace(/<a?:([a-zA-Z0-9_]{2,32}):[0-9A-HJKMNP-TV-Z]{26}>/g, ':$1:');
}

function EditBox({ message }: { message: Message }) {
  const [value, setValue] = useState(() => decodeForEdit(message.content));
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
  }, [value]);
  const save = async () => {
    const text = value.trim();
    if (text === decodeForEdit(message.content).trim()) return ui.setEditing(null);
    if (!text && !message.attachments.length && !message.embeds.length) {
      ui.setEditing(null);
      confirmDelete(message);
      return;
    }
    setSaving(true);
    try {
      await editMessage(message.channelId, message.id, text);
      ui.setEditing(null);
    } catch (err) {
      ui.toast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="msg-edit">
      <textarea
        ref={ref}
        className="msg-edit-input scroll"
        value={value}
        rows={1}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            ui.setEditing(null);
          } else if (e.key === 'Enter' && !e.shiftKey && !isMobileDevice) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="msg-edit-hint">
        escape to <button onClick={() => ui.setEditing(null)}>cancel</button> · enter to <button onClick={() => void save()}>save</button>
      </div>
    </div>
  );
}

/* ---------------- actions ---------------- */

export function confirmDelete(message: Message) {
  ui.openModal('confirm', {
    title: 'Delete message',
    body: 'Are you sure you want to delete this message? This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
    preview: { authorId: message.author.id, content: message.content },
    onConfirm: () => deleteMessage(message.channelId, message.id),
  });
}

const showError = (err: unknown) => ui.toast(errorMessage(err), 'error');

/** A link straight to a message, for sharing (opens the chat and jumps to it). */
export function messageLink(message: Message): string {
  const s = useData.getState();
  const groupId = s.channels[message.channelId]?.groupId;
  return `${publicOrigin(s.instance?.publicUrl)}/#/channels/${groupId ?? '@me'}/${message.channelId}/${message.id}`;
}

function messageMenu(message: Message, canEdit: boolean, canDelete: boolean, canPin: boolean): MenuItem[] {
  const recent = ui.getRecentReactions();
  return [
    ...recent.slice(0, 4).map((emoji) => ({
      label: `React ${emoji.startsWith('c:') ? '' : emoji}`.trim(),
      onSelect: () => void toggleReaction(message.channelId, message.id, emoji),
    })),
    { separator: true as const },
    { label: 'Reply', icon: <ArrowBendUpLeft size={16} />, onSelect: () => ui.setReply(message.channelId, message.id) },
    ...(canEdit ? [{ label: 'Edit message', icon: <PencilSimple size={16} />, onSelect: () => ui.setEditing(message.id) }] : []),
    {
      label: 'Copy text',
      icon: <CopySimple size={16} />,
      disabled: !message.content,
      onSelect: () => void navigator.clipboard.writeText(decodeForEdit(message.content)),
    },
    {
      label: 'Mention author',
      icon: <At size={16} />,
      onSelect: () => ui.insertIntoComposer(message.channelId, `@${message.author.username} `),
    },
    ...(canPin
      ? [
          message.pinnedAt
            ? { label: 'Unpin message', icon: <PushPinSlash size={16} />, onSelect: () => void unpinMessage(message.channelId, message.id).catch(showError) }
            : { label: 'Pin message', icon: <PushPin size={16} />, onSelect: () => void pinMessage(message.channelId, message.id).catch(showError) },
        ]
      : []),
    {
      label: 'Copy message link',
      icon: <LinkSimple size={16} />,
      onSelect: () => {
        void navigator.clipboard.writeText(messageLink(message));
        ui.toast('Link copied', 'success');
      },
    },
    ...(canDelete
      ? [{ separator: true as const }, { label: 'Delete message', icon: <Trash size={16} />, danger: true, onSelect: () => confirmDelete(message) }]
      : []),
  ];
}

/* ---------------- message ---------------- */

interface Props {
  message: Message;
  continued: boolean;
  groupId: string | null;
  meId: string;
  canManage: boolean;
  highlighted: boolean;
}

export const MessageItem = memo(function MessageItem({ message, continued, groupId, meId, canManage, highlighted }: Props) {
  const isEditing = useUiEditing(message.id);
  const isReplyTarget = useReplyTarget(message.channelId, message.id);
  const authorName = useData((s) => displayNameIn(s, message.author.id, groupId));
  const authorColor = useData((s) => memberColor(s, groupId, message.author.id));
  const author = useData((s) => s.users[message.author.id] ?? message.author);
  const mine = message.author.id === meId;
  const myRoles = useData((s) => (groupId ? s.groups[groupId]?.members[meId]?.roles : undefined));
  const mentionsMe =
    !mine &&
    (message.content.includes(`<@${meId}>`) ||
      /(^|\s)@(everyone|here)\b/.test(message.content) ||
      message.replyTo?.author?.id === meId ||
      Boolean(myRoles?.some((r) => message.content.includes(`<@&${r}>`))));
  const canEdit = mine && !message.pending && !message.failed && Boolean(message.content || message.attachments.length);
  const canDelete = !message.pending && (mine || canManage);
  // In DMs either person can pin; in groups it takes Manage Messages.
  const canPin = !message.pending && !message.failed && message.type === 'default' && (!groupId || canManage);

  if (message.type === 'pin') {
    const pinnedId = message.replyTo?.id;
    return (
      <div className="msg msg-system msg-pin" data-mid={message.id}>
        <span className="msg-gutter">
          <PushPin size={18} weight="fill" className="msg-system-icon" />
        </span>
        <div className="msg-system-text">
          <button className="msg-author-name" onClick={(e) => ui.showProfile(author.id, e.currentTarget, groupId)}>
            {authorName}
          </button>{' '}
          pinned{' '}
          <button className="msg-system-link" onClick={() => pinnedId && ui.jumpToMessage(message.channelId, pinnedId)}>
            a message
          </button>{' '}
          to this {groupId ? 'channel' : 'chat'}.{' '}
          <button className="msg-system-link" onClick={() => ui.openModal('pins', { channelId: message.channelId })}>
            See all pins
          </button>
          <Tooltip label={formatFull(message.createdAt)}>
            <time className="msg-time">{formatTimestamp(message.createdAt)}</time>
          </Tooltip>
        </div>
      </div>
    );
  }

  if (message.type === 'nuke') {
    return (
      <div className="msg msg-system msg-nuke" data-mid={message.id}>
        <span className="msg-gutter">
          <Bomb size={18} weight="fill" className="msg-system-icon" />
        </span>
        <div className="msg-system-text">
          <button className="msg-author-name" onClick={(e) => ui.showProfile(author.id, e.currentTarget, groupId)}>
            {authorName}
          </button>{' '}
          nuked this chat. Everything sent before is gone.
          <Tooltip label={formatFull(message.createdAt)}>
            <time className="msg-time">{formatTimestamp(message.createdAt)}</time>
          </Tooltip>
        </div>
      </div>
    );
  }

  if (message.type === 'join') {
    const line = JOIN_LINES[hash(message.id) % JOIN_LINES.length];
    return (
      <div className="msg msg-system" data-mid={message.id}>
        <span className="msg-gutter">
          <ArrowRight size={18} weight="bold" className="msg-system-icon" />
        </span>
        <div className="msg-system-text">
          <button className="msg-author-name" onClick={(e) => ui.showProfile(author.id, e.currentTarget, groupId)}>
            {authorName}
          </button>{' '}
          {line}
          <Tooltip label={formatFull(message.createdAt)}>
            <time className="msg-time">{formatTimestamp(message.createdAt)}</time>
          </Tooltip>
        </div>
      </div>
    );
  }

  const openProfile = (e: React.MouseEvent<HTMLElement>) => ui.showProfile(author.id, e.currentTarget, groupId);
  // Right-clicking (or holding) a name or picture gives that person's menu instead of the message's.
  const personMenu = (e: React.MouseEvent<HTMLElement>) => openMemberMenu(e, author.id, groupId ?? null);
  const showHeader = !continued || Boolean(message.replyTo);
  const className = [
    'msg',
    showHeader ? 'msg-head' : 'msg-cont',
    mentionsMe ? 'is-mention' : '',
    message.pending ? 'is-pending' : '',
    message.failed ? 'is-failed' : '',
    isEditing ? 'is-editing' : '',
    isReplyTarget ? 'is-reply-target' : '',
    highlighted ? 'is-highlighted' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      data-mid={message.id}
      onContextMenu={(e) => {
        if (message.pending || message.failed) return;
        if ((e.target as HTMLElement).closest('a, video, audio')) return;
        e.preventDefault();
        if (isMobileDevice) ui.openModal('messageActions', { channelId: message.channelId, messageId: message.id, canEdit, canDelete });
        else openMenu(e, messageMenu(message, canEdit, canDelete, canPin));
      }}
    >
      {message.replyTo && <ReplyPreview message={message} groupId={groupId} />}
      <div className="msg-row">
        <span className="msg-gutter">
          {showHeader ? (
            <span className="msg-avatar-wrap" onContextMenu={personMenu}>
              <Avatar user={author} size={40} onClick={openProfile} className="msg-avatar" />
            </span>
          ) : (
            <Tooltip label={formatFull(message.createdAt)}>
              <time className="msg-hover-time">{formatTime(message.createdAt)}</time>
            </Tooltip>
          )}
        </span>
        <div className="msg-body">
          {showHeader && (
            <div className="msg-header">
              <button className="msg-author-name" onClick={openProfile} onContextMenu={personMenu} style={{ color: authorColor }}>
                {authorName}
              </button>
              <Tooltip label={formatFull(message.createdAt)}>
                <time className="msg-time">{formatTimestamp(message.createdAt)}</time>
              </Tooltip>
            </div>
          )}
          {isEditing ? (
            <EditBox message={message} />
          ) : (
            message.content && (
              <Markdown
                content={message.content}
                groupId={groupId}
                suffix={message.editedAt ? (
                  <Tooltip label={formatFull(message.editedAt)}>
                    <span className="msg-edited">(edited)</span>
                  </Tooltip>
                ) : null}
              />
            )
          )}
          {message.attachments.length > 0 && <Attachments list={message.attachments} />}
          {message.embeds.length > 0 && (
            <div className="msg-embeds">
              {message.embeds.map((e, i) => (
                <KlipyCard key={i} e={e} />
              ))}
            </div>
          )}
          {!message.pending && message.content && <LinkEmbeds content={message.content} />}
          {message.failed && (
            <div className="msg-failed">
              Couldn't send this message.
              <button onClick={() => retryMessage(message.channelId, message.nonce!)}>
                <ArrowClockwise size={14} weight="bold" /> Retry
              </button>
              <button onClick={() => discardMessage(message.channelId, message.nonce!)}>
                <Trash size={14} /> Delete
              </button>
            </div>
          )}
          {message.reactions.length > 0 && <Reactions message={message} />}
        </div>
      </div>
      {!message.pending && !message.failed && !isEditing && (
        <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
          {ui.getRecentReactions().slice(0, 3).map((emoji) => (
            <button key={emoji} className="msg-action msg-action-emoji" onClick={() => void toggleReaction(message.channelId, message.id, emoji)} aria-label={`React with ${emoji}`}>
              <ReactionEmoji emoji={emoji} />
            </button>
          ))}
          <span className="msg-actions-sep" />
          <Tooltip label="Add reaction">
            <button className="msg-action" onClick={(e) => openReactionPicker(e.currentTarget.getBoundingClientRect(), message.channelId, message.id)} aria-label="Add reaction">
              <Smiley size={19} />
            </button>
          </Tooltip>
          <Tooltip label="Reply">
            <button className="msg-action" onClick={() => ui.setReply(message.channelId, message.id)} aria-label="Reply">
              <ArrowBendUpLeft size={19} />
            </button>
          </Tooltip>
          {canEdit && (
            <Tooltip label="Edit">
              <button className="msg-action" onClick={() => ui.setEditing(message.id)} aria-label="Edit">
                <PencilSimple size={19} />
              </button>
            </Tooltip>
          )}
          <Tooltip label="More">
            <button
              className="msg-action"
              aria-label="More"
              onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), messageMenu(message, canEdit, canDelete, canPin), 'end')}
            >
              <DotsThree size={20} weight="bold" />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
});

function ReplyPreview({ message, groupId }: { message: Message; groupId: string | null }) {
  const ref = message.replyTo!;
  const refAuthor = useData((s) => (ref.author ? s.users[ref.author.id] ?? ref.author : null));
  const name = useData((s) => (ref.author ? displayNameIn(s, ref.author.id, groupId) : ''));
  const color = useData((s) => (ref.author ? memberColor(s, groupId, ref.author.id) : undefined));
  if (ref.deleted || !ref.author) {
    return (
      <div className="msg-reply is-deleted">
        <span className="msg-reply-spine" />
        <span className="msg-reply-icon"><ArrowBendUpLeft size={12} weight="bold" /></span>
        <span className="msg-reply-text">Original message was deleted</span>
      </div>
    );
  }
  return (
    <div className="msg-reply" onClick={() => ui.jumpToMessage(message.channelId, ref.id)} role="button" tabIndex={0}>
      <span className="msg-reply-spine" />
      <Avatar user={refAuthor} size={16} />
      <span className="msg-reply-name" style={{ color }}>@{name}</span>
      <span className="msg-reply-text truncate">
        {ref.content ? <InlineMarkdown content={ref.content} groupId={groupId} /> : <em>{ref.hasEmbeds ? 'GIF' : ref.hasAttachments ? 'Click to see attachment' : 'Message'}</em>}
      </span>
    </div>
  );
}

function useUiEditing(id: string) {
  return useUi((s) => s.editing === id);
}

function useReplyTarget(channelId: string, id: string) {
  return useUi((s) => s.replyTo[channelId] === id);
}
