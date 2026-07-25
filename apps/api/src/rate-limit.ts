import type { MiddlewareHandler } from 'hono';
import type { ApiConfig } from './config.js';

interface Bucket {
  count: number;
  windowStartMs: number;
}

/**
 * In-memory per-IP token-bucket rate limiter. Single-instance only -- fine at
 * current scale (one VPS process); would need a shared store (e.g. Redis) if
 * this API is ever run as more than one instance behind a load balancer.
 */
export function createRateLimitMiddleware(config: ApiConfig): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const maxRequests = config.rateLimitMaxRequests;
  const windowMs = config.rateLimitWindowMs;

  return async (context, next) => {
    if (maxRequests <= 0 || windowMs <= 0) return next();

    const clientId = resolveClientId(context.req.header('x-forwarded-for'), context.req.header('x-real-ip'));
    const now = Date.now();
    const bucket = buckets.get(clientId);

    if (!bucket || now - bucket.windowStartMs >= windowMs) {
      buckets.set(clientId, { count: 1, windowStartMs: now });
      return next();
    }

    if (bucket.count >= maxRequests) {
      return context.json({ error: 'Too many requests.' }, 429);
    }

    bucket.count += 1;
    return next();
  };
}

function resolveClientId(forwardedFor?: string, realIp?: string): string {
  const forwarded = forwardedFor?.split(',')[0]?.trim();
  return forwarded || realIp || 'unknown';
}
