const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const numericDateFmt = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function sameDay(a: number, b: number) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export const formatTime = (ms: number) => timeFmt.format(ms);
export const formatDate = (ms: number) => dateFmt.format(ms);
export const formatShortDate = (ms: number) => shortDateFmt.format(ms);
export const formatFull = (ms: number) => fullFmt.format(ms);

export function formatTimestamp(ms: number) {
  const now = Date.now();
  if (sameDay(ms, now)) return `Today at ${formatTime(ms)}`;
  if (sameDay(ms, now - 86_400_000)) return `Yesterday at ${formatTime(ms)}`;
  return `${numericDateFmt.format(ms)} ${formatTime(ms)}`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return h ? `${h}:${mm}:${String(sec).padStart(2, '0')}` : `${mm}:${String(sec).padStart(2, '0')}`;
}

export const formatFriendCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function nonce() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return [...words[0]].slice(0, 2).join('');
  return words
    .slice(0, 3)
    .map((w) => [...w][0])
    .join('');
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
