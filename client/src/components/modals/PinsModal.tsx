import { useEffect, useMemo, useState } from 'react';
import { PushPin } from '@phosphor-icons/react';
import { loadPins, unpinMessage } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { formatTimestamp } from '../../lib/format';
import { InlineMarkdown } from '../../lib/markdown';
import { PERM, can } from '../../lib/perms';
import { displayNameIn, useData } from '../../store/data';
import { ui } from '../../store/ui';
import type { Message } from '../../types';
import { Avatar, Button, ModalFrame, Spinner } from '../ui';

/** Every pinned message in a channel or DM, newest pin first. */
export function PinsModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const groupId = useData((s) => s.channels[channelId]?.groupId ?? null);
  const canPin = useData((s) => !groupId || can(s, groupId, PERM.MANAGE_MESSAGES));
  // Reload when someone pins or unpins while this is open.
  const pinKey = useData((s) =>
    (s.messages[channelId]?.list ?? [])
      .filter((m) => m.pinnedAt)
      .map((m) => m.id)
      .join(','),
  );
  const [pins, setPins] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadPins(channelId)
      .then((list) => live && setPins(list))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [channelId, pinKey]);

  const names = useMemo(() => {
    const s = useData.getState();
    return new Map((pins ?? []).map((m) => [m.author.id, displayNameIn(s, m.author.id, groupId)]));
  }, [pins, groupId]);

  return (
    <ModalFrame title="Pinned messages" onClose={onClose} size="md">
      {error && <div className="form-error">{error}</div>}
      {!pins && !error && (
        <div className="gs-loading">
          <Spinner />
        </div>
      )}
      {pins?.length === 0 && (
        <div className="gs-empty">
          <PushPin size={32} weight="duotone" />
          <p>Nothing pinned yet. {canPin ? 'Pin a message from its menu to keep it handy here.' : 'Pinned messages show up here.'}</p>
        </div>
      )}
      <div className="pins">
        {pins?.map((m) => (
          <div key={m.id} className="pin">
            <Avatar user={m.author} size={32} />
            <div className="pin-body">
              <div className="pin-head">
                <strong>{names.get(m.author.id) ?? m.author.displayName}</strong>
                <time>{formatTimestamp(m.createdAt)}</time>
              </div>
              <div className="pin-text">
                {m.content ? <InlineMarkdown content={m.content} groupId={groupId} /> : <span className="muted">{m.attachments.length ? 'Sent a file' : m.embeds.length ? 'Sent a GIF or sticker' : ''}</span>}
              </div>
            </div>
            <div className="pin-actions">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onClose();
                  ui.jumpToMessage(channelId, m.id);
                }}
              >
                Jump
              </Button>
              {canPin && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void unpinMessage(channelId, m.id)
                      .then(() => setPins((list) => list?.filter((x) => x.id !== m.id) ?? null))
                      .catch((err) => ui.toast(errorMessage(err), 'error'))
                  }
                >
                  Unpin
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </ModalFrame>
  );
}
