import { Gear } from '@phosphor-icons/react';
import { call } from '../../calls/manager';
import { listDevices } from '../../calls/media';
import { ui, useUi } from '../../store/ui';
import { openMenu, type MenuItem } from '../ui';

export type DeviceKind = 'input' | 'output' | 'camera';

const TITLE: Record<DeviceKind, string> = { input: 'Microphone', output: 'Speakers / headphones', camera: 'Camera' };
const UNNAMED: Record<DeviceKind, string> = { input: 'Microphone', output: 'Speaker', camera: 'Camera' };

/** Phones and Safari can't pick where sound plays; the phone or the system decides. */
export const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

function choose(kind: DeviceKind, id: string) {
  if (kind === 'input') {
    ui.setCallPrefs({ inputId: id });
    void call.switchMic();
  } else if (kind === 'output') {
    ui.setCallPrefs({ outputId: id });
    call.setOutputDevice(id);
  } else {
    ui.setCallPrefs({ cameraId: id });
    void call.switchCamera();
  }
}

/**
 * A quick menu to switch microphone, speakers/headphones or camera, like Discord's. The change
 * applies straight away, mid-call too, and is remembered like the one in Voice & video settings.
 */
export async function openDeviceMenu(kind: DeviceKind, at: DOMRect | { clientX: number; clientY: number }) {
  const prefs = useUi.getState().prefs.call;
  const current = kind === 'input' ? prefs.inputId : kind === 'output' ? prefs.outputId : prefs.cameraId;
  const all = await listDevices();
  const raw = kind === 'input' ? all.inputs : kind === 'output' ? all.outputs : all.cameras;
  const list = raw.filter(
    // Chrome adds "default" and "communications" stand-ins; "Default" below covers them.
    (d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications',
  );
  // Until you've let RanchCord use your mic/camera, browsers hide which devices you have.
  const hidden = raw.some((d) => !d.deviceId || !d.label);
  const items: MenuItem[] = [{ header: TITLE[kind] }];
  if (kind === 'output' && !canPickOutput) {
    items.push({ label: 'This device picks where sound plays', disabled: true, onSelect: () => {} });
  } else {
    if (kind !== 'camera') items.push({ label: 'Default', checked: !current, onSelect: () => choose(kind, '') });
    list.forEach((d, i) =>
      items.push({
        label: d.label || `${UNNAMED[kind]} ${i + 1}`,
        checked: current === d.deviceId || (kind === 'camera' && !current && i === 0),
        onSelect: () => choose(kind, d.deviceId),
      }),
    );
    if (hidden) {
      items.push({
        label: 'Show my devices',
        onSelect: () => {
          // Asking once for access reveals the list; then show the menu again.
          navigator.mediaDevices
            .getUserMedia(kind === 'camera' ? { video: true } : { audio: true })
            .then((s) => {
              s.getTracks().forEach((t) => t.stop());
              void openDeviceMenu(kind, at);
            })
            .catch(() => ui.toast(`RanchCord needs ${kind === 'camera' ? 'camera' : 'microphone'} access to list your devices.`, 'error'));
        },
      });
    } else if (!list.length) {
      items.push({ label: kind === 'camera' ? 'No camera found' : 'Nothing found', disabled: true, onSelect: () => {} });
    }
  }
  items.push({ separator: true }, { label: 'Voice & video settings', icon: <Gear size={16} />, onSelect: () => ui.openModal('settings', { tab: 'voice' }) });
  openMenu(at, items, 'end');
}
