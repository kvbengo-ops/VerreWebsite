#!/usr/bin/env node
/**
 * Create or update an admin account and set its password.
 *
 * Deliberately a terminal script and not an HTTP endpoint. A "create the first
 * admin" route is either reachable by anybody before setup or guarded by a flag
 * somebody forgets to turn off; both end the same way. Running this requires
 * the service role key, which means filesystem access to .dev.vars.
 *
 *   npm run create-admin
 *   npm run create-admin -- --email you@example.com --role super_admin
 *
 * This is also the break-glass path: if you lock yourself out and password
 * reset cannot send email, re-run this to set a new password.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, exit } from 'node:process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = ['super_admin', 'general_admin', 'cashier'];

async function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = await readFile(resolve(root, '.dev.vars'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      // Real environment wins, so CI and one-off overrides work.
      if (!env[key]) env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch { /* no .dev.vars — rely on the real environment */ }
  return env;
}

const arg = (name) => {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? null : process.argv[index + 1];
};

async function rest(env, path, options = {}) {
  const response = await fetch(env.SUPABASE_URL.replace(/\/+$/, '') + path, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(data?.message || data?.error || 'HTTP ' + response.status);
  return data;
}

const env = await loadEnv();
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (in .dev.vars or the environment).');
  exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });

try {
  const email = (arg('email') || await rl.question('Email: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) throw new Error('That email does not look valid.');

  const existing = await rest(env, `/rest/v1/admin_accounts?select=id,display_name,role&email=eq.${encodeURIComponent(email)}&limit=1`);
  const account = existing?.[0] || null;
  if (account) console.log(`Updating existing account (${account.role}).`);

  const displayName = account
    ? account.display_name
    : ((arg('name') || await rl.question('Display name: ')).trim() || email);

  const role = account
    ? account.role
    : ((arg('role') || await rl.question(`Role [${ROLES.join(' / ')}] (super_admin): `)).trim() || 'super_admin');
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);

  // Not hidden. Node has no portable way to mask terminal input without a
  // dependency, and a half-working mask is worse than an honest warning.
  console.log('\nPassword input is NOT hidden. Make sure nobody is reading your screen.');
  const password = arg('password') || await rl.question('Password (12+ characters): ');
  if (password.length < 12) throw new Error('Password must be at least 12 characters.');
  if (!arg('password')) {
    const confirm = await rl.question('Confirm password: ');
    if (confirm !== password) throw new Error('Those passwords do not match.');
  }

  const saved = account
    ? account
    : await rest(env, '/rest/v1/rpc/set_admin_account', {
        method: 'POST',
        body: JSON.stringify({
          p_id: null,
          p_email: email,
          p_display_name: displayName,
          p_role: role,
          p_active: true,
          p_actor: 'create-admin-script'
        })
      });

  await rest(env, '/rest/v1/rpc/set_password', {
    method: 'POST',
    body: JSON.stringify({
      p_account_id: saved.id,
      p_password: password,
      p_actor: 'create-admin-script'
    })
  });

  console.log(`\n✓ ${email} can now sign in at /login as ${role}.`);
  if (account) console.log('  All existing sessions for this account were revoked.');
} catch (error) {
  console.error('\n✗ ' + error.message);
  exit(1);
} finally {
  rl.close();
}
