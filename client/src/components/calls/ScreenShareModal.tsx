import { useState } from 'react';
import { Monitor } from '@phosphor-icons/react';
import { call } from '../../calls/manager';
import type { ScreenShareChoice } from '../../lib/platform';
import { Button, ModalFrame, Switch } from '../ui';

const RESOLUTIONS: { value: ScreenShareChoice['resolution']; label: string }[] = [
  { value: '720', label: '720p' },
  { value: '1080', label: '1080p' },
  { value: 'source', label: 'Source' },
];
const RATES: ScreenShareChoice['fps'][] = [15, 30, 60];

/** Browser screen share: pick quality first, then the browser asks which screen (Entire Screen is the default). */
export function ScreenShareModal({ onClose }: { onClose: () => void }) {
  const [choice, setChoice] = useState<ScreenShareChoice>(() => {
    try {
      return { resolution: '1080', fps: 30, audio: true, ...JSON.parse(localStorage.getItem('rc.screenChoice') ?? '{}') };
    } catch {
      return { resolution: '1080', fps: 30, audio: true };
    }
  });
  const go = () => {
    localStorage.setItem('rc.screenChoice', JSON.stringify(choice));
    onClose();
    void call.startScreen(choice);
  };
  return (
    <ModalFrame
      title="Share your screen"
      subtitle="Share your entire screen, a window, or a tab. Everything is HD for free."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon={<Monitor size={16} weight="fill" />} onClick={go}>
            Go Live
          </Button>
        </>
      }
    >
      <div className="ss-group">
        <span className="ui-field-label">Resolution</span>
        <div className="seg">
          {RESOLUTIONS.map((r) => (
            <button key={r.value} className={choice.resolution === r.value ? 'is-active' : ''} onClick={() => setChoice({ ...choice, resolution: r.value })}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="ss-group">
        <span className="ui-field-label">Frame rate</span>
        <div className="seg">
          {RATES.map((r) => (
            <button key={r} className={choice.fps === r ? 'is-active' : ''} onClick={() => setChoice({ ...choice, fps: r })}>
              {r} FPS
            </button>
          ))}
        </div>
      </div>
      <label className="setting-row">
        <span>
          <strong>Share sound</strong>
          <small>Sends what your computer is playing. Works when sharing an entire screen or a tab.</small>
        </span>
        <Switch checked={choice.audio} onChange={(audio) => setChoice({ ...choice, audio })} label="Share sound" />
      </label>
    </ModalFrame>
  );
}
