import { useEffect, useRef, useState } from 'react';
import { MagnifyingGlassMinus, MagnifyingGlassPlus } from '@phosphor-icons/react';
import { Button, ModalFrame, Slider } from '../ui';

export interface CropOptions {
  file: File;
  title?: string;
  /** width / height of the result */
  aspect?: number;
  shape?: 'circle' | 'rounded' | 'square';
  outWidth?: number;
  onDone: (blob: Blob, filename: string) => Promise<void> | void;
}

/** True for GIFs, which we upload untouched so they stay animated (free "Nitro" perk). */
export const keepsAnimation = (file: File) => file.type === 'image/gif';

export function ImageCropModal({ file, title = 'Edit image', aspect = 1, shape = 'square', outWidth = 512, onDone, onClose }: CropOptions & { onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const viewW = aspect >= 1 ? 340 : 340 * aspect;
  const viewH = viewW / aspect;
  const animated = keepsAnimation(file);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    const image = new Image();
    image.onload = () => {
      setImg(image);
      const s0 = Math.max(viewW / image.naturalWidth, viewH / image.naturalHeight);
      setOffset({ x: (viewW - image.naturalWidth * s0) / 2, y: (viewH - image.naturalHeight * s0) / 2 });
    };
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file, viewW, viewH]);

  const base = img ? Math.max(viewW / img.naturalWidth, viewH / img.naturalHeight) : 1;
  const scale = base * zoom;
  const dispW = (img?.naturalWidth ?? 0) * scale;
  const dispH = (img?.naturalHeight ?? 0) * scale;
  const clamp = (o: { x: number; y: number }, w = dispW, h = dispH) => ({
    x: Math.min(0, Math.max(viewW - w, o.x)),
    y: Math.min(0, Math.max(viewH - h, o.y)),
  });

  const setZoomKeepCenter = (z: number) => {
    if (!img) return;
    const ns = base * z;
    const cx = (viewW / 2 - offset.x) / scale;
    const cy = (viewH / 2 - offset.y) / scale;
    const next = { x: viewW / 2 - cx * ns, y: viewH / 2 - cy * ns };
    setZoom(z);
    setOffset(clamp(next, img.naturalWidth * ns, img.naturalHeight * ns));
  };

  const apply = async () => {
    setBusy(true);
    try {
      if (animated || !img) {
        await onDone(file, file.name);
      } else {
        const outH = Math.round(outWidth / aspect);
        const canvas = document.createElement('canvas');
        canvas.width = outWidth;
        canvas.height = outH;
        const g = canvas.getContext('2d')!;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, -offset.x / scale, -offset.y / scale, viewW / scale, viewH / scale, 0, 0, outWidth, outH);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.92));
        const final = blob && blob.type === 'image/webp' ? blob : await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
        await onDone(final, final.type === 'image/webp' ? 'image.webp' : 'image.png');
      }
      onClose();
    } catch {
      /* the caller shows the error */
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title={title}
      subtitle={animated ? "Animated GIFs stay animated, so they're used as-is." : 'Drag to move, use the slider to zoom.'}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!img && !animated} onClick={() => void apply()}>
            Apply
          </Button>
        </>
      }
    >
      <div className="crop">
        <div
          className={`crop-view crop-${shape}`}
          style={{ width: viewW, height: viewH }}
          onPointerDown={(e) => {
            if (animated) return;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            setOffset(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
          }}
          onPointerUp={() => (drag.current = null)}
          onWheel={(e) => !animated && setZoomKeepCenter(Math.min(4, Math.max(1, zoom - e.deltaY * 0.002)))}
        >
          {src &&
            (animated ? (
              <img src={src} alt="" className="crop-animated" draggable={false} />
            ) : (
              img && <img src={src} alt="" draggable={false} style={{ width: dispW, height: dispH, transform: `translate(${offset.x}px, ${offset.y}px)` }} />
            ))}
        </div>
        {!animated && (
          <div className="crop-zoom">
            <MagnifyingGlassMinus size={18} />
            <Slider value={zoom} min={1} max={4} step={0.01} onChange={setZoomKeepCenter} label="Zoom" />
            <MagnifyingGlassPlus size={18} />
          </div>
        )}
      </div>
    </ModalFrame>
  );
}

/** Opens a file chooser and returns the picked image file. */
export function pickImage(accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
