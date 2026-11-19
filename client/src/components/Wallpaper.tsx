import { useEffect, useState } from 'react';
import { fileUrl } from '../lib/server';
import { GLASS_DEFAULT, wallpaperCss } from '../lib/wallpapers';
import { useData } from '../store/data';
import { useUi } from '../store/ui';

/** True when the app has a background behind it (your own, or Liquid Glass's colourful default). */
export const useHasWallpaper = () => {
  const glass = useUi((s) => s.prefs.theme === 'glass');
  const own = useData((s) => Boolean(wallpaperCss(s.me?.background)));
  return glass || own;
};

/** The background behind the whole app. */
export function Wallpaper() {
  const own = useData((s) => s.me?.background || null);
  const glass = useUi((s) => s.prefs.theme === 'glass');
  const dim = useUi((s) => s.prefs.wallpaperDim);
  const blur = useUi((s) => s.prefs.wallpaperBlur);
  const background = own && wallpaperCss(own) ? own : glass ? GLASS_DEFAULT : null;
  const css = wallpaperCss(background);
  const isImage = Boolean(background && !background.startsWith('preset:'));
  const [loaded, setLoaded] = useState<string | null>(null);

  // Fade photos in once they've downloaded instead of painting them in strips.
  useEffect(() => {
    if (!isImage || !background) return;
    const img = new Image();
    img.onload = () => setLoaded(background);
    img.src = fileUrl(background);
  }, [isImage, background]);

  if (!css) return null;
  const visible = !isImage || loaded === background;
  return (
    <div className="wallpaper" aria-hidden>
      <div
        className={`wallpaper-img${visible ? ' is-visible' : ''}`}
        style={{ backgroundImage: css, filter: blur ? `blur(${blur}px)` : undefined, inset: blur ? -blur * 2 : 0 }}
      />
      {/* Glass panels already tint what's behind them, so the background stays brighter there. */}
      <div className="wallpaper-dim" style={{ opacity: glass ? dim * 0.45 : dim }} />
    </div>
  );
}
