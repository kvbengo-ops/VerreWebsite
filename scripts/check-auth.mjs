// node scripts/check-auth.mjs   (needs a reachable database)
//
// The role paths that src/worker.test.mjs cannot cover: everything past the
// bootstrap list needs a real admin_accounts table, and faking one proves
// nothing about the query that actually runs.
//
// Reads .dev.vars, so it checks whichever database you are pointed at.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dev = await readFile(resolve(root, '.dev.vars'), 'utf8');
const pick = (k) => (dev.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1]?.trim();

const base = {
  SUPABASE_URL: pick('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: pick('SUPABASE_SERVICE_ROLE_KEY'),
  LOCAL_AUTH_BYPASS: 'true',
  ASSETS: { fetch: async () => new Response('asset') }
};
assert.ok(base.SUPABASE_URL && base.SUPABASE_SERVICE_ROLE_KEY, '.dev.vars needs SUPABASE_URL and the service key');
console.log('checking against ' + base.SUPABASE_URL);

const me = (env) => worker.fetch(new Request('http://localhost/api/admin/me'), env);
const boss = (pick('SUPER_ADMIN_EMAILS') || pick('LOCAL_AUTH_EMAIL') || 'local@verre.test')
  .split(',')[0].trim();

// 1. the bootstrap account gets in with no database row at all
const ok = await me({ ...base, LOCAL_AUTH_EMAIL: boss, SUPER_ADMIN_EMAILS: boss });
const okBody = await ok.json();
assert.equal(ok.status, 200, 'the bootstrap super admin must be admitted');
assert.equal(okBody.user.role, 'super_admin');
console.log('bootstrap super admin      200', okBody.user.role);

// 2. a configured list plus an unlisted email is a real permission refusal
const stranger = await me({ ...base, LOCAL_AUTH_EMAIL: 'stranger@example.com', SUPER_ADMIN_EMAILS: boss });
assert.equal(stranger.status, 403, 'an unlisted email with no account row is forbidden');
assert.equal((await stranger.json()).code, 'FORBIDDEN');
console.log('unlisted email             403 FORBIDDEN');

// 3. no bootstrap list at all is a deployment fault, not a role problem —
//    nobody can be granted the first role, including whoever would grant it
const unset = { ...base, LOCAL_AUTH_EMAIL: 'anyone@example.com' };
const lockedOut = await me(unset);
const lockedBody = await lockedOut.json();
assert.equal(lockedOut.status, 503, 'a missing bootstrap list must not masquerade as 403');
assert.equal(lockedBody.code, 'NO_ADMIN_CONFIGURED');
console.log('no SUPER_ADMIN_EMAILS      503 NO_ADMIN_CONFIGURED');

// 4. the console is never public, whatever the role situation is
for (const path of ['/admin/', '/admin/app.js', '/pos/sw.js', '/api/admin/me']) {
  const res = await worker.fetch(new Request('https://verre.workers.dev' + path), { ...base, LOCAL_AUTH_EMAIL: boss, SUPER_ADMIN_EMAILS: boss });
  assert.equal(res.status, 401, path + ' must be refused on a deployed host');
}
console.log('deployed host              401 on every protected path');

console.log('\nok');
