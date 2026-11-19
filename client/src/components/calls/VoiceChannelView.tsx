import { SpeakerHigh, Users } from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { call } from '../../calls/manager';
import { useBrand } from '../../lib/brand';
import { useCall } from '../../store/call';
import { useData, displayNameIn } from '../../store/data';
import { ui } from '../../store/ui';
import { MobileMenuButton } from '../chat/ChatView';
import { Avatar, Button } from '../ui';
import { CallStage } from './CallStage';

/** A group voice channel. Shows the call stage when connected, or a lobby with who's inside. */
export function VoiceChannelView({ channelId }: { channelId: string }) {
  const channel = useData((s) => s.channels[channelId]);
  const groupName = useData((s) => (channel?.groupId ? s.groups[channel.groupId]?.name : ''));
  const connected = useCall((s) => s.channelId === channelId);
  const brand = useBrand();
  const status = useCall((s) => s.status);
  const inside = useData(useShallow((s) => Object.keys(s.voice[channelId] ?? {})));
  const users = useData(useShallow((s) => inside.map((id) => s.users[id])));
  const names = useData(useShallow((s) => inside.map((id) => displayNameIn(s, id, channel?.groupId))));
  if (!channel) return null;

  if (connected) {
    return (
      <section className="voice-view">
        <header className="chat-header voice-view-header">
          <MobileMenuButton />
          <SpeakerHigh size={22} className="chat-header-hash" />
          <span className="chat-header-name truncate">{channel.name}</span>
          <span className="chat-header-sub truncate">{groupName}</span>
          <span className="voice-view-count">
            <Users size={16} weight="bold" /> {inside.length || 1}
          </span>
        </header>
        <CallStage channelId={channelId} variant="channel" />
      </section>
    );
  }

  return (
    <section className="voice-view voice-lobby">
      <header className="chat-header voice-view-header">
        <MobileMenuButton />
        <SpeakerHigh size={22} className="chat-header-hash" />
        <span className="chat-header-name truncate">{channel.name}</span>
        <span className="chat-header-sub truncate">{groupName}</span>
      </header>
      <div className="voice-lobby-body">
        <div className="voice-lobby-faces">
          {users.length ? (
            users.slice(0, 8).map((u, i) => <Avatar key={inside[i]} user={u} size={64} />)
          ) : (
            <img src={brand.logo} alt="" className="voice-lobby-mascot" />
          )}
        </div>
        <h2>{channel.name}</h2>
        <p>{inside.length ? `${names.slice(0, 3).join(', ')}${inside.length > 3 ? ` and ${inside.length - 3} more` : ''} ${inside.length === 1 ? 'is' : 'are'} hanging out` : 'No one is here yet.'}</p>
        <div className="voice-lobby-actions">
          <Button size="lg" loading={status === 'joining'} onClick={() => void call.join(channelId)}>
            Join voice
          </Button>
          <Button size="lg" variant="secondary" onClick={() => void call.join(channelId, { video: true })}>
            Join with camera
          </Button>
        </div>
        <button className="voice-lobby-invite" onClick={() => ui.openModal('invite', { groupId: channel.groupId })}>
          Invite friends to {groupName}
        </button>
      </div>
    </section>
  );
}
