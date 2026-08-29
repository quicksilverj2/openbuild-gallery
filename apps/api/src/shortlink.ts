import { Prisma } from '@prisma/client';
import { prisma } from './db';
import crypto from 'node:crypto';

function isUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export class ShortlinkError extends Error {
  constructor(
    message: string,
    public readonly code: 'ALIAS_CONFLICT' | 'URL_REQUIRED' | 'INVALID_ALIAS' | 'CODE_EXHAUSTED',
  ) {
    super(message);
    this.name = 'ShortlinkError';
  }
}

export async function createShortlink(url: string, alias?: string) {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) throw new ShortlinkError('url_required', 'URL_REQUIRED');

  // If an explicit alias is provided, try to use it directly.
  if (alias) {
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) throw new ShortlinkError('invalid_alias', 'INVALID_ALIAS');

    // Check for existing entry with same URL first (dedupe requirement)
    const existing = await prisma.shortlink.findFirst({ where: { url: normalizedUrl } });
    if (existing) return { code: existing.code, url: existing.url, deduped: true };

    try {
      const created = await prisma.shortlink.create({
        data: { code: normalizedAlias, url: normalizedUrl, alias: normalizedAlias },
      });
      return { code: created.code, url: created.url, deduped: false };
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Race condition: another request created the same alias or URL concurrently
        const winner = await prisma.shortlink.findFirst({ where: { url: normalizedUrl } });
        if (winner) return { code: winner.code, url: winner.url, deduped: true };
        // Alias collision with different URL
        throw new ShortlinkError('alias_already_taken', 'ALIAS_CONFLICT');
      }
      throw e;
    }
  }

  // No alias: check for existing URL first (dedupe)
  const existing = await prisma.shortlink.findFirst({ where: { url: normalizedUrl } });
  if (existing) return { code: existing.code, url: existing.url, deduped: true };

  // Generate non-enumerable code and insert with retry on collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = crypto.randomBytes(8).toString('base64url').slice(0, 10);
    try {
      const created = await prisma.shortlink.create({
        data: { code, url: normalizedUrl },
      });
      return { code: created.code, url: created.url, deduped: false };
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Code or URL collision — re-check URL dedupe
        const byUrl = await prisma.shortlink.findFirst({ where: { url: normalizedUrl } });
        if (byUrl) return { code: byUrl.code, url: byUrl.url, deduped: true };
        // Code collision only — retry with new code
        continue;
      }
      throw e;
    }
  }
  throw new ShortlinkError('code_generation_exhausted', 'CODE_EXHAUSTED');
}

export async function resolveShortlink(code: string) {
  const link = await prisma.shortlink.findUnique({ where: { code } });
  return link ?? null;
}
