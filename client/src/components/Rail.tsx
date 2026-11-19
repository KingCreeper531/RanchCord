import { memo } from 'react';
import { DownloadSimple, Plus } from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { fileUrl } from '../lib/server';
import { useBrand } from '../lib/brand';
import { initials } from '../lib/format';
import { isDesktopApp, isNative } from '../lib/platform';
import { dmRecipient, groupUnread, mentionCount, useData } from '../store/data';
import { ui, useUi } from '../store/ui';
import { Avatar, Tooltip, openMenu } from './ui';
import { markGroupRead } from './Sidebar';

function Pill({ state }: { state: 'active' | 'unread' | 'none' }) {
  return <span className={`rail-pill rail-pill-${state}`} />;
}

const GroupIcon = memo(function GroupIcon({ groupId }: { groupId: string }) {
  const group = useData((s) => s.groups[groupId]);
  const { unread, mentions } = useData(useShallow((s) => groupUnread(s, groupId)));
  const inVoice = useData((s) => {
    const g = s.groups[groupId];
    return Boolean(g && g.channelIds.some((id) => s.channels[id]?.type === 'voice' && s.voice[id] && Object.keys(s.voice[id]).length));
  });
  const active = useUi((s) => s.route.kind === 'group' && s.route.groupId === groupId);
  if (!group) return null;
  const open = () => {
    const last = useUi.getState().prefs.lastChannelByGroup[groupId];
    const s = useData.getState();
    const valid = last && s.channels[last] ? last : group.channelIds.find((id) => s.channels[id]?.type === 'text') ?? null;
    ui.navigate({ kind: 'group', groupId, channelId: valid });
  };
  return (
    <div className="rail-item">
      <Pill state={active ? 'active' : unread ? 'unread' : 'none'} />
      <Tooltip label={group.name} side="right">
        <button
          className={`rail-btn${active ? ' is-active' : ''}${group.icon ? ' has-image' : ''}`}
          onClick={open}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(e, [
              { label: 'Mark as read', onSelect: () => markGroupRead(groupId), disabled: !unread && !mentions },
              { label: 'Invite people', onSelect: () => ui.openModal('invite', { groupId }) },
            ]);
          }}
          aria-label={group.name}
        >
          {group.icon ? (
            <img src={fileUrl(group.icon)} alt="" draggable={false} />
          ) : (
            <span className="rail-initials">{initials(group.name)}</span>
          )}
        </button>
      </Tooltip>
      {mentions > 0 && <span className="ui-badge rail-badge">{mentions > 99 ? '99+' : mentions}</span>}
      {inVoice && !mentions && <span className="rail-voice-dot" />}
    </div>
  );
});

function UnreadDms() {
  const ids = useData(
    useShallow((s) =>
      s.dmIds
        .filter((id) => mentionCount(s, id) > 0)
        .sort((a, b) => ((s.channels[a]?.lastMessageId ?? '') < (s.channels[b]?.lastMessageId ?? '') ? 1 : -1)),
    ),
  );
  return (
    <>
      {ids.map((id) => (
        <UnreadDm key={id} channelId={id} />
      ))}
    </>
  );
}

function UnreadDm({ channelId }: { channelId: string }) {
  const user = useData((s) => dmRecipient(s, channelId));
  const count = useData((s) => mentionCount(s, channelId));
  return (
    <div className="rail-item rail-dm">
      <Pill state="unread" />
      <Tooltip label={user?.displayName ?? 'Direct message'} side="right">
        <button className="rail-btn has-image" onClick={() => ui.navigate({ kind: 'dm', channelId })}>
          <Avatar user={user} size={48} />
        </button>
      </Tooltip>
      <span className="ui-badge rail-badge">{count > 99 ? '99+' : count}</span>
    </div>
  );
}

export function Rail() {
  const groupOrder = useData((s) => s.groupOrder);
  const homeActive = useUi((s) => s.route.kind !== 'group');
  const downloads = useData((s) => s.instance?.downloads);
  const showDownloads = !isNative && !isDesktopApp && downloads && Object.keys(downloads).length > 0;
  const friendRequests = useData((s) => Object.values(s.relationships).filter((r) => r.type === 3).length);
  const brand = useBrand();
  return (
    <nav className="rail scroll-hidden" aria-label="Groups">
      <div className="rail-item">
        <Pill state={homeActive ? 'active' : 'none'} />
        <Tooltip label="Direct Messages" side="right">
          <button
            className={`rail-btn rail-home${homeActive ? ' is-active' : ''}`}
            onClick={() => {
              const r = useUi.getState().route;
              if (r.kind === 'group') ui.navigate({ kind: 'friends' });
              else ui.setMobilePane('main');
            }}
            aria-label="Home"
          >
            <img src={brand.logo} alt="" draggable={false} />
          </button>
        </Tooltip>
        {friendRequests > 0 && <span className="ui-badge rail-badge">{friendRequests}</span>}
      </div>
      <UnreadDms />
      <div className="rail-sep" />
      {groupOrder.map((id) => (
        <GroupIcon key={id} groupId={id} />
      ))}
      <div className="rail-item">
        <Tooltip label="Add a group" side="right">
          <button className="rail-btn rail-action" onClick={() => ui.openModal('addGroup')} aria-label="Add a group">
            <Plus size={22} weight="bold" />
          </button>
        </Tooltip>
      </div>
      {showDownloads && (
        <div className="rail-item">
          <Tooltip label="Download the apps" side="right">
            <button className="rail-btn rail-action" onClick={() => ui.openModal('downloads')} aria-label="Download the apps">
              <DownloadSimple size={22} weight="bold" />
            </button>
          </Tooltip>
        </div>
      )}
    </nav>
  );
}
