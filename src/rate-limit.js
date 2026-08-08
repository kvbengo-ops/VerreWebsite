const fallback = new Map();

/**
 * A single Durable Object instance owns each limiter key, so increments are
 * serialized and survive Worker isolate and region changes. The in-memory
 * branch exists only for local development and unit tests; production
 * readiness refuses to pass without RATE_LIMITER.
 */
export async function hitCount(env, key, windowMs) {
  if (env.RATE_LIMITER) {
    try {
      const id = env.RATE_LIMITER.idFromName(String(key));
      const response = await env.RATE_LIMITER.get(id).fetch('https://rate-limit.internal/hit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ windowMs })
      });
      if (!response.ok) throw new Error('limiter rejected request');
      const value = await response.json();
      return Number(value.count) || 1;
    } catch (error) {
      console.error('rate-limit: durable counter unavailable - ' + (error?.name || 'unknown'));
      return Number.MAX_SAFE_INTEGER;
    }
  }

  const now = Date.now();
  const times = (fallback.get(key) || []).filter((time) => now - time < windowMs);
  times.push(now);
  fallback.set(key, times);
  if (fallback.size > 5000) {
    for (const [candidate, entries] of fallback) {
      if (!entries.some((time) => now - time < windowMs)) fallback.delete(candidate);
    }
  }
  return times.length;
}

export async function limited(env, key, maximum, windowMs) {
  return (await hitCount(env, key, windowMs)) > maximum;
}

export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let body;
    try { body = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
    const windowMs = Math.min(Math.max(Number(body.windowMs) || 60000, 1000), 24 * 60 * 60 * 1000);
    const now = Date.now();
    const current = await this.state.storage.get('counter');
    const value = !current || now - current.startedAt >= windowMs
      ? { startedAt: now, count: 1 }
      : { startedAt: current.startedAt, count: current.count + 1 };
    await this.state.storage.put('counter', value);
    if (this.state.storage.setAlarm) {
      await this.state.storage.setAlarm(value.startedAt + windowMs + 60000);
    }
    return Response.json({
      count: value.count,
      retryAfter: Math.max(1, Math.ceil((value.startedAt + windowMs - now) / 1000))
    });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

export const _test = { fallback };
