import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { get, run } from '../lib/db.ts';
import { seal } from '../lib/secretbox.ts';
import { type BucketSettings, activeUserStorage, checkUserBucket, confirmUserBucket } from '../lib/storage.ts';
import { badRequest, newId, now, parse } from '../lib/util.ts';
import { emitTo } from '../realtime.ts';

const Address = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https?:\/\/[^\s/]+/i.test(v), 'Addresses should start with https://');

const StorageBody = z.object({
  endpoint: Address.refine((v) => v !== '', 'Paste the S3 endpoint address'),
  region: z.string().trim().max(64).default('auto'),
  bucket: z.string().trim().min(3, 'Type the bucket name').max(120),
  accessKeyId: z.string().trim().min(4, 'Paste the key ID').max(256),
  secretAccessKey: z.string().trim().min(4, 'Paste the secret key').max(256),
  publicUrl: Address.default(''),
});

const toSettings = (b: z.infer<typeof StorageBody>): BucketSettings => ({
  endpoint: b.endpoint.replace(/\/+$/, ''),
  region: b.region || 'auto',
  bucket: b.bucket,
  accessKeyId: b.accessKeyId,
  secretAccessKey: b.secretAccessKey,
  publicUrl: b.publicUrl.replace(/\/+$/, ''),
  prefix: '',
});

/** What the app shows in Settings → My Storage. The secret key is never sent back. */
export function myStorageStatus(userId: string) {
  const row = activeUserStorage(userId);
  const usage = get<{ files: number; bytes: number }>(
    'SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE uploader_id = ? AND storage_id IS NOT NULL AND pending = 0',
    userId,
  )!;
  return {
    linked: Boolean(row),
    endpoint: row?.endpoint ?? '',
    region: row?.region ?? '',
    bucket: row?.bucket ?? '',
    accessKeyId: row?.access_key_id ?? '',
    publicUrl: row?.public_url ?? '',
    linkedAt: row?.created_at ?? null,
    files: usage.files,
    bytes: usage.bytes,
  };
}

export default async function myStorageRoutes(app: FastifyInstance) {
  app.get('/api/storage', async (req) => myStorageStatus(auth(req).id));

  // Step 1: the server checks the details, then hands the device a link for a tiny test upload.
  app.post('/api/storage/check', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    auth(req);
    return checkUserBucket(toSettings(parse(StorageBody, req.body)));
  });

  // Step 2: the device's test upload arrived, so uploads from the app will work. Save it.
  app.put('/api/storage', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const me = auth(req);
    const body = parse(StorageBody.extend({ checkKey: z.string().max(200) }), req.body);
    const settings = toSettings(body);
    if (!(await confirmUserBucket(settings, body.checkKey))) {
      throw badRequest("Your device couldn't upload to that bucket. Add the CORS rule below to the bucket, then try again.", 'storage_cors');
    }
    run('UPDATE user_storage SET active = 0 WHERE user_id = ?', me.id);
    run(
      `INSERT INTO user_storage (id, user_id, endpoint, region, bucket, access_key_id, secret, public_url, prefix, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?)`,
      newId(),
      me.id,
      settings.endpoint,
      settings.region,
      settings.bucket,
      settings.accessKeyId,
      seal(settings.secretAccessKey),
      settings.publicUrl,
      now(),
    );
    const status = myStorageStatus(me.id);
    emitTo([me.id], 'storage:update', status);
    return status;
  });

  // Unlinking stops new uploads. Files already sent keep loading from that bucket.
  app.delete('/api/storage', async (req) => {
    const me = auth(req);
    run('UPDATE user_storage SET active = 0 WHERE user_id = ?', me.id);
    const status = myStorageStatus(me.id);
    emitTo([me.id], 'storage:update', status);
    return status;
  });
}
