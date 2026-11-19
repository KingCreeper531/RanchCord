import { useState } from 'react';
import { Check, Prohibit, UploadSimple } from '@phosphor-icons/react';
import { setBackground, uploadBackground } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { downscaleImage } from '../../lib/image';
import { WALLPAPER_PRESETS, wallpaperCss } from '../../lib/wallpapers';
import { useData } from '../../store/data';
import { ui, useUi } from '../../store/ui';
import { Slider, Spinner } from '../ui';
import { pickImage } from '../modals/ImageCrop';
import { Section } from './parts';

/** Appearance → Background: presets, your own photo, and how dark/blurry it is. */
export function BackgroundPicker() {
  const background = useData((s) => s.me?.background || null);
  const dim = useUi((s) => s.prefs.wallpaperDim);
  const blur = useUi((s) => s.prefs.wallpaperBlur);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const custom = background && !background.startsWith('preset:') ? background : null;
  const css = wallpaperCss(background);

  const apply = async (value: string | null, id: string) => {
    if (busy || value === background) return;
    setBusy(id);
    try {
      await setBackground(value);
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const uploadOwn = async () => {
    const file = await pickImage();
    if (!file) return;
    setBusy('upload');
    setProgress(0);
    try {
      const { blob, filename } = await downscaleImage(file, 2560);
      await uploadBackground(blob, filename, setProgress);
      ui.toast('Background set', 'success');
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <>
      <Section title="Background" hint="Your own background behind the whole app. Only you see it, and it follows you to every device.">
        <div className="bg-layout">
          <div className="bg-preview" aria-hidden>
            {css && (
              <>
                <div className="bg-preview-img" style={{ backgroundImage: css, filter: blur ? `blur(${blur / 2}px)` : undefined, inset: blur ? -blur : 0 }} />
                <div className="bg-preview-dim" style={{ opacity: dim }} />
              </>
            )}
            <div className="bg-preview-msgs">
              <div className="bg-preview-msg">
                <i />
                <span>
                  <b>carrotstick</b>
                  who's bringing the ranch tonight
                </span>
              </div>
              <div className="bg-preview-msg">
                <i className="is-b" />
                <span>
                  <b>wingnight</b>
                  me obviously, a whole gallon
                </span>
              </div>
            </div>
          </div>
          <div className="bg-grid">
            <button className={`bg-tile bg-tile-plain${!background ? ' is-active' : ''}`} onClick={() => void apply(null, 'none')} aria-label="No background">
              <Prohibit size={22} />
              <span>None</span>
            </button>
            {custom && (
              <button className="bg-tile is-active" style={{ backgroundImage: wallpaperCss(custom)! }} aria-label="Your photo">
                <span>Your photo</span>
                <Check size={16} weight="bold" className="bg-tile-check" />
              </button>
            )}
            {WALLPAPER_PRESETS.map((p) => {
              const active = background === `preset:${p.id}`;
              return (
                <button key={p.id} className={`bg-tile${active ? ' is-active' : ''}`} style={{ backgroundImage: p.css }} onClick={() => void apply(`preset:${p.id}`, p.id)} aria-label={p.name}>
                  <span>{p.name}</span>
                  {busy === p.id ? <Spinner size={16} className="bg-tile-check" /> : active && <Check size={16} weight="bold" className="bg-tile-check" />}
                </button>
              );
            })}
            <button className="bg-tile bg-tile-plain" onClick={() => void uploadOwn()} disabled={busy === 'upload'}>
              {busy === 'upload' ? <Spinner size={20} /> : <UploadSimple size={22} />}
              <span>{progress !== null ? `${Math.round(progress * 100)}%` : 'Your photo'}</span>
            </button>
          </div>
        </div>
      </Section>
      {background && (
        <>
          <Section title={`Darken · ${Math.round(dim * 100)}%`}>
            <Slider value={dim} min={0} max={0.9} step={0.05} onChange={(v) => ui.setPrefs({ wallpaperDim: v })} label="Darken background" />
          </Section>
          <Section title={`Blur · ${blur}px`}>
            <Slider value={blur} min={0} max={24} step={1} onChange={(v) => ui.setPrefs({ wallpaperBlur: v })} label="Blur background" />
          </Section>
        </>
      )}
    </>
  );
}
