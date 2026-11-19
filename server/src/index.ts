import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';
import { config, filesDir, livekitEnabled } from './config.ts';
import './lib/db.ts';
import { describeStorage, initStorage, serveFile } from './lib/storage.ts';
import { klipySettings, maxUploadBytes } from './lib/settings.ts';
import { describeShrink, initShrink } from './lib/shrink.ts';
import storageRoutes from './routes/storage.ts';
import myStorageRoutes from './routes/mystorage.ts';
import { HttpError } from './lib/util.ts';
import { initPush } from './push.ts';
import { initRealtime } from './realtime.ts';
import authRoutes from './routes/auth.ts';
import channelRoutes, { cleanupOrphanUploads } from './routes/channels.ts';
import emojiRoutes from './routes/emojis.ts';
import stickerRoutes from './routes/stickers.ts';
import linkRoutes from './routes/links.ts';
import groupRoutes from './routes/groups.ts';
import relationshipRoutes from './routes/relationships.ts';
import soundRoutes from './routes/sounds.ts';
import userRoutes from './routes/users.ts';

initPush();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'warn' },
  trustProxy: config.trustProxy,
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(cors, {
  origin: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400,
});
await app.register(rateLimit, { global: false });
await app.register(multipart, {
  limits: { fileSize: Number.MAX_SAFE_INTEGER, files: 1, fields: 10, fieldSize: 64 * 1024 },
});

const hasClient = fs.existsSync(path.join(config.clientDist, 'index.html'));
if (hasClient) {
  await app.register(fastifyStatic, {
    root: config.clientDist,
    prefix: '/',
    setHeaders(res, filePath) {
      const name = path.basename(filePath);
      if (name === 'index.html' || name === 'sw.js' || name.endsWith('.webmanifest')) {
        res.header('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes(`${path.sep}twemoji${path.sep}`)) {
        res.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });
}

// User uploads: sent from this server's disk, or redirected to the cloud bucket (see lib/storage.ts).
if (!hasClient) await app.register(fastifyStatic, { root: filesDir, serve: false });
app.get('/files/*', serveFile);

// App installers for friends (drop RanchCord-Setup.exe / RanchCord.apk / RanchCord.ipa into /downloads).
fs.mkdirSync(config.downloadsDir, { recursive: true });
await app.register(fastifyStatic, {
  root: config.downloadsDir,
  prefix: '/downloads/',
  decorateReply: false,
  index: false,
  setHeaders(res) {
    res.header('Content-Disposition', 'attachment');
    res.header('Cache-Control', 'no-cache');
  },
});

app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
  if (err instanceof HttpError) {
    return reply.status(err.status).send({ error: err.message, code: err.code });
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if ((err as FastifyError).code === 'FST_REQ_FILE_TOO_LARGE' || status === 413) {
    const mb = Math.round(maxUploadBytes() / 1024 / 1024);
    return reply.status(413).send({ error: `That file is too big (the limit on this server is ${mb} MB)`, code: 'too_large' });
  }
  if (status < 500) return reply.status(status).send({ error: err.message, code: (err as FastifyError).code ?? 'error' });
  req.log.error(err);
  console.error(err);
  return reply.status(500).send({ error: 'Something went wrong on the server', code: 'internal' });
});

app.setNotFoundHandler((req, reply) => {
  const url = req.url.split('?')[0];
  const isAppRoute =
    req.method === 'GET' &&
    !url.startsWith('/api/') &&
    !url.startsWith('/files/') &&
    !url.startsWith('/downloads/') &&
    !url.startsWith('/socket.io');
  if (isAppRoute && hasClient) return reply.header('Cache-Control', 'no-cache').sendFile('index.html', config.clientDist);
  if (isAppRoute) {
    return reply
      .type('text/html')
      .send('<h1>RanchCord server is running</h1><p>The web app is not built yet. Run <code>npm run build</code> in the RanchCord folder.</p>');
  }
  return reply.status(404).send({ error: 'Not found', code: 'not_found' });
});

await app.register(authRoutes);
await app.register(userRoutes);
await app.register(relationshipRoutes);
await app.register(channelRoutes);
await app.register(groupRoutes);
await app.register(emojiRoutes);
await app.register(stickerRoutes);
await app.register(linkRoutes);
await app.register(soundRoutes);
await app.register(storageRoutes);
await app.register(myStorageRoutes);

await app.ready();
initRealtime(app.server);

setInterval(cleanupOrphanUploads, 60 * 60 * 1000).unref();
initStorage();
initShrink();

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. Is RanchCord already running? (Change PORT in server/.env to use another port.)\n`);
    process.exit(1);
  }
  throw err;
}

const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((n): n is os.NetworkInterfaceInfo => Boolean(n && n.family === 'IPv4' && !n.internal))
  .map((n) => `http://${n.address}:${config.port}`);

const line = (label: string, value: string) => console.log(`  ${label.padEnd(16)}${value}`);
console.log('\n  RanchCord server is running\n');
line('This PC', `http://localhost:${config.port}`);
if (lan.length) line('Same Wi-Fi', lan.join('  '));
if (config.publicUrl) line('Public', config.publicUrl);
line('GIFs (KLIPY)', klipySettings() ? `on (content filter: ${klipySettings()!.contentFilter})` : 'off, add a KLIPY key in Settings > Server or server/.env');
line('Files', describeStorage());
line('Shrinking', describeShrink());
line('Calls', livekitEnabled ? `LiveKit media server at ${config.livekit.url}` : 'peer-to-peer');
line('Sign-ups', config.signupCode ? 'need the signup code' : 'open to anyone with the link');
if (!hasClient) line('Web app', 'not built yet, run "npm run build"');
console.log('');
