import { memo, useMemo, useState } from 'react';
import { ChatCircle, Check, CopySimple, DotsThreeVertical, MagnifyingGlass, Phone, Prohibit, UserMinus, Users, X } from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { call } from '../calls/manager';
import { acceptFriend, askToBlock, openDm, removeRelationship, sendFriendRequest } from '../lib/actions';
import { errorMessage } from '../lib/api';
import { formatFriendCode } from '../lib/format';
import { EmojiText } from '../lib/twemoji';
import { useData } from '../store/data';
import { ui, useUi } from '../store/ui';
import { REL, type Relationship } from '../types';
import { MobileMenuButton } from './chat/ChatView';
import { Avatar, Button, EmptyState, IconButton, openMenu, presenceLabel } from './ui';

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

const FriendRow = memo(function FriendRow({ rel }: { rel: Relationship }) {
  const user = useData((s) => s.users[rel.userId]);
  const presence = useData((s) => s.presences[rel.userId] ?? 'offline');
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const sub =
    rel.type === REL.INCOMING
      ? 'Incoming friend request'
      : rel.type === REL.OUTGOING
        ? 'Outgoing friend request'
        : rel.type === REL.BLOCKED
          ? 'Blocked'
          : user.customStatus || presenceLabel[presence];
  return (
    <div
      className="friend-row"
      role="button"
      tabIndex={0}
      onClick={(e) => (rel.type === REL.FRIEND ? void openDm(user.id) : ui.showProfile(user.id, e.currentTarget))}
    >
      <Avatar user={user} size={36} presence={rel.type === REL.FRIEND ? presence : null} />
      <div className="friend-text">
        <span className="friend-name">
          {user.displayName}
          <span className="friend-handle">{user.username}</span>
        </span>
        <span className="friend-sub truncate">
          <EmojiText text={sub} />
        </span>
      </div>
      <div className="friend-actions" onClick={(e) => e.stopPropagation()}>
        {rel.type === REL.FRIEND && (
          <>
            <IconButton label="Message" size={36} onClick={() => void openDm(user.id)}>
              <ChatCircle size={20} weight="fill" />
            </IconButton>
            <IconButton
              label="More"
              size={36}
              onClick={(e) =>
                openMenu(e.currentTarget.getBoundingClientRect(), [
                  {
                    label: 'Start voice call',
                    icon: <Phone size={16} />,
                    onSelect: async () => {
                      await openDm(user.id);
                      const ch = Object.values(useData.getState().channels).find((c) => c.type === 'dm' && c.recipientId === user.id);
                      if (ch) void call.join(ch.id);
                    },
                  },
                  { label: 'Profile', onSelect: () => ui.showProfile(user.id, document.activeElement ?? document.body) },
                  { separator: true },
                  {
                    label: 'Remove friend',
                    danger: true,
                    icon: <UserMinus size={16} />,
                    onSelect: () =>
                      ui.openModal('confirm', {
                        title: `Remove ${user.displayName}?`,
                        body: `Are you sure you want to remove ${user.displayName} from your friends?`,
                        confirmLabel: 'Remove friend',
                        danger: true,
                        onConfirm: () => removeRelationship(user.id),
                      }),
                  },
                  { label: 'Block', danger: true, icon: <Prohibit size={16} />, onSelect: () => askToBlock(user.id) },
                ], 'end')
              }
            >
              <DotsThreeVertical size={20} weight="bold" />
            </IconButton>
          </>
        )}
        {rel.type === REL.INCOMING && (
          <>
            <IconButton label="Accept" size={36} className="is-accept" disabled={busy} onClick={() => void run(() => acceptFriend(user.id))}>
              <Check size={20} weight="bold" />
            </IconButton>
            <IconButton label="Ignore" size={36} danger disabled={busy} onClick={() => void run(() => removeRelationship(user.id))}>
              <X size={20} weight="bold" />
            </IconButton>
          </>
        )}
        {rel.type === REL.OUTGOING && (
          <IconButton label="Cancel request" size={36} danger disabled={busy} onClick={() => void run(() => removeRelationship(user.id))}>
            <X size={20} weight="bold" />
          </IconButton>
        )}
        {rel.type === REL.BLOCKED && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(() => removeRelationship(user.id))}>
            Unblock
          </Button>
        )}
      </div>
    </div>
  );
});

function AddFriend() {
  const me = useData((s) => s.me!);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await sendFriendRequest(value.trim());
      setStatus({
        ok: true,
        text: r.type === REL.FRIEND ? `You're now friends with ${r.user.displayName}!` : `Friend request sent to ${r.user.displayName}.`,
      });
      setValue('');
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  const code = formatFriendCode(me.friendCode);
  return (
    <div className="add-friend">
      <h2>Add Friend</h2>
      <p>Add friends with their username or their friend code.</p>
      <form
        className={`add-friend-box${status ? (status.ok ? ' is-ok' : ' is-error') : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          value={value}
          autoFocus
          onChange={(e) => {
            setValue(e.target.value);
            setStatus(null);
          }}
          placeholder="Username or friend code (like ABCD-1234)"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <Button type="submit" size="sm" loading={busy} disabled={!value.trim()}>
          Send Friend Request
        </Button>
      </form>
      {status && <div className={`add-friend-status${status.ok ? ' is-ok' : ' is-error'}`}>{status.text}</div>}

      <div className="friend-code-card">
        <div>
          <span className="ui-section-label">Your friend code</span>
          <div className="friend-code">{code}</div>
          <span className="friend-code-hint">
            Or they can add you by your username, <strong>{me.username}</strong>.
          </span>
        </div>
        <Button
          variant="secondary"
          icon={<CopySimple size={16} weight="bold" />}
          onClick={() => {
            void navigator.clipboard.writeText(code);
            ui.toast('Friend code copied', 'success');
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

export function FriendsView() {
  const tab = useUi((s) => s.friendsTab) as Tab;
  const rels = useData(useShallow((s) => Object.values(s.relationships)));
  const presences = useData((s) => s.presences);
  const users = useData((s) => s.users);
  const [filter, setFilter] = useState('');
  const pendingCount = rels.filter((r) => r.type === REL.INCOMING).length;

  const list = useMemo(() => {
    let l = rels;
    if (tab === 'online') l = rels.filter((r) => r.type === REL.FRIEND && presences[r.userId]);
    else if (tab === 'all') l = rels.filter((r) => r.type === REL.FRIEND);
    else if (tab === 'pending') l = rels.filter((r) => r.type === REL.INCOMING || r.type === REL.OUTGOING);
    else if (tab === 'blocked') l = rels.filter((r) => r.type === REL.BLOCKED);
    const q = filter.trim().toLowerCase();
    if (q) l = l.filter((r) => users[r.userId]?.displayName.toLowerCase().includes(q) || users[r.userId]?.username.includes(q));
    return [...l].sort((a, b) => {
      if (a.type !== b.type) return a.type === REL.INCOMING ? -1 : b.type === REL.INCOMING ? 1 : 0;
      return (users[a.userId]?.displayName ?? '').localeCompare(users[b.userId]?.displayName ?? '');
    });
  }, [rels, tab, presences, users, filter]);

  const setTab = (t: Tab) => useUi.setState({ friendsTab: t });
  const label = { online: 'Online', all: 'All friends', pending: 'Pending', blocked: 'Blocked', add: '' }[tab];

  return (
    <section className="friends">
      <header className="chat-header friends-header">
        <MobileMenuButton />
        <span className="friends-title">
          <Users size={22} weight="fill" /> Friends
        </span>
        <span className="chat-header-divider" />
        <nav className="friends-tabs scroll-hidden">
          {(['online', 'all', 'pending', 'blocked'] as Tab[]).map((t) => (
            <button key={t} className={`friends-tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
              {t === 'online' ? 'Online' : t === 'all' ? 'All' : t === 'pending' ? 'Pending' : 'Blocked'}
              {t === 'pending' && pendingCount > 0 && <span className="ui-badge">{pendingCount}</span>}
            </button>
          ))}
          <button className={`friends-tab friends-tab-add${tab === 'add' ? ' is-active' : ''}`} onClick={() => setTab('add')}>
            Add Friend
          </button>
        </nav>
      </header>
      <div className="friends-body scroll">
        {tab === 'add' ? (
          <AddFriend />
        ) : (
          <>
            <div className="friends-search">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search" />
              <MagnifyingGlass size={18} />
            </div>
            {list.length > 0 && (
              <div className="friends-count">
                {label} — {list.length}
              </div>
            )}
            {list.map((r) => (
              <FriendRow key={r.userId} rel={r} />
            ))}
            {list.length === 0 && (
              <EmptyState
                title={
                  tab === 'online'
                    ? "No one's around right now"
                    : tab === 'pending'
                      ? 'No pending requests'
                      : tab === 'blocked'
                        ? "You haven't blocked anyone"
                        : 'No friends yet'
                }
                body={tab === 'online' || tab === 'all' ? 'Add friends with their username or friend code.' : undefined}
              >
                {(tab === 'online' || tab === 'all') && (
                  <Button onClick={() => setTab('add')}>Add Friend</Button>
                )}
              </EmptyState>
            )}
          </>
        )}
      </div>
    </section>
  );
}
