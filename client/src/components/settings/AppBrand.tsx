import { useState } from 'react';
import { Image as ImageIcon } from '@phosphor-icons/react';
import { errorMessage } from '../../lib/api';
import { type PersonalBrand, setPersonalBrand, useBrand, usePersonalBrand } from '../../lib/brand';
import { ui } from '../../store/ui';
import { Button, TextField } from '../ui';
import { keepsAnimation, pickImage } from '../modals/ImageCrop';
import { Section } from './parts';

/** Animated GIF icons are kept as they are, so they need a size cap to fit in the device's storage. */
const MAX_ICON_BYTES = 1.5 * 1024 * 1024;

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read that picture"));
    reader.readAsDataURL(blob);
  });
}

function save(patch: Partial<Record<keyof PersonalBrand, string | undefined>>): boolean {
  try {
    setPersonalBrand(patch);
    return true;
  } catch (err) {
    ui.toast(errorMessage(err), 'error');
    return false;
  }
}

/** Appearance → your own name and icon for the app. Only changes it for you, on this device. */
export function AppBrandSection() {
  const mine = usePersonalBrand();
  const brand = useBrand();
  const [name, setName] = useState(mine.name ?? '');

  const changeIcon = async () => {
    const file = await pickImage();
    if (!file) return;
    const apply = async (blob: Blob) => {
      if (blob.size > MAX_ICON_BYTES) {
        ui.toast('That picture is too big for an app icon (1.5 MB max)', 'error');
        return;
      }
      if (save({ logo: await toDataUrl(blob) })) ui.toast('App icon changed', 'success');
    };
    if (keepsAnimation(file)) await apply(file);
    else ui.openModal('crop', { file, title: 'App icon', shape: 'rounded', outWidth: 256, onDone: apply });
  };

  return (
    <Section title="App name & icon" hint="Rename the app and give it your own icon. This only changes how RanchCord looks for you, on this device.">
      <div className="branding">
        <div className="branding-preview">
          <img src={brand.logo} alt="" />
          <strong>{name.trim() || brand.name}</strong>
        </div>
        <div className="branding-form">
          <TextField label="App name" value={name} maxLength={32} placeholder="RanchCord" onChange={(e) => setName(e.target.value)} />
          <div className="ui-row">
            <Button
              disabled={name.trim() === (mine.name ?? '')}
              onClick={() => {
                if (save({ name: name.trim() || undefined })) ui.toast('App name saved', 'success');
              }}
            >
              Save name
            </Button>
            <Button variant="secondary" icon={<ImageIcon size={16} weight="fill" />} onClick={() => void changeIcon()}>
              Change icon
            </Button>
            {(mine.name || mine.logo) && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (save({ name: undefined, logo: undefined })) setName('');
                }}
              >
                Reset
              </Button>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}
