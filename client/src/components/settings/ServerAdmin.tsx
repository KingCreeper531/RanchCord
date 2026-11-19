import { useEffect, useRef, useState } from 'react';
import { ArrowsClockwise, CaretDown, Cloud, Eye, EyeSlash, HardDrives, Image as ImageIcon, Warning } from '@phosphor-icons/react';
import {
  getServerSettings,
  getStorage,
  removeAppLogo,
  saveServerSettings,
  saveStorage,
  setAppName,
  shrinkNow,
  uploadAppLogo,
} from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { useBrand } from '../../lib/brand';
import { formatBytes } from '../../lib/format';
import { useData } from '../../store/data';
import { ui } from '../../store/ui';
import type { ServerSettings, ShrinkLevel, StorageInfo } from '../../types';
import { Button, Spinner, Switch, TextField } from '../ui';
import { keepsAnimation, pickImage } from '../modals/ImageCrop';
import { Row, Section, Seg } from './parts';

export function ServerAdminTab() {
  const isAdmin = useData((s) => s.me?.isAdmin);
  if (!isAdmin) {
    return <p className="settings-hint">Only the server admin (the first account made on this server) can change these settings.</p>;
  }
  return (
    <>
      <BrandingSection />
      <GifsAndUploads />
      <StorageSection />
    </>
  );
}

/* ---------------- name & logo ---------------- */

function BrandingSection() {
  const instance = useData((s) => s.instance);
  const brand = useBrand();
  const [name, setName] = useState(instance?.name ?? '');
  const [busy, setBusy] = useState(false);
  const changeLogo = async () => {
    const file = await pickImage();
    if (!file) return;
    const upload = async (blob: Blob, filename: string) => {
      try {
        await uploadAppLogo(blob, filename);
      } catch (err) {
        ui.toast(errorMessage(err), 'error');
        throw err;
      }
    };
    if (keepsAnimation(file)) await upload(file, file.name);
    else ui.openModal('crop', { file, title: 'App logo', shape: 'rounded', outWidth: 512, onDone: upload });
  };
  return (
    <Section
      title="App name & logo"
      hint="Rename the app and change its logo for everyone on this server: the login screen, sidebar, window title and browser tab. Installed apps keep their home-screen icon and name."
    >
      <div className="branding">
        <div className="branding-preview">
          <img src={brand.logo} alt="" />
          <strong>{name.trim() || 'RanchCord'}</strong>
        </div>
        <div className="branding-form">
          <TextField label="App name" value={name} maxLength={32} placeholder="RanchCord" onChange={(e) => setName(e.target.value)} />
          <div className="ui-row">
            <Button
              loading={busy}
              disabled={name.trim() === (instance?.name ?? '')}
              onClick={async () => {
                setBusy(true);
                try {
                  await setAppName(name.trim());
                  ui.toast('App name saved', 'success');
                } catch (err) {
                  ui.toast(errorMessage(err), 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save name
            </Button>
            <Button variant="secondary" icon={<ImageIcon size={16} weight="fill" />} onClick={() => void changeLogo()}>
              Change logo
            </Button>
            {instance?.logo && (
              <Button variant="ghost" onClick={() => void removeAppLogo().catch((err) => ui.toast(errorMessage(err), 'error'))}>
                Use the ranch bottle
              </Button>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ---------------- GIFs & upload limit ---------------- */

const FILTERS: { id: ServerSettings['klipyFilter']; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

function GifsAndUploads() {
  const [saved, setSaved] = useState<ServerSettings | null>(null);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [filter, setFilter] = useState<ServerSettings['klipyFilter']>('off');
  const [mb, setMb] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getServerSettings()
      .then((s) => {
        setSaved(s);
        setKey(s.klipyKey);
        setFilter(s.klipyFilter);
        setMb(String(s.maxUploadMb));
      })
      .catch((err) => ui.toast(errorMessage(err), 'error'));
  }, []);

  if (!saved) return <Spinner />;
  const mbNum = Math.max(0, Math.round(Number(mb) || 0));
  const dirty = key.trim() !== saved.klipyKey || filter !== saved.klipyFilter || mbNum !== saved.maxUploadMb;

  const save = async () => {
    setBusy(true);
    try {
      await saveServerSettings({ klipyKey: key.trim(), klipyFilter: filter, maxUploadMb: mbNum });
      setSaved({ ...saved, klipyKey: key.trim(), klipyFilter: filter, maxUploadMb: mbNum });
      ui.toast('Server settings saved', 'success');
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="GIFs & stickers"
        hint={
          <>
            One free KLIPY key powers GIFs and stickers for everyone. Get one at{' '}
            <a href="https://partner.klipy.com" target="_blank" rel="noreferrer">
              partner.klipy.com
            </a>
            .
          </>
        }
      >
        <TextField
          label="KLIPY API key"
          type={showKey ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={saved.klipyKeyFromEnv ? 'Using the key from server/.env' : 'Paste your key'}
          onChange={(e) => setKey(e.target.value)}
          suffix={
            <button className="field-eye" onClick={() => setShowKey(!showKey)} aria-label={showKey ? 'Hide key' : 'Show key'}>
              {showKey ? <EyeSlash size={18} /> : <Eye size={18} />}
            </button>
          }
        />
        <div className="ui-field">
          <span className="ui-field-label">Content filter</span>
          <Seg value={filter} options={FILTERS} onChange={setFilter} label="Content filter" />
          <div className="ui-field-hint">Off shows everything KLIPY has. Higher levels hide more.</div>
        </div>
      </Section>
      <Section title="Uploads">
        <TextField
          label="Biggest file someone can send"
          type="number"
          min={0}
          inputMode="numeric"
          value={mb}
          onChange={(e) => setMb(e.target.value)}
          suffix={<span className="muted">MB</span>}
          hint={mbNum === 0 ? 'No limit at all.' : `${mbNum >= 1024 ? `${(mbNum / 1024).toFixed(mbNum % 1024 ? 1 : 0)} GB` : `${mbNum} MB`} per file. Use 0 for no limit.`}
        />
      </Section>
      <div className="ui-row">
        <Button loading={busy} disabled={!dirty} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </>
  );
}

/* ---------------- storage & shrinking ---------------- */

type Provider = 'r2' | 'b2' | 'other';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'r2', label: 'Cloudflare R2' },
  { id: 'b2', label: 'Backblaze B2' },
  { id: 'other', label: 'Other S3' },
];

const PROVIDER_HELP: Record<Provider, { endpoint: string; steps: string }> = {
  r2: {
    endpoint: 'https://<account id>.r2.cloudflarestorage.com',
    steps:
      'In the Cloudflare dashboard open R2, create a bucket, then "Manage API tokens" → Create token with Object Read & Write for that bucket. Copy the Access Key ID, Secret Access Key and the S3 endpoint it shows.',
  },
  b2: {
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    steps:
      'In Backblaze create a private bucket (its page shows the S3 endpoint), then Application Keys → Add a New Application Key with Read and Write access to that bucket. The keyID is the access key and the applicationKey is the secret.',
  },
  other: {
    endpoint: 'https://s3.example.com',
    steps: 'Any S3-compatible storage works (Wasabi, MinIO, AWS S3...). You need the endpoint, bucket name and an access key that can read and write it.',
  },
};

const LEVELS: { id: ShrinkLevel; label: string; hint: string }[] = [
  { id: 'gentle', label: 'Gentle', hint: 'Photos up to 2560 px, videos 720p. Hard to tell apart from the originals.' },
  { id: 'strong', label: 'Strong', hint: 'Photos up to 1600 px, videos 480p. Usually 5 to 20 times smaller.' },
  { id: 'extreme', label: 'Extreme', hint: 'Photos up to 1080 px, videos 360p. As small as it gets.' },
];

function providerOf(endpoint: string): Provider {
  if (!endpoint || /r2\.cloudflarestorage\.com/i.test(endpoint)) return 'r2';
  if (/backblazeb2\.com/i.test(endpoint)) return 'b2';
  return 'other';
}

function ago(t: number | null): string {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function StorageSection() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [mode, setMode] = useState<'local' | 'cloud'>('local');
  const [provider, setProvider] = useState<Provider>('r2');
  const [form, setForm] = useState({ endpoint: '', region: 'auto', bucket: '', accessKeyId: '', secretAccessKey: '', publicUrl: '' });
  const [advanced, setAdvanced] = useState(false);
  const [days, setDays] = useState('30');
  const [level, setLevel] = useState<ShrinkLevel>('strong');
  const [busy, setBusy] = useState<'bucket' | 'shrink' | 'now' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  const take = (s: StorageInfo, resetForm: boolean) => {
    setInfo(s);
    if (!resetForm) return;
    setMode(s.storage.mode);
    setProvider(providerOf(s.storage.endpoint));
    setForm({
      endpoint: s.storage.endpoint,
      region: s.storage.region || 'auto',
      bucket: s.storage.bucket,
      accessKeyId: s.storage.accessKeyId,
      secretAccessKey: '',
      publicUrl: s.storage.publicUrl,
    });
    setAdvanced(Boolean(s.storage.publicUrl));
    setDays(String(s.shrink.days));
    setLevel(s.shrink.level);
  };

  // Load once, then keep the numbers fresh (faster while something is happening).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await getStorage();
        if (!alive) return;
        take(s, !loaded.current);
        loaded.current = true;
        timer = setTimeout(tick, s.shrink.running || s.storage.waiting > 0 ? 3000 : 15000);
      } catch (err) {
        if (alive) setError(errorMessage(err));
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  if (!info) return error ? <p className="settings-hint">{error}</p> : <Spinner />;
  const st = info.storage;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const help = PROVIDER_HELP[provider];
  const bucketDirty =
    mode !== st.mode ||
    form.endpoint.trim() !== st.endpoint ||
    (form.region.trim() || 'auto') !== st.region ||
    form.bucket.trim() !== st.bucket ||
    form.accessKeyId.trim() !== st.accessKeyId ||
    form.secretAccessKey.trim() !== '' ||
    form.publicUrl.trim() !== st.publicUrl;
  const daysNum = Math.max(0, Math.round(Number(days) || 0));
  const shrinkDirty = daysNum !== info.shrink.days || level !== info.shrink.level;

  const saveBucket = async () => {
    setBusy('bucket');
    setError(null);
    try {
      const s = await saveStorage({
        mode,
        endpoint: form.endpoint.trim(),
        region: form.region.trim() || 'auto',
        bucket: form.bucket.trim(),
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey: form.secretAccessKey.trim() || undefined,
        publicUrl: form.publicUrl.trim(),
      });
      take(s, true);
      ui.toast(s.storage.mode === 'cloud' ? 'Connected! New uploads now go to the bucket.' : 'Files now stay on this server', 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const saveShrink = async () => {
    setBusy('shrink');
    try {
      const s = await saveStorage({ shrinkDays: daysNum, shrinkLevel: level });
      setInfo(s);
      ui.toast(daysNum ? 'Shrinking settings saved' : 'Shrinking turned off', 'success');
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    setBusy('now');
    try {
      setInfo(await shrinkNow());
      ui.toast(`Shrinking uploads older than ${info.shrink.days} days`, 'success');
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Section
        title="Where profile pictures, emojis and sounds are kept"
        hint="Files people send in chats go to each person's own storage (Settings → My Storage). This is only for the small shared things."
      >
        <div className="type-cards">
          <button className={`type-card${mode === 'local' ? ' is-active' : ''}`} onClick={() => setMode('local')}>
            <HardDrives size={24} />
            <span>
              <strong>On this server</strong>
              <small>Kept on the computer running RanchCord.</small>
            </span>
            <span className="radio" />
          </button>
          <button className={`type-card${mode === 'cloud' ? ' is-active' : ''}`} onClick={() => setMode('cloud')}>
            <Cloud size={24} />
            <span>
              <strong>Cloud bucket</strong>
              <small>Moved to Cloudflare R2, Backblaze B2 or other S3 storage. Saves space on a Raspberry Pi.</small>
            </span>
            <span className="radio" />
          </button>
        </div>

        {mode === 'cloud' && (
          <div className="storage-form">
            <Seg value={provider} options={PROVIDERS} onChange={setProvider} label="Storage provider" />
            <p className="settings-hint">{help.steps}</p>
            <TextField label="S3 endpoint" value={form.endpoint} placeholder={help.endpoint} spellCheck={false} onChange={set('endpoint')} />
            <div className="storage-pair">
              <TextField label="Bucket name" value={form.bucket} placeholder="ranchcord" spellCheck={false} onChange={set('bucket')} />
              <TextField label="Region" value={form.region} placeholder="auto" spellCheck={false} onChange={set('region')} hint={provider === 'r2' ? 'Leave as auto' : undefined} />
            </div>
            <TextField label="Access key ID" value={form.accessKeyId} spellCheck={false} autoComplete="off" onChange={set('accessKeyId')} />
            <TextField
              label="Secret access key"
              type="password"
              autoComplete="new-password"
              value={form.secretAccessKey}
              placeholder={st.secretSet ? 'Saved. Leave empty to keep it.' : ''}
              onChange={set('secretAccessKey')}
            />
            <button className="storage-advanced" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              <CaretDown size={14} weight="bold" style={{ transform: advanced ? 'none' : 'rotate(-90deg)' }} /> Advanced
            </button>
            {advanced && (
              <TextField
                label="Public bucket address (optional)"
                value={form.publicUrl}
                placeholder="https://files.example.com"
                spellCheck={false}
                onChange={set('publicUrl')}
                hint="Only if the bucket has its own public domain. Without it, files get private links that expire."
              />
            )}
          </div>
        )}
        {error && (
          <div className="storage-error">
            <Warning size={18} weight="fill" /> {error}
          </div>
        )}
        <div className="ui-row">
          <Button loading={busy === 'bucket'} disabled={!bucketDirty} onClick={() => void saveBucket()}>
            {mode === 'cloud' ? 'Test & save' : 'Save'}
          </Button>
          {mode === 'local' && st.mode === 'cloud' && <span className="settings-hint">Files already in the bucket keep loading from it.</span>}
        </div>

        <div className="storage-stats">
          <div>
            <strong>{formatBytes(info.uploads.bytes)}</strong>
            <span>
              in {info.uploads.files} upload{info.uploads.files === 1 ? '' : 's'}
            </span>
          </div>
          <div>
            <strong>{formatBytes(st.local.bytes)}</strong>
            <span>on this server's disk</span>
          </div>
          {st.mode === 'cloud' && (
            <div>
              <strong>{st.waiting}</strong>
              <span>{st.waiting === 1 ? 'file moving' : 'files moving'} to the bucket</span>
            </div>
          )}
        </div>
        {st.lastError && (
          <div className="storage-error">
            <Warning size={18} weight="fill" /> {st.lastError} ({ago(st.lastErrorAt)}). Files stay on this server until it works again.
          </div>
        )}
      </Section>

      <Section
        title="Shrink old uploads"
        hint="After a while, photos become small WebP images and videos and audio get re-encoded so they take a fraction of the space, including files in everyone's own storage. Messages keep working; only the quality of old files goes down."
      >
        <Row title="Shrink old files" hint={daysNum ? `Files older than ${daysNum} days` : 'Off: files are kept as they were sent'}>
          <Switch checked={daysNum > 0} onChange={(v) => setDays(v ? '30' : '0')} label="Shrink old files" />
        </Row>
        {daysNum > 0 && (
          <>
            <TextField
              label="Shrink files older than"
              type="number"
              min={1}
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              suffix={<span className="muted">days</span>}
            />
            <div className="ui-field">
              <span className="ui-field-label">How much</span>
              <Seg value={level} options={LEVELS} onChange={setLevel} label="Shrink strength" />
              <div className="ui-field-hint">{LEVELS.find((l) => l.id === level)?.hint}</div>
            </div>
          </>
        )}
        {(!info.shrink.videos || !info.shrink.images) && (
          <div className="storage-error is-soft">
            <Warning size={18} weight="fill" />
            {!info.shrink.images
              ? 'Photos can’t be shrunk: the server is missing the "sharp" module (run npm install in the server folder).'
              : 'Only photos shrink right now. For videos and audio install ffmpeg on the server (on a Pi: sudo apt install ffmpeg).'}
          </div>
        )}
        <div className="storage-stats">
          <div>
            <strong>{info.uploads.shrunk}</strong>
            <span>files shrunk</span>
          </div>
          <div>
            <strong>{formatBytes(info.uploads.saved)}</strong>
            <span>space saved</span>
          </div>
          <div>
            <strong>{info.shrink.running ? 'Running' : ago(info.shrink.lastRun)}</strong>
            <span>{info.shrink.running ? info.shrink.current ?? 'starting…' : 'last check'}</span>
          </div>
        </div>
        <div className="ui-row">
          <Button loading={busy === 'shrink'} disabled={!shrinkDirty} onClick={() => void saveShrink()}>
            Save
          </Button>
          {info.shrink.days > 0 && (
            <Button
              variant="secondary"
              icon={info.shrink.running ? <Spinner size={16} /> : <ArrowsClockwise size={16} />}
              loading={busy === 'now'}
              disabled={info.shrink.running || shrinkDirty}
              onClick={() => void runNow()}
            >
              {info.shrink.running ? 'Shrinking…' : 'Shrink now'}
            </Button>
          )}
        </div>
      </Section>
    </>
  );
}
