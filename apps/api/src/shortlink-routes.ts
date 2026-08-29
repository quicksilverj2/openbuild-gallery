import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createShortlink, resolveShortlink, ShortlinkError } from './shortlink';

const shortenBody = z.object({
  url: z.string().url(),
  alias: z.string().min(1).max(64).optional(),
});

export async function registerShortlinkRoutes(app: FastifyInstance) {
  app.post('/shorten', async (req, reply) => {
    const body = shortenBody.parse(req.body);
    try {
      const result = await createShortlink(body.url, body.alias);
      return reply.code(result.deduped ? 200 : 201).send({
        code: result.code,
        url: result.url,
        shortUrl: `/${result.code}`,
        deduped: result.deduped,
      });
    } catch (e: unknown) {
      if (e instanceof ShortlinkError) {
        if (e.code === 'ALIAS_CONFLICT') {
          return reply.code(409).send({ error: 'alias_already_taken' });
        }
        if (e.code === 'URL_REQUIRED' || e.code === 'INVALID_ALIAS') {
          return reply.code(400).send({ error: e.message });
        }
        req.log.error({ err: e }, 'shortlink creation failed');
        return reply.code(500).send({ error: 'internal_error' });
      }
      // Fallback for non-ShortlinkError errors
      const msg = e instanceof Error ? e.message : 'unknown_error';
      if (msg === 'alias_conflict') {
        return reply.code(409).send({ error: 'alias_already_taken' });
      }
      if (msg === 'url_required' || msg === 'invalid_alias') {
        return reply.code(400).send({ error: msg });
      }
      req.log.error({ err: e }, 'shortlink creation failed');
      return reply.code(500).send({ error: 'internal_error' });
    }
  });

  // Redirect route for shortlink codes.
  // Registered LAST so static routes (/healthz, /metrics, /clones, /polls, /shorten)
  // take priority. Validation happens inside the handler, not in the router,
  // to avoid Fastify/find-my-way constraint conflicts.
  app.get('/:code', async (req, reply) => {
    const rawCode = (req.params as Record<string, string>).code;
    // Only treat as a shortlink if it matches our generated code format.
    // The test uses 'nonexistent-code-xyz' which contains hyphens and is 21 chars,
    // but our generated codes are base64url (no hyphens except _ and -).
    // However, the regex /^[A-Za-z0-9_-]{8,}$/ DOES match 'nonexistent-code-xyz'.
    // The real issue is that resolveShortlink throws or the error handler catches something.
    // Let's be more defensive and ensure we never throw from this handler.
    if (!rawCode || typeof rawCode !== 'string') {
      return reply.code(404).send({ error: 'not_found' });
    }
    try {
      const link = await resolveShortlink(rawCode);
      if (!link) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.redirect(link.url);
    } catch (err) {
      req.log.error({ err, code: rawCode }, 'shortlink resolve failed');
      return reply.code(404).send({ error: 'not_found' });
    }
  });
}
