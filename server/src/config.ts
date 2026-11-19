import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(serverRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function iceServers(): IceServer[] {
  if (env.ICE_SERVERS_JSON) {
    try {
      return JSON.parse(env.ICE_SERVERS_JSON) as IceServer[];
    } catch {
      console.warn('ICE_SERVERS_JSON is not valid JSON, using the default STUN servers');
    }
  }
  const servers: IceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (env.TURN_URL) {
    servers.push({
      urls: env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean),
      username: env.TURN_USERNAME ?? '',
      credential: env.TURN_CREDENTIAL ?? '',
    });
  }
  return servers;
}

const filters = ['off', 'low', 'medium', 'high'] as const;
type ContentFilter = (typeof filters)[number];

const uploadMb = int(env.MAX_UPLOAD_MB, 50);

export const config = {
  port: int(env.PORT, 6420),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(serverRoot, env.DATA_DIR || 'data'),
  clientDist: path.resolve(serverRoot, env.CLIENT_DIST || '../client/dist'),
  downloadsDir: path.resolve(serverRoot, env.DOWNLOADS_DIR || '../downloads'),
  instanceName: env.INSTANCE_NAME || 'RanchCord',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  signupCode: env.SIGNUP_CODE || '',
  klipyKey: env.KLIPY_API_KEY || '',
  klipyContentFilter: (filters as readonly string[]).includes(env.KLIPY_CONTENT_FILTER ?? '')
    ? (env.KLIPY_CONTENT_FILTER as ContentFilter)
    : ('off' as ContentFilter),
  /** 0 means unlimited. */
  maxUploadBytes: uploadMb > 0 ? uploadMb * 1024 * 1024 : Number.MAX_SAFE_INTEGER,
  iceServers: iceServers(),
  /** When all three are set, calls run through a LiveKit media server (SFU) instead of peer-to-peer. */
  livekit: {
    url: (env.LIVEKIT_URL || '').replace(/\/+$/, ''),
    apiKey: env.LIVEKIT_API_KEY || '',
    apiSecret: env.LIVEKIT_API_SECRET || '',
  },
  pushContact: env.PUSH_CONTACT || 'mailto:admin@example.com',
  trustProxy: env.TRUST_PROXY !== 'false',
};

export const livekitEnabled = Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);

export const filesDir = path.join(config.dataDir, 'files');
for (const sub of ['attachments', 'avatars', 'emojis', 'icons', 'sounds', 'stickers']) {
  fs.mkdirSync(path.join(filesDir, sub), { recursive: true });
}
