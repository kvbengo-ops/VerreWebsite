let jwksCache = { at: 0, keys: [] };

const decodePart = (part) => {
  const value = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0))));
};
const decodeBytes = (part) => {
  const value = part.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
};

function allowed(email, env) {
  const allowlist = String(env.ADMIN_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return allowlist.length > 0 && allowlist.includes(String(email || '').toLowerCase());
}

async function verifyAccessJwt(token, env) {
  if (!token || !env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) return null;
  const issuer = String(env.CF_ACCESS_TEAM_DOMAIN).replace(/\/$/, '');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== issuer || !audiences.includes(env.CF_ACCESS_AUD) || !payload.exp || payload.exp * 1000 <= Date.now()) return null;

  if (!jwksCache.keys.length || Date.now() - jwksCache.at > 3600000) {
    const response = await fetch(issuer + '/cdn-cgi/access/certs', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const body = await response.json();
    jwksCache = { at: Date.now(), keys: body.keys || [] };
  }
  const jwk = jwksCache.keys.find((key) => key.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    { name:'RSASSA-PKCS1-v1_5' }, key, decodeBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  return valid ? payload : null;
}

export async function authenticate(request, env) {
  const url = new URL(request.url);
  if (env.LOCAL_AUTH_BYPASS === 'true' && ['localhost','127.0.0.1'].includes(url.hostname)) {
    return { email: env.LOCAL_AUTH_EMAIL || 'local@verre.test', source: 'local' };
  }

  const accessToken = request.headers.get('cf-access-jwt-assertion');
  if (accessToken) {
    try {
      const payload = await verifyAccessJwt(accessToken, env);
      if (payload?.email && allowed(payload.email, env)) return { email: payload.email, source: 'cloudflare-access' };
    } catch {}
    return null;
  }

  // Sites' owner-only dispatcher authenticates before forwarding this header.
  const sitesEmail = request.headers.get('oai-authenticated-user-email');
  if (env.TRUST_SITES_AUTH === 'true' && sitesEmail && (!env.ADMIN_EMAILS || allowed(sitesEmail, env))) {
    return { email: sitesEmail, source: 'sites' };
  }
  return null;
}

export const authError = () => new Response(JSON.stringify({
  ok:false, error:'Authentication required', code:'AUTH_REQUIRED'
}), { status:401, headers:{'content-type':'application/json; charset=utf-8'} });

export const _test = { decodePart, allowed, verifyAccessJwt };
