import { db } from './client.js';

// All rollups, Manila business-day grouping, and attention queries run inside
// Postgres. The Worker transports one snapshot and may cache it for five minutes.
export async function dashboard(env, range = {}) {
  const from = range.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const cacheKey = 'dashboard:' + from.slice(0, 10);
  if (range.refresh && env.DASHBOARD_CACHE) {
    try { await env.DASHBOARD_CACHE.delete(cacheKey); } catch {}
  }
  if (!range.refresh && env.DASHBOARD_CACHE) {
    try {
      const cached = await env.DASHBOARD_CACHE.get(cacheKey, 'json');
      if (cached) return { data: cached, error: null };
    } catch {}
  }
  const result = await db(env).rpc('dashboard_snapshot', { p_from: from });
  if (!result.error && env.DASHBOARD_CACHE) {
    try { await env.DASHBOARD_CACHE.put(cacheKey, JSON.stringify(result.data), { expirationTtl: 300 }); } catch {}
  }
  return result;
}
