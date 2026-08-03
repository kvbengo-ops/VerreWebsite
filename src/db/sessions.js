import { db } from './client.js';

// 24 hours, fixed. Not sliding — a session that renews on every request never
// actually expires for anyone who keeps the tab open.
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const COOKIE_NAME = 'verre_session';

const encode = encodeURIComponent;

/** 32 bytes of CSPRNG output, base64url. Never Math.random. */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * What lands in the database. The cookie holds the token; the row holds this.
 * Anyone who reads the table learns nothing they can replay.
 */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const verifyPassword = (env, email, password) =>
  db(env).rpc('verify_password', { p_email: email, p_password: password });

export const setPassword = (env, accountId, password, actor) =>
  db(env).rpc('set_password', { p_account_id: accountId, p_password: password, p_actor: actor });

export const identityForToken = (env, tokenHash) =>
  db(env).rpc('session_identity', { p_token_hash: tokenHash });

export async function createSession(env, accountId, request) {
  const token = newToken();
  const result = await db(env).rest('admin_sessions', '', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      account_id: accountId,
      token_hash: await hashToken(token),
      // Truncated: these are for "was that me?", not forensics, and an
      // unbounded header should never become an unbounded column.
      user_agent: (request.headers.get('user-agent') || '').slice(0, 300),
      ip: (request.headers.get('CF-Connecting-IP') || '').slice(0, 60),
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    })
  });
  if (result.error) return result;
  return { data: { token, session: result.data?.[0] || null }, error: null };
}

export const revokeSession = (env, tokenHash) =>
  db(env).rest('admin_sessions', `token_hash=eq.${encode(tokenHash)}&revoked_at=is.null`, {
    method: 'PATCH',
    body: JSON.stringify({ revoked_at: new Date().toISOString() })
  });

export const revokeAllSessions = (env, accountId) =>
  db(env).rest('admin_sessions', `account_id=eq.${encode(accountId)}&revoked_at=is.null`, {
    method: 'PATCH',
    body: JSON.stringify({ revoked_at: new Date().toISOString() })
  });

/** Everything except the one currently in use — for password changes. */
export const revokeOtherSessions = (env, accountId, keepTokenHash) =>
  db(env).rest(
    'admin_sessions',
    `account_id=eq.${encode(accountId)}&revoked_at=is.null&token_hash=neq.${encode(keepTokenHash)}`,
    { method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString() }) }
  );

export async function createReset(env, accountId) {
  // A resend replaces every older unused link. Without this, the first email
  // would remain a live credential even after an administrator deliberately
  // issued a newer invitation or the user requested another reset.
  const replaced = await db(env).rest(
    'password_resets',
    `account_id=eq.${encode(accountId)}&used_at=is.null`,
    { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) }
  );
  if (replaced.error) return replaced;
  const token = newToken();
  const result = await db(env).rest('password_resets', '', {
    method: 'POST',
    body: JSON.stringify({
      account_id: accountId,
      token_hash: await hashToken(token),
      expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString()
    })
  });
  return result.error ? result : { data: { token }, error: null };
}

export async function consumeReset(env, token) {
  const tokenHash = await hashToken(token);
  const found = await db(env).rest(
    'password_resets',
    `select=id,account_id,expires_at,used_at&token_hash=eq.${encode(tokenHash)}&limit=1`
  );
  if (found.error) return found;
  const row = found.data?.[0];
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) {
    return { data: null, error: null };
  }
  // Mark used before the password is set. If the write below fails the token is
  // spent anyway — a reset that has to be requested again is a far better
  // outcome than one that can be replayed.
  const spent = await db(env).rest(`password_resets`, `id=eq.${encode(row.id)}&used_at=is.null`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ used_at: new Date().toISOString() })
  });
  if (spent.error) return spent;
  if (!spent.data?.length) return { data: null, error: null }; // raced, already used
  return { data: { accountId: row.account_id }, error: null };
}

export const accountByEmailForAuth = (env, email) =>
  db(env).rest(
    'admin_accounts',
    `select=id,email,display_name,role&email=eq.${encode(String(email || '').toLowerCase())}&active=eq.true&limit=1`
  );
