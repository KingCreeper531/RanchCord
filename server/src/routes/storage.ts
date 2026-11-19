import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { get } from '../lib/db.ts';
import { setSetting } from '../lib/settings.ts';
import { runShrink, shrinkStatus } from '../lib/shrink.ts';
import {
  type BucketSettings,
  bucketComplete,
  bucketSettings,
  storageMode,
  storageSettingsChanged,
  storageStatus,
  testBucket,
} from '../lib/storage.ts';
import { badRequest, forbidden, parse } from '../lib/util.ts';

function requireAdmin(req: FastifyRequest) {
  const me = auth(req);
  if (!me.is_admin) throw forbidden('Only the server admin can change where files are kept');
  return me;
}

const HttpUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https?:\/\/[^\s/]+/i.test(v), 'Addresses should start with https://');

const StorageBody = z.object({
  mode: z.enum(['local', 'cloud']).optional(),
  endpoint: HttpUrl.optional(),
  region: z.string().trim().max(64).optional(),
  bucket: z.string().trim().max(120).optional(),
  accessKeyId: z.string().trim().max(256).optional(),
  /** Leave out (or empty) to keep the saved secret. */
  secretAccessKey: z.string().trim().max(256).optional(),
  publicUrl: HttpUrl.optional(),
  shrinkDays: z.number().int().min(0).max(3650).optional(),
  shrinkLevel: z.enum(['gentle', 'strong', 'extreme']).optional(),
});

const BUCKET_KEYS: [keyof BucketSettings, string][] = [
  ['endpoint', 's3_endpoint'],
  ['region', 's3_region'],
  ['bucket', 's3_bucket'],
  ['accessKeyId', 's3_access_key'],
  ['secretAccessKey', 's3_secret_key'],
  ['publicUrl', 's3_public_url'],
];

async function fullStatus() {
  const uploads = get<{ files: number; bytes: number; shrunk: number; saved: number }>(
    `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(shrunk = 1), 0) AS shrunk,
            COALESCE(SUM(CASE WHEN shrunk = 1 THEN original_size - size ELSE 0 END), 0) AS saved
       FROM attachments WHERE message_id IS NOT NULL`,
  )!;
  return { storage: storageStatus(), shrink: await shrinkStatus(), uploads };
}

export default async function storageRoutes(app: FastifyInstance) {
  app.get('/api/instance/storage', async (req) => {
    requireAdmin(req);
    return fullStatus();
  });

  app.patch('/api/instance/storage', async (req) => {
    requireAdmin(req);
    const body = parse(StorageBody, req.body);
    const cur = bucketSettings();
    const next: BucketSettings = {
      ...cur,
      endpoint: body.endpoint !== undefined ? body.endpoint.replace(/\/+$/, '') : cur.endpoint,
      region: body.region !== undefined ? body.region || 'auto' : cur.region,
      bucket: body.bucket ?? cur.bucket,
      accessKeyId: body.accessKeyId ?? cur.accessKeyId,
      secretAccessKey: body.secretAccessKey || cur.secretAccessKey,
      publicUrl: body.publicUrl !== undefined ? body.publicUrl.replace(/\/+$/, '') : cur.publicUrl,
    };
    const clearing = !next.bucket && !next.accessKeyId;
    if (clearing) next.secretAccessKey = '';
    const mode = body.mode ?? storageMode();
    const changed = BUCKET_KEYS.some(([k]) => next[k] !== cur[k]);

    if (mode === 'cloud' && !bucketComplete(next)) throw badRequest('Fill in the bucket name, access key and secret key first');
    if (bucketComplete(next) && (changed || (mode === 'cloud' && storageMode() !== 'cloud'))) {
      // Never save details that don't work: write a test file, read it back and delete it.
      const { publicUrlWorks } = await testBucket(next);
      if (publicUrlWorks === false) {
        throw badRequest("The bucket works, but its public URL doesn't show the files. Fix the public URL or leave it empty.");
      }
    }

    if (changed) for (const [k, key] of BUCKET_KEYS) setSetting(key, next[k]);
    if (body.mode !== undefined) setSetting('storage_mode', body.mode);
    if (body.shrinkDays !== undefined) setSetting('shrink_days', String(body.shrinkDays));
    if (body.shrinkLevel !== undefined) setSetting('shrink_level', body.shrinkLevel);
    storageSettingsChanged();
    return fullStatus();
  });

  /** Shrinks everything that's old enough right now instead of waiting for the next run. */
  app.post('/api/instance/storage/shrink', async (req) => {
    requireAdmin(req);
    void runShrink();
    return fullStatus();
  });
}
