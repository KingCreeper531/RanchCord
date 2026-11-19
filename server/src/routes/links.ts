import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { linkPreview, pruneLinkPreviews } from '../lib/linkPreview.ts';
import { parse } from '../lib/util.ts';

/** Link previews for messages: the app asks for each link it shows (see lib/linkPreview.ts). */
export default async function linkRoutes(app: FastifyInstance) {
  // Each person gets a generous number of lookups a minute; the pages themselves are cached.
  const perPerson = (req: FastifyRequest) => {
    try {
      return auth(req).id;
    } catch {
      return req.ip;
    }
  };
  app.get('/api/link-preview', { config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: perPerson } } }, async (req) => {
    auth(req);
    const { url } = parse(z.object({ url: z.string().url().max(2000) }), req.query);
    return { preview: await linkPreview(url) };
  });

  pruneLinkPreviews();
  setInterval(pruneLinkPreviews, 12 * 60 * 60 * 1000).unref();
}
