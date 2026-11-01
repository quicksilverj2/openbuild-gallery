import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type InvariantEventType =
  | 'poll.created'
  | 'vote.counted'
  | 'vote.idempotent_replay'
  | 'vote.key_conflict'
  | 'vote.already_voted'
  | 'race_lost';

export interface CloneMetricsSnapshot {
  requestsByStatus: Map<string, number>;
  invariantEvents: Map<InvariantEventType, number>;
  latencyMsTotal: number;
  requestsTotal: number;
}

export class PerCloneMetricsRegistry {
  private readonly clones = new Map<string, CloneMetricsSnapshot>();

  private ensureClone(slug: string): CloneMetricsSnapshot {
    let snap = this.clones.get(slug);
    if (!snap) {
      snap = {
        requestsByStatus: new Map(),
        invariantEvents: new Map(),
        latencyMsTotal: 0,
        requestsTotal: 0,
      };
      this.clones.set(slug, snap);
    }
    return snap;
  }

  recordRequest(slug: string, method: string, statusCode: number, durationMs: number): void {
    const snap = this.ensureClone(slug);
    const key = `${method.toUpperCase()}:${statusCode}`;
    snap.requestsByStatus.set(key, (snap.requestsByStatus.get(key) ?? 0) + 1);
    snap.requestsTotal += 1;
    snap.latencyMsTotal += Math.max(0, durationMs);
  }

  recordInvariantEvent(slug: string, event: InvariantEventType): void {
    const snap = this.ensureClone(slug);
    snap.invariantEvents.set(event, (snap.invariantEvents.get(event) ?? 0) + 1);
  }

  entries(): Array<[string, CloneMetricsSnapshot]> {
    return Array.from(this.clones.entries()).sort(([a], [b]) => a.localeCompare(b));
  }

  reset(): void {
    this.clones.clear();
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    cloneSlug?: string;
    requestStartNs?: bigint;
    recordInvariant?: (
      event: InvariantEventType,
      meta: Record<string, unknown>,
      message: string,
      level?: 'info' | 'warn',
    ) => void;
  }
}

export function registerObservabilityMiddleware(
  app: FastifyInstance,
  registry: PerCloneMetricsRegistry,
  resolvePollCloneSlug: (pollId: string) => Promise<string | null>,
): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    req.requestStartNs = process.hrtime.bigint();
    reply.header('x-request-id', req.id);

    req.recordInvariant = (
      event: InvariantEventType,
      meta: Record<string, unknown>,
      message: string,
      level: 'info' | 'warn' = 'info',
    ) => {
      const slug = req.cloneSlug ?? (meta.cloneSlug as string | undefined) ?? 'poll';
      req.cloneSlug = slug;
      registry.recordInvariantEvent(slug, event);
      if (event === 'vote.already_voted') {
        registry.recordInvariantEvent(slug, 'race_lost');
      }
      const payload = {
        reqId: req.id,
        correlationId: req.id,
        cloneSlug: slug,
        event,
        invariant: event === 'vote.already_voted' ? 'race_lost' : event,
        ...meta,
      };
      if (level === 'warn') {
        req.log.warn(payload, message);
      } else {
        req.log.info(payload, message);
      }
    };
  });

  app.addHook('preHandler', async (req: FastifyRequest) => {
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    if (params.slug) {
      req.cloneSlug = params.slug;
    } else if (params.id && req.url.startsWith('/polls/')) {
      const resolved = await resolvePollCloneSlug(params.id);
      if (resolved) {
        req.cloneSlug = resolved;
      }
    }
  });

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const slug = req.cloneSlug;
    if (!slug) return;
    const elapsedNs = req.requestStartNs ? process.hrtime.bigint() - req.requestStartNs : 0n;
    const durationMs = Number(elapsedNs) / 1_000_000;
    registry.recordRequest(slug, req.method, reply.statusCode, durationMs);
    req.log.info(
      {
        event: 'clone.request.completed',
        reqId: req.id,
        correlationId: req.id,
        cloneSlug: slug,
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        durationMs: Number(durationMs.toFixed(3)),
      },
      'clone request completed',
    );
  });
}
