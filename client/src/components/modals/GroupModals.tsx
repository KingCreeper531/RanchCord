import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Camera, CaretRight, Check, CopySimple, Crown, Hash, Link as LinkIcon, MagnifyingGlass, ShieldStar, SpeakerHigh, Trash, UsersThree, ArrowsClockwise } from '@phosphor-icons/react';
import {
  createChannel,
  createGroup,
  deleteChannel,
  deleteGroup,
  getInvite,
  joinInvite,
  kickMember,
  leaveGroup,
  parseInviteCode,
  previewInvite,
  removeGroupIcon,
  renameGroup,
  sendInviteTo,
  setGroupIcon,
  setMemberHasRole,
  setMemberRole,
  transferOwnership,
  updateChannel,
  type InvitePreview,
} from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { initials } from '../../lib/format';
import { fileUrl } from '../../lib/server';
import { friendIds, useData, displayNameIn } from '../../store/data';
import { PERM, can, memberColor, topPosition } from '../../lib/perms';
import { RolesTab } from './RolesEditor';
import { ui } from '../../store/ui';
import { Avatar, Button, ModalFrame, TextField, openMenu } from '../ui';
import { keepsAnimation, pickImage } from './ImageCrop';

/* ---------------- add group: create or join ---------------- */

export function AddGroupModal({ onClose, initialCode }: { onClose: () => void; initialCode?: string }) {
  const me = useData((s) => s.me!);
  const [step, setStep] = useState<'choose' | 'create' | 'join'>(initialCode ? 'join' : 'choose');
  const [name, setName] = useState(`${me.displayName}'s group`);
  const [icon, setIcon] = useState<{ blob: Blob; url: string; filename: string } | null>(null);
  const [code, setCode] = useState(initialCode ?? '');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (step !== 'join') return;
    const c = parseInviteCode(code);
    setPreview(null);
    if (c.length < 6) return;
    const t = setTimeout(() => {
      previewInvite(c)
        .then((p) => {
          setPreview(p);
          setError(null);
        })
        .catch((err) => setError(errorMessage(err)));
    }, 350);
    return () => clearTimeout(t);
  }, [code, step]);

  const chooseIcon = async () => {
    const file = await pickImage();
    if (!file) return;
    const done = (blob: Blob, filename: string) => setIcon({ blob, filename, url: URL.createObjectURL(blob) });
    if (keepsAnimation(file)) done(file, file.name);
    else ui.openModal('crop', { file, title: 'Group icon', shape: 'rounded', outWidth: 512, onDone: done });
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const g = await createGroup(name.trim() || `${me.displayName}'s group`);
      if (icon) await setGroupIcon(g.id, icon.blob, icon.filename).catch(() => ui.toast("Group created, but the icon didn't upload", 'error'));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await joinInvite(parseInviteCode(code));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'choose') {
    return (
      <ModalFrame title="Add a group" subtitle="A group is where you and your friends hang out. Make your own or join one with an invite." onClose={onClose} size="sm">
        <button className="choice-card" onClick={() => setStep('create')}>
          <span className="choice-icon">
            <UsersThree size={26} weight="duotone" />
          </span>
          <span className="choice-text">
            <strong>Create my own</strong>
            <span>Start fresh with text and voice channels</span>
          </span>
          <CaretRight size={18} />
        </button>
        <div className="choice-divider">or</div>
        <button className="choice-card" onClick={() => setStep('join')}>
          <span className="choice-icon is-blue">
            <LinkIcon size={26} weight="duotone" />
          </span>
          <span className="choice-text">
            <strong>Join a group</strong>
            <span>Use an invite link from a friend</span>
          </span>
          <CaretRight size={18} />
        </button>
      </ModalFrame>
    );
  }

  if (step === 'create') {
    return (
      <ModalFrame
        title="Customize your group"
        subtitle="Give it a name and an icon. You can always change these later."
        onClose={onClose}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStep('choose')}>
              Back
            </Button>
            <span className="spacer" />
            <Button loading={busy} disabled={!name.trim()} onClick={() => void create()}>
              Create
            </Button>
          </>
        }
      >
        <button className="icon-upload" onClick={() => void chooseIcon()}>
          {icon ? (
            <img src={icon.url} alt="" />
          ) : (
            <>
              <Camera size={26} weight="fill" />
              <span>Upload</span>
            </>
          )}
        </button>
        <TextField label="Group name" value={name} maxLength={64} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
        {error && <div className="form-error">{error}</div>}
      </ModalFrame>
    );
  }

  return (
    <ModalFrame
      title="Join a group"
      subtitle="Paste an invite link or code from a friend."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => setStep('choose')}>
            Back
          </Button>
          <span className="spacer" />
          <Button loading={busy} disabled={!preview || preview.joined} onClick={() => void join()}>
            {preview?.joined ? 'Already joined' : 'Join group'}
          </Button>
        </>
      }
    >
      <TextField label="Invite link" value={code} autoFocus placeholder="https://…/invite/hTKzmak2" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && preview && void join()} />
      {preview && (
        <div className="invite-preview">
          <div className="invite-card-icon">
            {preview.group.icon ? <img src={fileUrl(preview.group.icon)} alt="" /> : <span>{initials(preview.group.name)}</span>}
          </div>
          <div className="invite-card-text">
            <strong className="truncate">{preview.group.name}</strong>
            <span>
              <i className="dot dot-online" /> {preview.group.onlineCount} online · {preview.group.memberCount} members
            </span>
            {preview.inviter && <span>Invited by {preview.inviter.displayName}</span>}
          </div>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
    </ModalFrame>
  );
}

/* ---------------- invite friends ---------------- */

export function InviteModal({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const group = useData((s) => s.groups[groupId]);
  const friends = useData(useShallow((s) => friendIds(s).map((id) => s.users[id]).filter(Boolean)));
  const [invite, setInvite] = useState<{ code: string; url: string } | null>(null);
  const [query, setQuery] = useState('');
  const [sent, setSent] = useState<Record<string, 'sending' | 'sent'>>({});
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getInvite(groupId).then(setInvite).catch((err) => ui.toast(errorMessage(err), 'error'));
  }, [groupId]);

  const list = useMemo(() => {
    const q = query.toLowerCase();
    return friends
      .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.includes(q))
      .sort((a, b) => Number(Boolean(group?.members[a.id])) - Number(Boolean(group?.members[b.id])) || a.displayName.localeCompare(b.displayName));
  }, [friends, query, group]);

  if (!group) return null;
  const copy = () => {
    if (!invite) return;
    void navigator.clipboard.writeText(invite.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <ModalFrame title={`Invite friends to ${group.name}`} onClose={onClose} size="sm">
      <div className="ep-search">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for friends" autoFocus />
        <MagnifyingGlass size={16} className="ep-search-icon" />
      </div>
      <div className="invite-list scroll">
        {list.length === 0 && <div className="side-hint">{friends.length ? 'No friends match that search.' : 'Add some friends first, or share the link below.'}</div>}
        {list.map((u) => {
          const member = Boolean(group.members[u.id]);
          const state = sent[u.id];
          return (
            <div key={u.id} className="invite-row">
              <Avatar user={u} size={32} />
              <span className="invite-row-name truncate">{u.displayName}</span>
              <Button
                size="sm"
                variant={state === 'sent' || member ? 'ghost' : 'secondary'}
                disabled={member || state !== undefined || !invite}
                loading={state === 'sending'}
                onClick={async () => {
                  if (!invite) return;
                  setSent((x) => ({ ...x, [u.id]: 'sending' }));
                  try {
                    await sendInviteTo(u.id, invite.url);
                    setSent((x) => ({ ...x, [u.id]: 'sent' }));
                  } catch (err) {
                    setSent((x) => {
                      const n = { ...x };
                      delete n[u.id];
                      return n;
                    });
                    ui.toast(errorMessage(err), 'error');
                  }
                }}
              >
                {member ? 'Joined' : state === 'sent' ? 'Sent' : 'Invite'}
              </Button>
            </div>
          );
        })}
      </div>
      <div className="ui-field">
        <span className="ui-field-label">Or send them this link</span>
        <div className="copy-field">
          <input readOnly value={invite?.url ?? 'Making a link…'} onFocus={(e) => e.target.select()} />
          <Button size="sm" variant={copied ? 'secondary' : 'primary'} onClick={copy} disabled={!invite} icon={copied ? <Check size={14} weight="bold" /> : <CopySimple size={14} weight="bold" />}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <button
          className="link-btn"
          onClick={() =>
            getInvite(groupId, true)
              .then((i) => {
                setInvite(i);
                ui.toast('Made a new link. The old one no longer works.', 'success');
              })
              .catch((err) => ui.toast(errorMessage(err), 'error'))
          }
        >
          <ArrowsClockwise size={13} weight="bold" /> Make a new link
        </button>
      </div>
    </ModalFrame>
  );
}

/* ---------------- group settings ---------------- */

export function GroupSettingsModal({ groupId, tab: initialTab, onClose }: { groupId: string; tab?: string; onClose: () => void }) {
  const group = useData((s) => s.groups[groupId]);
  const meId = useData((s) => s.me!.id);
  const canGroup = useData((s) => can(s, groupId, PERM.MANAGE_GROUP));
  const canRoles = useData((s) => can(s, groupId, PERM.MANAGE_ROLES));
  const canKick = useData((s) => can(s, groupId, PERM.KICK_MEMBERS));
  const myTop = useData((s) => topPosition(s, groupId, s.me!.id));
  type Tab = 'overview' | 'roles' | 'members' | 'danger';
  const [tab, setTab] = useState<Tab>(() => {
    const wanted = (initialTab as Tab | undefined) ?? 'overview';
    if (wanted === 'overview' && !canGroup) return 'members';
    return wanted;
  });
  const [name, setName] = useState(group?.name ?? '');
  const [busy, setBusy] = useState(false);
  const role = group?.members[meId]?.role;
  const memberMap = useData((s) => s.groups[groupId]?.members);
  const roleMap = useData((s) => s.groups[groupId]?.roles);
  const users = useData((s) => s.users);
  const members = useMemo(
    () =>
      Object.values(memberMap ?? {})
        .map((m) => ({
          m,
          name: displayNameIn(useData.getState(), m.userId, groupId),
          user: users[m.userId],
          top: topPosition(useData.getState(), groupId, m.userId),
          color: memberColor(useData.getState(), groupId, m.userId),
        }))
        .sort((a, b) => b.top - a.top || a.name.localeCompare(b.name)),
    [memberMap, users, groupId, roleMap],
  );
  const roles = useMemo(() => Object.values(roleMap ?? {}).sort((a, b) => b.position - a.position), [roleMap]);
  if (!group) return null;

  const changeIcon = async () => {
    const file = await pickImage();
    if (!file) return;
    const upload = async (blob: Blob, filename: string) => {
      try {
        await setGroupIcon(groupId, blob, filename);
      } catch (err) {
        ui.toast(errorMessage(err), 'error');
        throw err;
      }
    };
    if (keepsAnimation(file)) await upload(file, file.name);
    else ui.openModal('crop', { file, title: 'Group icon', shape: 'rounded', outWidth: 512, onDone: upload });
  };

  const roleMenu = (rect: DOMRect, userId: string) => {
    const has = new Set(useData.getState().groups[groupId]?.members[userId]?.roles ?? []);
    openMenu(
      rect,
      roles.length
        ? [
            { header: 'Roles' },
            ...roles.map((r) => ({
              label: r.name,
              checked: has.has(r.id),
              disabled: r.position >= myTop,
              onSelect: () => void setMemberHasRole(groupId, userId, r.id, !has.has(r.id)).catch((err) => ui.toast(errorMessage(err), 'error')),
            })),
          ]
        : [{ header: 'No roles yet' }, { label: 'Create a role', onSelect: () => setTab('roles') }],
      'end',
    );
  };

  return (
    <ModalFrame title="Group settings" subtitle={group.name} onClose={onClose} size={tab === 'roles' ? 'xl' : 'lg'}>
      <div className="tabs">
        {canGroup && (
          <button className={tab === 'overview' ? 'is-active' : ''} onClick={() => setTab('overview')}>
            Overview
          </button>
        )}
        {canRoles && (
          <button className={tab === 'roles' ? 'is-active' : ''} onClick={() => setTab('roles')}>
            Roles · {roles.length}
          </button>
        )}
        <button className={tab === 'members' ? 'is-active' : ''} onClick={() => setTab('members')}>
          Members · {members.length}
        </button>
        <button className={tab === 'danger' ? 'is-active' : ''} onClick={() => setTab('danger')}>
          {role === 'owner' ? 'Delete group' : 'Leave group'}
        </button>
      </div>

      {tab === 'overview' && canGroup && (
        <div className="gs-overview">
          <div className="gs-icon">
            <button className="icon-upload" onClick={() => void changeIcon()}>
              {group.icon ? <img src={fileUrl(group.icon)} alt="" /> : <span className="rail-initials">{initials(group.name)}</span>}
              <span className="icon-upload-badge">
                <Camera size={14} weight="fill" />
              </span>
            </button>
            {group.icon && (
              <button className="link-btn is-danger" onClick={() => void removeGroupIcon(groupId)}>
                Remove icon
              </button>
            )}
            <span className="muted gs-hint">Animated GIFs work too.</span>
          </div>
          <div className="gs-fields">
            <TextField label="Group name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            <div>
              <Button
                loading={busy}
                disabled={!name.trim() || name.trim() === group.name}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await renameGroup(groupId, name.trim());
                    ui.toast('Saved', 'success');
                  } catch (err) {
                    ui.toast(errorMessage(err), 'error');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}

      {tab === 'roles' && canRoles && <RolesTab groupId={groupId} />}

      {tab === 'members' && (
        <div className="gs-members">
          {members.map(({ m, name: n, user, top, color }) => {
            const outranked = top < myTop;
            const showKick = m.userId !== meId && canKick && m.role !== 'owner' && outranked;
            const showOwnerTools = role === 'owner' && m.userId !== meId;
            return (
              <div key={m.userId} className="gs-member">
                <Avatar user={user} size={36} />
                <div className="gs-member-text">
                  <strong className="truncate" style={{ color }}>
                    {n}
                    {m.role === 'owner' && <Crown size={14} weight="fill" className="role-crown" />}
                    {m.role === 'admin' && <ShieldStar size={14} weight="fill" className="role-shield" />}
                  </strong>
                  <span className="gs-member-roles">
                    {m.roles.length
                      ? m.roles
                          .map((id) => roleMap?.[id])
                          .filter(Boolean)
                          .sort((a, b) => b!.position - a!.position)
                          .map((r) => (
                            <span key={r!.id} className="role-chip">
                              <span className="role-dot" style={{ background: r!.color ?? 'var(--text-4)' }} />
                              {r!.name}
                            </span>
                          ))
                      : user?.username}
                  </span>
                </div>
                {canRoles && roles.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={(e) => roleMenu(e.currentTarget.getBoundingClientRect(), m.userId)}>
                    Roles
                  </Button>
                )}
                {(showKick || showOwnerTools) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={(e) =>
                      openMenu(e.currentTarget.getBoundingClientRect(), [
                        ...(showOwnerTools
                          ? [
                              m.role === 'admin'
                                ? { label: 'Remove admin', onSelect: () => void setMemberRole(groupId, m.userId, 'member').catch((err) => ui.toast(errorMessage(err), 'error')) }
                                : { label: 'Make admin', icon: <ShieldStar size={16} />, onSelect: () => void setMemberRole(groupId, m.userId, 'admin').catch((err) => ui.toast(errorMessage(err), 'error')) },
                              {
                                label: 'Transfer ownership',
                                icon: <Crown size={16} />,
                                onSelect: () =>
                                  ui.openModal('confirm', {
                                    title: `Make ${n} the owner?`,
                                    body: `${n} will own ${group.name}. You'll become an admin.`,
                                    confirmLabel: 'Transfer',
                                    onConfirm: () => transferOwnership(groupId, m.userId),
                                  }),
                              },
                            ]
                          : []),
                        ...(showKick
                          ? [
                              {
                                label: `Kick ${n}`,
                                danger: true,
                                onSelect: () =>
                                  ui.openModal('confirm', {
                                    title: `Kick ${n}?`,
                                    body: 'They can come back if someone invites them again.',
                                    confirmLabel: 'Kick',
                                    danger: true,
                                    onConfirm: () => kickMember(groupId, m.userId),
                                  }),
                              },
                            ]
                          : []),
                      ], 'end')
                    }
                  >
                    Manage
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'danger' && (
        <div className="gs-danger">
          {role === 'owner' ? (
            <>
              <p>Deleting {group.name} removes every channel and message in it for everyone. This can't be undone.</p>
              <Button
                variant="danger"
                icon={<Trash size={16} />}
                onClick={() =>
                  ui.openModal('confirm', {
                    title: `Delete ${group.name}?`,
                    body: 'Every channel and message will be gone for good.',
                    confirmLabel: 'Delete group',
                    danger: true,
                    requireText: group.name,
                    onConfirm: async () => {
                      await deleteGroup(groupId);
                      onClose();
                    },
                  })
                }
              >
                Delete group
              </Button>
              <p className="muted">Want to leave instead? Transfer ownership to someone in the Members tab first.</p>
            </>
          ) : (
            <>
              <p>You won't be able to come back unless someone invites you again.</p>
              <Button
                variant="danger"
                onClick={() =>
                  ui.openModal('confirm', {
                    title: `Leave ${group.name}?`,
                    confirmLabel: 'Leave group',
                    danger: true,
                    onConfirm: async () => {
                      await leaveGroup(groupId);
                      onClose();
                    },
                  })
                }
              >
                Leave group
              </Button>
            </>
          )}
        </div>
      )}
    </ModalFrame>
  );
}

/* ---------------- channels ---------------- */

export function CreateChannelModal({ groupId, type: initialType, onClose }: { groupId: string; type?: 'text' | 'voice'; onClose: () => void }) {
  const [type, setType] = useState<'text' | 'voice'>(initialType ?? 'text');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name;
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createChannel(groupId, name.trim(), type);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame
      title="Create channel"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            Create channel
          </Button>
        </>
      }
    >
      <div className="ui-field">
        <span className="ui-field-label">Channel type</span>
        <div className="type-cards">
          <button className={`type-card${type === 'text' ? ' is-active' : ''}`} onClick={() => setType('text')}>
            <Hash size={24} />
            <span>
              <strong>Text</strong>
              <small>Messages, images, GIFs, emoji and links</small>
            </span>
            <span className="radio" />
          </button>
          <button className={`type-card${type === 'voice' ? ' is-active' : ''}`} onClick={() => setType('voice')}>
            <SpeakerHigh size={24} />
            <span>
              <strong>Voice</strong>
              <small>Hang out with voice, video and screen share</small>
            </span>
            <span className="radio" />
          </button>
        </div>
      </div>
      <TextField
        label="Channel name"
        prefix={type === 'text' ? <Hash size={16} /> : <SpeakerHigh size={16} />}
        value={shown}
        maxLength={48}
        autoFocus
        placeholder={type === 'text' ? 'new-channel' : 'Hangout'}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
      />
      {error && <div className="form-error">{error}</div>}
    </ModalFrame>
  );
}

export function EditChannelModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useData((s) => s.channels[channelId]);
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [busy, setBusy] = useState(false);
  if (!channel) return null;
  const save = async () => {
    setBusy(true);
    try {
      await updateChannel(channelId, { name: name.trim(), topic: topic.trim() });
      onClose();
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame
      title={`Edit ${channel.type === 'text' ? '#' : ''}${channel.name}`}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button
            variant="danger-ghost"
            icon={<Trash size={16} />}
            onClick={() =>
              ui.openModal('confirm', {
                title: `Delete ${channel.type === 'text' ? '#' : ''}${channel.name}?`,
                body: 'This removes the channel and all of its messages for everyone. This cannot be undone.',
                confirmLabel: 'Delete channel',
                danger: true,
                onConfirm: async () => {
                  await deleteChannel(channelId);
                  onClose();
                },
              })
            }
          >
            Delete
          </Button>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <TextField label="Channel name" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} autoFocus />
      {channel.type === 'text' && (
        <div className="ui-field">
          <label className="ui-field-label">Topic</label>
          <textarea className="ui-textarea" value={topic} maxLength={300} placeholder="Let everyone know what this channel is for" onChange={(e) => setTopic(e.target.value)} />
        </div>
      )}
    </ModalFrame>
  );
}

export function TopicModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useData((s) => s.channels[channelId]);
  if (!channel) return null;
  return (
    <ModalFrame title={`#${channel.name}`} onClose={onClose} size="sm">
      <p className="selectable" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
        {channel.topic}
      </p>
    </ModalFrame>
  );
}

