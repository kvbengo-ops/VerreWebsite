import { readCookie } from './api/auth.js';
import { hashToken, identityForToken } from './db/sessions.js';

let jwksCache = { at: 0, keys: [] };

const decodePart = (part) => {
  const value = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0))));
};
const decodeBytes = (part) => {
  const value = part.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
};

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

/**
 * Establish who is asking, in priority order:
 *
 *   1. A Verre session cookie — the system we own, and the normal path.
 *   2. Cloudflare Access — kept because it is correctly verified, costs nothing
 *      when unconfigured, and layering it in front of /admin later is real
 *      defence in depth.
 *   3. The localhost dev bypass — hostname-gated, cannot work deployed.
 *
 * The hosting dispatcher's `oai-authenticated-user-email` header used to be a
 * fourth path. It was an unsigned string whose trustworthiness rested entirely
 * on deployment topology, and it is gone. Do not reintroduce it: a disabled
 * auth path is a re-enabled auth path six months from now.
 */
export async function authenticate(request, env) {
  const url = new URL(request.url);

  const token = readCookie(request);
  if (token) {
    const result = await identityForToken(env, await hashToken(token));
    // A present-but-unresolvable cookie is a signed-out browser, not a reason
    // to fall through and try a weaker method.
    if (result.error) {
      console.error('auth: session lookup failed — ' + result.error.code);
      return null;
    }
    const row = result.data;
    if (row?.email) {
      return {
        email: row.email,
        name: row.display_name || row.email,
        account_id: row.account_id,
        session_id: row.session_id,
        role: row.role,
        source: 'session'
      };
    }
    return null;
  }

  const accessToken = request.headers.get('cf-access-jwt-assertion');
  if (accessToken) {
    try {
      const payload = await verifyAccessJwt(accessToken, env);
      if (payload?.email) {
        return { email: payload.email, name: payload.name || payload.email, source: 'cloudflare-access' };
      }
    } catch {}
    return null;
  }

  if (env.LOCAL_AUTH_BYPASS === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
    return {
      email: env.LOCAL_AUTH_EMAIL || 'local@verre.test',
      name: env.LOCAL_AUTH_NAME || 'Local Super Admin',
      source: 'local'
    };
  }

  return null;
}

// Length-leaking but not content-leaking. Kept for comparing any secret that
// arrives from outside.
function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export const authError = () => new Response(JSON.stringify({
  ok:false, error:'Authentication required', code:'AUTH_REQUIRED'
}), { status:401, headers:{'content-type':'application/json; charset=utf-8'} });

export const _test = { decodePart, verifyAccessJwt, constantTimeEqual };
