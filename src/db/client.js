const cleanBase = (value) => String(value || '').replace(/\/+$/, '');

export function db(env) {
  const base = cleanBase(env.SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const configured = Boolean(base && key);

  async function request(path, options = {}) {
    if (!configured) return { data: null, error: { message: 'Supabase is not configured', code: 'NOT_CONFIGURED' } };
    try {
      const response = await fetch(base + path, {
        ...options,
        headers: {
          apikey: key,
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
          ...(options.headers || {})
        },
        signal: options.signal || AbortSignal.timeout(10000)
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!response.ok) {
        return { data: null, error: { message: data?.message || data?.error || 'Database request failed', code: data?.code || String(response.status), status: response.status } };
      }
      return { data, error: null, headers: response.headers };
    } catch (error) {
      return { data: null, error: { message: error?.name === 'TimeoutError' ? 'Database request timed out' : 'Database is unavailable', code: error?.name || 'NETWORK' } };
    }
  }

  return {
    configured,
    rest: (table, query = '', options = {}) => request('/rest/v1/' + table + (query ? '?' + query : ''), options),
    rpc: (name, body) => request('/rest/v1/rpc/' + name, { method: 'POST', body: JSON.stringify(body) }),
    storage: (path, options = {}) => request('/storage/v1/' + path.replace(/^\/+/, ''), options)
  };
}

export async function purgeReadCaches(env) {
  const tasks = [];
  if (env.CATALOG_CACHE) {
    tasks.push(env.CATALOG_CACHE.delete('catalog:active'));
  }
  if (env.DASHBOARD_CACHE) {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    tasks.push(env.DASHBOARD_CACHE.delete('dashboard:' + from));
  }
  await Promise.allSettled(tasks);
}

export function prefer(returnMode = 'representation') {
  return { prefer: 'return=' + returnMode };
}
