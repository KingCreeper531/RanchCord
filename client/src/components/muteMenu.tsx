import { Bell, BellSlash } from '@phosphor-icons/react';
import { muteTarget, unmuteTarget } from '../lib/actions';
import { errorMessage } from '../lib/api';
import { mutedUntil, useData } from '../store/data';
import { ui } from '../store/ui';
import { openMenu, type MenuItem } from './ui';

export const MUTE_CHOICES: { label: string; minutes: number | null }[] = [
  { label: 'For 15 minutes', minutes: 15 },
  { label: 'For 1 hour', minutes: 60 },
  { label: 'For 8 hours', minutes: 8 * 60 },
  { label: 'For 24 hours', minutes: 24 * 60 },
  { label: 'Until I turn it back on', minutes: null },
];

const showError = (err: unknown) => ui.toast(errorMessage(err), 'error');

/** "Muted until 3:45 PM", "Muted until Tue 9:00 AM" or just "Muted". */
export function mutedLabel(until: number | null | undefined): string {
  if (until === undefined) return '';
  if (until === null) return 'Muted';
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `Muted until ${time}`;
  return `Muted until ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

type Where = { clientX: number; clientY: number } | DOMRect;

/**
 * The "Mute …" or "Unmute …" menu item for a DM, channel or group. Muting asks how long in a
 * second menu, opened at the same spot.
 */
export function muteMenuItem(where: Where, targetId: string, what: string): MenuItem {
  const until = mutedUntil(useData.getState(), targetId);
  if (until !== undefined) {
    return { label: `Unmute ${what}`, icon: <Bell size={16} />, onSelect: () => void unmuteTarget(targetId).catch(showError) };
  }
  // Keep only the position: React reuses event objects, and the menu opens after this one closes.
  const pos = 'clientX' in where ? { clientX: where.clientX, clientY: where.clientY } : where;
  return {
    label: `Mute ${what}`,
    icon: <BellSlash size={16} />,
    onSelect: () =>
      openMenu(pos, [
        { header: `Mute ${what}` },
        ...MUTE_CHOICES.map((c) => ({ label: c.label, onSelect: () => void muteTarget(targetId, c.minutes).catch(showError) })),
      ]),
  };
}
