import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    cloneSlug: string;
    startTime: number;
  }
}

const counters = new Map<string, number>();

export function bumpMetric(clone: string, method: string, status: number) {
  const key = `${clone}|${method}|${status}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function resetMetrics() {
  counters.clear();
}

export function getHttpMetricsAsPrometheus(): string[] {
  const lines: string[] = [
    '# HELP openbuild_http_requests_total Total HTTP requests per clone, method, and status.',
    '# TYPE openbuild_http_requests_total counter',
  ];
  for (const [key, n] of counters) {
    const [clone, method, status] = key.split('|');
    lines.push(`openbuild_http_requests_total{clone="${clone}",method="${method}",status="${status}"} ${n}`);
  }
  return lines;
}

export function deriveCloneFromUrl(url: string): string {
  const cleanUrl = url.split('?')[0];
  const cloneMatch = cleanUrl.match(/^\/clones\/([^/]+)/);
  if (cloneMatch) return cloneMatch[1];
  if (cleanUrl.startsWith('/polls')) return 'poll';
  return 'core';
}

const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('onRequest', async (req, reply) => {
    req.correlationId = (req.id as string) || (req.headers['x-request-id'] as string) || 'unknown';
    req.startTime = Date.now();
    req.cloneSlug = deriveCloneFromUrl(req.url);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.correlationId) {
      reply.header('x-request-id', req.correlationId);
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const duration = Date.now() - req.startTime;
    const clone = req.cloneSlug ?? 'core';

    bumpMetric(clone, req.method, reply.statusCode);

    req.log.info(
      {
        correlationId: req.correlationId,
        clone,
        method: req.method,
        status: reply.statusCode,
        durationMs: duration,
      },
      'request completed',
    );
  });

  app.addHook('onError', async (req, _reply, error) => {
    req.log.error(
      {
        correlationId: req.correlationId,
        clone: req.cloneSlug,
        err: error,
      },
      'unhandled error with correlationId',
    );
  });
};

export const observabilityPlugin = fp(plugin, { name: 'observability-plugin' });
