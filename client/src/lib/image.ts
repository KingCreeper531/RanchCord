export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't open that image"));
    img.src = src;
  });
}

export interface Crop {
  /** centre of the crop, in image pixels */
  cx: number;
  cy: number;
  /** side length of the square crop, in image pixels */
  size: number;
}

/** Renders a square crop of the image to a WebP (or PNG fallback) blob. */
export async function cropToBlob(img: HTMLImageElement, crop: Crop, out: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, crop.cx - crop.size / 2, crop.cy - crop.size / 2, crop.size, crop.size, 0, 0, out, out);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.92));
  if (blob && blob.type === 'image/webp') return blob;
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image'))), 'image/png'));
}

export function videoSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = (r: { width: number; height: number } | null) => {
      URL.revokeObjectURL(url);
      resolve(r);
    };
    v.onloadedmetadata = () => done(v.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    v.src = url;
  });
}

/** Fit (w,h) inside (maxW,maxH) keeping aspect ratio, never upscaling. */
export function fit(w: number, h: number, maxW: number, maxH: number) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Shrinks a big photo to at most `maxSide` pixels as WebP (keeps GIFs, which may be animated). */
export async function downscaleImage(file: File, maxSide: number, quality = 0.86): Promise<{ blob: Blob; filename: string }> {
  if (file.type === 'image/gif') return { blob: file, filename: file.name };
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const size = fit(img.naturalWidth, img.naturalHeight, maxSide, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', quality));
    if (blob && blob.type === 'image/webp' && blob.size < file.size) return { blob, filename: file.name.replace(/\.[^.]+$/, '') + '.webp' };
    return { blob: file, filename: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Width and height of a picture without decoding all of it. */
export async function imageSize(file: Blob): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
