import { fileUrl } from './server';

/** Built-in backgrounds (soft mesh gradients). Stored on the account as `preset:<id>`. */
export const WALLPAPER_PRESETS: { id: string; name: string; css: string }[] = [
  {
    id: 'liquid',
    name: 'Liquid',
    css: 'radial-gradient(60% 55% at 15% 20%, #ff7eb3 0%, transparent 60%), radial-gradient(55% 50% at 85% 15%, #7afcff 0%, transparent 60%), radial-gradient(70% 60% at 70% 90%, #7b61ff 0%, transparent 65%), radial-gradient(60% 60% at 15% 95%, #ffd36e 0%, transparent 60%), linear-gradient(135deg, #1b2a6b, #3a1c71)',
  },
  {
    id: 'ranch',
    name: 'Ranch Sky',
    css: 'radial-gradient(120% 90% at 10% 0%, #39b5e0 0%, transparent 55%), radial-gradient(90% 80% at 100% 100%, #5cc443 0%, transparent 55%), linear-gradient(160deg, #2c6fcb, #183f7a)',
  },
  {
    id: 'meadow',
    name: 'Meadow',
    css: 'radial-gradient(80% 70% at 15% 15%, #d4f06b 0%, transparent 60%), radial-gradient(90% 80% at 85% 20%, #5cc443 0%, transparent 60%), radial-gradient(100% 90% at 50% 100%, #1f7a4a 0%, transparent 70%), linear-gradient(180deg, #2f8f5b, #0f3d27)',
  },
  {
    id: 'sunset',
    name: 'Sunset',
    css: 'radial-gradient(90% 80% at 20% 10%, #ffcf6b 0%, transparent 55%), radial-gradient(90% 90% at 90% 30%, #ff6f91 0%, transparent 60%), radial-gradient(100% 100% at 40% 100%, #6a3cbc 0%, transparent 65%), linear-gradient(160deg, #ff9a5a, #4b1f6f)',
  },
  {
    id: 'ocean',
    name: 'Deep Ocean',
    css: 'radial-gradient(80% 70% at 80% 10%, #3ee0d0 0%, transparent 55%), radial-gradient(100% 90% at 10% 90%, #1b4fd6 0%, transparent 60%), linear-gradient(180deg, #0b3a5c, #061b33)',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    css: 'radial-gradient(70% 60% at 25% 20%, #3cf5a0 0%, transparent 55%), radial-gradient(70% 70% at 75% 35%, #8a5cff 0%, transparent 60%), radial-gradient(90% 80% at 50% 100%, #0d6e7a 0%, transparent 70%), linear-gradient(180deg, #0b1630, #050913)',
  },
  {
    id: 'candy',
    name: 'Cotton Candy',
    css: 'radial-gradient(80% 80% at 10% 10%, #ffb3d9 0%, transparent 60%), radial-gradient(80% 80% at 90% 20%, #a0c4ff 0%, transparent 60%), radial-gradient(90% 90% at 50% 100%, #caffbf 0%, transparent 65%), linear-gradient(135deg, #ffd6e8, #c9d8ff)',
  },
  {
    id: 'ember',
    name: 'Ember',
    css: 'radial-gradient(80% 70% at 30% 100%, #ff5e3a 0%, transparent 60%), radial-gradient(70% 60% at 90% 10%, #ffb347 0%, transparent 55%), linear-gradient(180deg, #2a0f0a, #120605)',
  },
  {
    id: 'lavender',
    name: 'Lavender',
    css: 'radial-gradient(90% 80% at 20% 20%, #c3a6ff 0%, transparent 60%), radial-gradient(80% 80% at 90% 80%, #ff9ecf 0%, transparent 60%), linear-gradient(160deg, #7b5cd6, #3a2470)',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    css: 'radial-gradient(60% 50% at 80% 15%, #4a5cff 0%, transparent 60%), radial-gradient(80% 70% at 10% 90%, #9b3cff 0%, transparent 65%), linear-gradient(180deg, #0c0f2e, #04050f)',
  },
  {
    id: 'mint',
    name: 'Mint',
    css: 'radial-gradient(80% 80% at 15% 20%, #b9fbc0 0%, transparent 60%), radial-gradient(80% 80% at 85% 80%, #98f5e1 0%, transparent 60%), linear-gradient(135deg, #8eecf5, #4cc9a7)',
  },
];

/** Liquid Glass needs something colourful behind it, so it uses this when you haven't picked one. */
export const GLASS_DEFAULT = 'preset:liquid';

/** CSS background-image for a saved background, or null for none. */
export function wallpaperCss(background: string | null | undefined): string | null {
  if (!background) return null;
  if (background.startsWith('preset:')) return WALLPAPER_PRESETS.find((p) => p.id === background.slice(7))?.css ?? null;
  return `url("${fileUrl(background).replace(/"/g, '%22')}")`;
}
