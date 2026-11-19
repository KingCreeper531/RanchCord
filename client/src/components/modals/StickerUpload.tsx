import { useEffect, useState } from 'react';
import { PencilSimple, Sticker as StickerIcon } from '@phosphor-icons/react';
import { renameSticker, uploadSticker } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { fileUrl } from '../../lib/server';
import { useData } from '../../store/data';
import { ui } from '../../store/ui';
import { Button, ModalFrame, TextField } from '../ui';
import { keepsAnimation, pickImage } from './ImageCrop';

/** Stickers are shown at most this big, so still pictures are shrunk to it (keeping transparency). */
const STICKER_PX = 320;
const MAX_BYTES = 4 * 1024 * 1024;

async function shrink(file: File): Promise<Blob> {
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    img.src = url;
    await img.decode();
    const scale = Math.min(1, STICKER_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    return out ?? file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Upload a new sticker, or rename one (renameId). */
export function StickerUploadModal({ renameId, onClose }: { renameId?: string; onClose: () => void }) {
  const existing = useData((s) => (renameId ? s.stickers[renameId] : undefined));
  const [file, setFile] = useState<{ blob: Blob; url: string; filename: string } | null>(null);
  const [name, setName] = useState(existing?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (file) URL.revokeObjectURL(file.url);
    },
    [file],
  );

  const choose = async () => {
    const picked = await pickImage();
    if (!picked) return;
    setError(null);
    const blob = keepsAnimation(picked) ? picked : await shrink(picked).catch(() => picked);
    if (blob.size > MAX_BYTES) {
      setError('That picture is too big for a sticker (4 MB max)');
      return;
    }
    const filename = keepsAnimation(picked) ? picked.name : picked.name.replace(/\.[^.]+$/, '') + (blob.type === 'image/webp' ? '.webp' : '.png');
    setFile({ blob, url: URL.createObjectURL(blob), filename });
    if (!name) setName(picked.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 32));
  };

  const submit = async () => {
    if (!name.trim() || (!existing && !file)) return;
    setBusy(true);
    setError(null);
    try {
      if (existing) await renameSticker(existing.id, name.trim());
      else await uploadSticker(name.trim(), file!.blob, file!.filename);
      ui.toast(existing ? 'Sticker renamed' : 'Sticker added. Everyone here can use it now.', 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const preview = file?.url ?? (existing ? fileUrl(existing.url) : null);
  return (
    <ModalFrame
      title={existing ? 'Rename sticker' : 'Upload a sticker'}
      subtitle={existing ? undefined : 'Any picture or GIF works. Everyone on this server can use it.'}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!name.trim() || (!existing && !file)} onClick={() => void submit()}>
            {existing ? 'Save' : 'Add sticker'}
          </Button>
        </>
      }
    >
      <div className="sticker-upload">
        <button className="sticker-upload-drop" onClick={() => !existing && void choose()} disabled={Boolean(existing)}>
          {preview ? (
            <img src={preview} alt="" />
          ) : (
            <span>
              <StickerIcon size={36} weight="duotone" />
              Choose a picture
            </span>
          )}
        </button>
        {file && !existing && (
          <button className="link-btn" onClick={() => void choose()}>
            <PencilSimple size={13} /> Pick a different picture
          </button>
        )}
      </div>
      <TextField
        label="Sticker name"
        value={name}
        maxLength={32}
        placeholder="Ranch dance"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
      />
      {error && <div className="form-error">{error}</div>}
    </ModalFrame>
  );
}
