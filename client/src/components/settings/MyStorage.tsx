import { useState } from 'react';
import { CheckCircle, Cloud, CopySimple, Warning } from '@phosphor-icons/react';
import { type StorageForm, linkMyStorage, unlinkMyStorage } from '../../lib/actions';
import { ApiError, errorMessage } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useData } from '../../store/data';
import { ui } from '../../store/ui';
import { Button, TextField } from '../ui';
import { Section, Seg } from './parts';

type Provider = 'b2' | 'r2' | 'other';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'b2', label: 'Backblaze B2' },
  { id: 'r2', label: 'Cloudflare R2' },
  { id: 'other', label: 'Other S3' },
];

const HELP: Record<Provider, { free: string; endpoint: string; steps: string[]; cors: string }> = {
  b2: {
    free: '10 GB free, no card needed',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    steps: [
      'Make a free account at backblaze.com (B2 Cloud Storage).',
      'Buckets → Create a Bucket. Give it a unique name and keep it Private. Its page shows the Endpoint.',
      'Application Keys → Add a New Application Key. Allow access to just that bucket, Read and Write.',
      'Copy the keyID and applicationKey into the boxes below (the key is only shown once).',
    ],
    cors: "Open the bucket's CORS Rules, choose \"Share everything in this bucket with every origin\", apply it to the S3 Compatible API, and save.",
  },
  r2: {
    free: '10 GB free, Cloudflare asks for a card',
    endpoint: 'https://<account id>.r2.cloudflarestorage.com',
    steps: [
      'In the Cloudflare dashboard open R2 and create a bucket.',
      'R2 → Manage API tokens → Create API token with Object Read & Write, for just that bucket.',
      'Copy the Access Key ID, Secret Access Key and the S3 endpoint into the boxes below.',
    ],
    cors: 'Open the bucket → Settings → CORS Policy → Add CORS policy, paste the rule below and save.',
  },
  other: {
    free: 'Any S3-compatible storage',
    endpoint: 'https://s3.example.com',
    steps: ['Make a bucket and an access key that can read and write it, then fill in its details below.'],
    cors: 'Add a CORS rule to the bucket that allows GET, PUT and HEAD from any origin, like the one below.',
  },
};

const CORS_RULE = JSON.stringify(
  [{ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['content-type', 'content-disposition'], MaxAgeSeconds: 86400 }],
  null,
  2,
);

function providerOf(endpoint: string): Provider {
  if (/backblazeb2\.com/i.test(endpoint)) return 'b2';
  if (/r2\.cloudflarestorage\.com/i.test(endpoint)) return 'r2';
  return endpoint ? 'other' : 'b2';
}

export function MyStorageTab() {
  const status = useData((s) => s.myStorage);
  const [editing, setEditing] = useState(false);
  const linked = Boolean(status?.linked);

  return (
    <>
      <p className="settings-hint">
        Pictures, videos and files you send are kept in your own storage, not on the server. They go straight from your device into it, and
        everyone in the chat can still see them.
      </p>
      {linked && !editing ? (
        <Section>
          <div className="mystorage-card">
            <span className="mystorage-icon">
              <Cloud size={26} weight="fill" />
            </span>
            <div className="mystorage-text">
              <strong>{status!.bucket}</strong>
              <span>
                {PROVIDERS.find((p) => p.id === providerOf(status!.endpoint))?.label} · {status!.files} file{status!.files === 1 ? '' : 's'} sent ·{' '}
                {formatBytes(status!.bytes)}
              </span>
            </div>
            <CheckCircle size={22} weight="fill" className="mystorage-ok" />
          </div>
          <div className="ui-row">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Change storage
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                ui.openModal('confirm', {
                  title: 'Unlink your storage?',
                  body: "You won't be able to send files until you link storage again. Files you already sent stay in your bucket and keep showing in chats.",
                  confirmLabel: 'Unlink',
                  danger: true,
                  onConfirm: () => unlinkMyStorage().catch((err) => ui.toast(errorMessage(err), 'error')),
                })
              }
            >
              Unlink
            </Button>
          </div>
        </Section>
      ) : (
        <LinkForm onDone={() => setEditing(false)} onCancel={linked ? () => setEditing(false) : undefined} />
      )}
    </>
  );
}

function LinkForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const status = useData((s) => s.myStorage);
  const [provider, setProvider] = useState<Provider>(() => providerOf(status?.endpoint ?? ''));
  const [form, setForm] = useState<StorageForm>({
    endpoint: status?.endpoint ?? '',
    region: status?.region || 'auto',
    bucket: status?.bucket ?? '',
    accessKeyId: status?.accessKeyId ?? '',
    secretAccessKey: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; cors: boolean } | null>(null);
  const help = HELP[provider];
  const set = (k: keyof StorageForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const ready = form.endpoint.trim() && form.bucket.trim() && form.accessKeyId.trim() && form.secretAccessKey.trim();

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      await linkMyStorage({
        endpoint: form.endpoint.trim(),
        region: form.region.trim() || 'auto',
        bucket: form.bucket.trim(),
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey: form.secretAccessKey.trim(),
      });
      ui.toast('Storage linked! You can send files now.', 'success');
      onDone();
    } catch (err) {
      setError({ message: errorMessage(err), cors: err instanceof ApiError && err.code === 'storage_cors' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section title="Where do you want to keep your files?">
        <Seg value={provider} options={PROVIDERS} onChange={setProvider} label="Storage provider" />
        <div className="mystorage-steps">
          <strong>{help.free}</strong>
          <ol>
            {help.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </Section>
      <Section>
        <TextField label="S3 endpoint" value={form.endpoint} placeholder={help.endpoint} spellCheck={false} onChange={set('endpoint')} />
        <div className="storage-pair">
          <TextField label="Bucket name" value={form.bucket} spellCheck={false} onChange={set('bucket')} />
          <TextField label="Region" value={form.region} placeholder="auto" spellCheck={false} onChange={set('region')} hint="Leave as auto" />
        </div>
        <TextField label={provider === 'b2' ? 'Key ID' : 'Access key ID'} value={form.accessKeyId} spellCheck={false} autoComplete="off" onChange={set('accessKeyId')} />
        <TextField
          label={provider === 'b2' ? 'Application key' : 'Secret access key'}
          type="password"
          autoComplete="new-password"
          value={form.secretAccessKey}
          onChange={set('secretAccessKey')}
          hint="Only used to send your files and show them to your friends. Use a key that can only reach this one bucket."
        />
        {error && (
          <div className="storage-error">
            <Warning size={18} weight="fill" /> {error.message}
          </div>
        )}
        {error?.cors && (
          <div className="mystorage-cors">
            <p>{help.cors}</p>
            <pre>{CORS_RULE}</pre>
            <Button
              variant="secondary"
              size="sm"
              icon={<CopySimple size={16} />}
              onClick={() => void navigator.clipboard.writeText(CORS_RULE).then(() => ui.toast('Copied', 'success'))}
            >
              Copy rule
            </Button>
          </div>
        )}
        <div className="ui-row">
          <Button loading={busy} disabled={!ready} onClick={() => void link()}>
            Test & link
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </Section>
    </>
  );
}
