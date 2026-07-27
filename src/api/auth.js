import { json, body } from './http.js';
import {
  COOKIE_NAME,
  SESSION_TTL_MS,
  RESET_TTL_MS,
  createSession,
  createReset,
  consumeReset,
  hashToken,
  revokeSession,
  revokeAllSessions,
  revokeOtherSessions,
  verifyPassword,
  setPassword,
  accountByEmailForAuth
} from '../db/sessions.js';
import { CAPABILITIES } from '../roles.js';

const MIN_PASSWORD = 12;

// Every failed sign-in says exactly this, whatever went wrong. Distinguishing
// "no such account" from "wrong password" from "locked" turns the login form
// into a directory of who works here and a probe for which accounts are worth
// attacking.
const GENERIC_LOGIN_ERROR = 'That email or password is not right.';

// Passwords people reach for when a form says "12 characters minimum". Not a
// substitute for a real breach corpus — just the handful that would otherwise
// sail through a length check.
const OBVIOUS = new Set([
  'password1234', 'passwordpassword', '123456789012', 'qwertyqwerty',
  'letmeinletmein', 'administrator', 'verrecrafts1', 'aaaaaaaaaaaa'
]);

/* ------------------------------------------------------------------ */
/* cookies                                                             */
/* ------------------------------------------------------------------ */

export function readCookie(request, name = COOKIE_NAME) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// `Secure` is dropped only on plain-http localhost, where the browser would
// otherwise refuse to store the cookie and local dev would look broken. Every
// other host — including any deployed one — gets it.
const isLocalHttp = (url) =>
  url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);

export function sessionCookie(token, url, maxAgeMs = SESSION_TTL_MS) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (!isLocalHttp(url)) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = (url) => {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (!isLocalHttp(url)) parts.push('Secure');
  return parts.join('; ');
};

/* ------------------------------------------------------------------ */
/* rate limiting                                                       */
/* ------------------------------------------------------------------ */

// KV-backed when available, in-memory otherwise.
//
// The in-memory map in worker.js is fine for the contact form — a flooder who
// waits out an isolate recycle just sends another enquiry. It is NOT fine for a
// password gate, where surviving a recycle is the whole point. Bind AUTH_LIMITS
// in production; the fallback exists so local dev and tests still work.
const memory = new Map();

async function hitCount(env, key, windowMs) {
  const now = Date.now();
  if (env.AUTH_LIMITS) {
    const raw = await env.AUTH_LIMITS.get(key);
    const times = (raw ? JSON.parse(raw) : []).filter((t) => now - t < windowMs);
    times.push(now);
    await env.AUTH_LIMITS.put(key, JSON.stringify(times), {
      expirationTtl: Math.max(60, Math.ceil(windowMs / 1000))
    });
    return times.length;
  }
  const times = (memory.get(key) || []).filter((t) => now - t < windowMs);
  times.push(now);
  memory.set(key, times);
  if (memory.size > 2000) {
    for (const [k, v] of memory) if (!v.some((t) => now - t < windowMs)) memory.delete(k);
  }
  return times.length;
}

const tooMany = (retryAfter = 900) =>
  json(429, { ok: false, error: 'Too many attempts. Try again shortly.', code: 'RATE_LIMITED' },
    { 'retry-after': String(retryAfter) });

/**
 * Sign-in could not be attempted — the database was unreachable or not
 * configured. Distinct from a wrong password, which is a 401.
 *
 * The visible message stays vague on purpose, but a misconfigured deployment
 * and a database outage need different fixes, and "temporarily unavailable"
 * tells whoever is deploying nothing. `NOT_CONFIGURED` means the secrets were
 * never set on this Worker, so say that much in the code field and log the
 * rest — the details live in `wrangler tail`, not in the response.
 */
const unavailable = (error) => json(503, {
  ok: false,
  error: error?.code === 'NOT_CONFIGURED'
    ? 'Sign-in is not configured on this deployment yet.'
    : 'Sign-in is temporarily unavailable.',
  code: error?.code === 'NOT_CONFIGURED' ? 'AUTH_NOT_CONFIGURED' : 'AUTH_UNAVAILABLE'
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const ip = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

const publicUser = (identity) => ({
  email: identity.email,
  display_name: identity.display_name || identity.email,
  role: identity.role,
  capabilities: CAPABILITIES[identity.role] || []
});

export function passwordProblem(password) {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return 'That password is too long.';
  // Length is the property that actually matters, so no character-class rules —
  // they push people toward "Password1!" and away from a long passphrase.
  if (OBVIOUS.has(password.toLowerCase())) return 'Please choose something less guessable.';
  return null;
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

export async function authApi(request, env, url, identity) {
  const route = url.pathname.replace(/^\/api\/auth\/?/, '');

  if (route === 'me') {
    if (request.method !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });
    return identity
      ? json(200, { ok: true, data: { user: publicUser(identity) } })
      : json(401, { ok: false, error: 'Not signed in', code: 'AUTH_REQUIRED' });
  }

  if (request.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed' }, { allow: 'POST' });

  switch (route) {
    case 'login': return login(request, env, url);
    case 'logout': return logout(request, env, url);
    case 'logout-all': return logoutAll(request, env, url, identity);
    case 'request-reset': return requestReset(request, env, url);
    case 'reset': return resetPassword(request, env, url);
    case 'change-password': return changePassword(request, env, url, identity);
    default: return json(404, { ok: false, error: 'Not found' });
  }
}

/* ------------------------------------------------------------------ */

async function login(request, env, url) {
  const parsed = await body(request, 4096);
  if (parsed.error) return json(400, { ok: false, error: parsed.error });

  const email = clean(parsed.data.email).toLowerCase();
  const password = typeof parsed.data.password === 'string' ? parsed.data.password : '';

  // Both limits run before any database work, so a flood costs us nothing.
  if (await hitCount(env, `ip:${ip(request)}`, 15 * 60 * 1000) > 10) return tooMany();
  if (email && await hitCount(env, `acct:${email}`, 15 * 60 * 1000) > 10) return tooMany();

  if (!email || !EMAIL_RE.test(email) || !password) {
    return json(400, { ok: false, error: GENERIC_LOGIN_ERROR, code: 'INVALID_CREDENTIALS' });
  }

  const verified = await verifyPassword(env, email, password);
  if (verified.error) {
    console.error('auth: verify_password failed — ' + verified.error.code);
    return unavailable(verified.error);
  }
  if (!verified.data?.ok) {
    // The reason code (INVALID vs LOCKED) is deliberately not surfaced.
    console.warn('auth: login failed for ' + email + ' from ' + ip(request) + ' — ' + verified.data?.reason);
    return json(401, { ok: false, error: GENERIC_LOGIN_ERROR, code: 'INVALID_CREDENTIALS' });
  }

  const account = verified.data.account;
  const created = await createSession(env, account.id, request);
  if (created.error) {
    console.error('auth: session create failed — ' + created.error.code);
    return unavailable(created.error);
  }

  console.log('auth: login ok for ' + email);
  // A fresh token on every login — a session fixed before sign-in is worthless
  // to whoever fixed it.
  return json(200, { ok: true, data: { user: publicUser(account) } },
    { 'set-cookie': sessionCookie(created.data.token, url) });
}

async function logout(request, env, url) {
  const token = readCookie(request);
  if (token) {
    const revoked = await revokeSession(env, await hashToken(token));
    // Clearing the cookie without revoking server-side leaves a working
    // credential in whatever captured it. If the write failed, say so rather
    // than reporting a sign-out that did not happen.
    if (revoked.error) {
      console.error('auth: logout revoke failed — ' + revoked.error.code);
      return json(503, { ok: false, error: 'Could not sign out. Please try again.', code: 'LOGOUT_FAILED' });
    }
  }
  return json(200, { ok: true, data: { signedOut: true } }, { 'set-cookie': clearCookie(url) });
}

async function logoutAll(request, env, url, identity) {
  if (!identity?.account_id) return json(401, { ok: false, error: 'Not signed in', code: 'AUTH_REQUIRED' });
  const revoked = await revokeAllSessions(env, identity.account_id);
  if (revoked.error) return json(503, { ok: false, error: 'Could not sign out everywhere.', code: 'LOGOUT_FAILED' });
  return json(200, { ok: true, data: { signedOut: true } }, { 'set-cookie': clearCookie(url) });
}

async function requestReset(request, env, url) {
  const parsed = await body(request, 2048);
  if (parsed.error) return json(400, { ok: false, error: parsed.error });
  const email = clean(parsed.data.email).toLowerCase();

  if (await hitCount(env, `reset:${ip(request)}`, 60 * 60 * 1000) > 5) return tooMany(3600);

  // Always 200, always the same body, whether or not the account exists. A
  // reset endpoint that answers honestly is an account-enumeration oracle.
  const ok = json(200, {
    ok: true,
    data: { message: 'If that email has an account, a reset link is on its way.' }
  });

  if (!email || !EMAIL_RE.test(email)) return ok;

  const found = await accountByEmailForAuth(env, email);
  const account = found.data?.[0];
  if (found.error || !account) return ok;

  const reset = await createReset(env, account.id);
  if (reset.error) {
    console.error('auth: reset token create failed — ' + reset.error.code);
    return ok;
  }

  const link = new URL('/login/reset', url.origin);
  link.searchParams.set('token', reset.data.token);

  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    // Without mail there is no way to deliver the link. Log that the request
    // happened — never the token, which is a live credential.
    console.error('auth: reset requested for ' + email + ' but email is not configured');
    return ok;
  }
  await sendResetEmail(env, account, link.toString());
  return ok;
}

async function sendResetEmail(env, account, link) {
  const minutes = Math.round(RESET_TTL_MS / 60000);
  const text = [
    'Hi ' + (account.display_name || '') + ',',
    '',
    'Here is your link to set a new Verre password:',
    link,
    '',
    'It works once and expires in ' + minutes + ' minutes.',
    'If you did not ask for this, you can ignore this email — nothing has changed.',
    '',
    '— Verre'
  ].join('\n');
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: account.email,
        subject: 'Reset your Verre password',
        text
      }),
      signal: AbortSignal.timeout(8000)
    });
  } catch (error) {
    console.error('auth: reset email failed — ' + (error?.name || 'unknown'));
  }
}

async function resetPassword(request, env, url) {
  const parsed = await body(request, 4096);
  if (parsed.error) return json(400, { ok: false, error: parsed.error });
  const token = clean(parsed.data.token);
  const password = typeof parsed.data.password === 'string' ? parsed.data.password : '';

  if (await hitCount(env, `resetuse:${ip(request)}`, 15 * 60 * 1000) > 10) return tooMany();

  const problem = passwordProblem(password);
  if (problem) return json(400, { ok: false, error: problem, field: 'password' });
  if (!token) return json(400, { ok: false, error: 'That reset link is not valid.', code: 'BAD_TOKEN' });

  const consumed = await consumeReset(env, token);
  if (consumed.error) return json(503, { ok: false, error: 'Could not reset the password just now.' });
  if (!consumed.data) {
    return json(400, { ok: false, error: 'That reset link has expired or already been used.', code: 'BAD_TOKEN' });
  }

  // set_password revokes every existing session for the account. A reset is
  // the response to a possible compromise, so anything already signed in goes.
  const saved = await setPassword(env, consumed.data.accountId, password, 'password-reset');
  if (saved.error) {
    return json(400, { ok: false, error: saved.error.message || 'Could not set that password.' });
  }
  return json(200, { ok: true, data: { message: 'Password updated. You can sign in now.' } },
    { 'set-cookie': clearCookie(url) });
}

async function changePassword(request, env, url, identity) {
  if (!identity?.account_id) return json(401, { ok: false, error: 'Not signed in', code: 'AUTH_REQUIRED' });
  const parsed = await body(request, 4096);
  if (parsed.error) return json(400, { ok: false, error: parsed.error });

  const current = typeof parsed.data.current === 'string' ? parsed.data.current : '';
  const next = typeof parsed.data.password === 'string' ? parsed.data.password : '';

  if (await hitCount(env, `change:${identity.email}`, 15 * 60 * 1000) > 10) return tooMany();

  const problem = passwordProblem(next);
  if (problem) return json(400, { ok: false, error: problem, field: 'password' });
  if (next === current) return json(400, { ok: false, error: 'That is the password you already have.', field: 'password' });

  // Re-authenticate. Without this, a borrowed unlocked laptop becomes a
  // permanent account takeover.
  const verified = await verifyPassword(env, identity.email, current);
  if (verified.error || !verified.data?.ok) {
    return json(401, { ok: false, error: 'Your current password is not right.', field: 'current' });
  }

  const saved = await setPassword(env, identity.account_id, next, identity.email);
  if (saved.error) return json(400, { ok: false, error: saved.error.message || 'Could not set that password.' });

  // set_password revoked everything including this browser, so mint a
  // replacement — changing your own password should not sign you out.
  const created = await createSession(env, identity.account_id, request);
  if (created.error) {
    return json(200, { ok: true, data: { message: 'Password updated. Please sign in again.' } },
      { 'set-cookie': clearCookie(url) });
  }
  await revokeOtherSessions(env, identity.account_id, await hashToken(created.data.token));
  return json(200, { ok: true, data: { message: 'Password updated.' } },
    { 'set-cookie': sessionCookie(created.data.token, url) });
}

export const _test = { readCookie, sessionCookie, clearCookie, passwordProblem, GENERIC_LOGIN_ERROR };
