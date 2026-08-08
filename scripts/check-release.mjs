import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root=resolve(import.meta.dirname,'..');
const read=(...parts)=>readFile(resolve(root,...parts),'utf8');
const [storefront,pos,posHtml,adminHtml,admin,worker,auth,build,policies,wrangler,migration]=await Promise.all([
  read('index.html'),read('pos','app.js'),read('pos','index.html'),read('admin','index.html'),read('admin','app.js'),
  read('src','worker.js'),read('src','api','auth.js'),read('scripts','build.mjs'),read('policies','index.html'),
  read('wrangler.toml'),read('supabase','migrations','20260808090000_launch_readiness_and_pos_sessions.sql')
]);

for(const [name,text] of Object.entries({storefront,pos,posHtml,adminHtml,admin,worker,auth,build,policies,wrangler,migration})){
  assert.ok(!text.includes('\0'),name+' must not contain NUL bytes');
}
assert.match(storefront,/<script src="\/support\.js"><\/script>/,'storefront runtime must be root-relative');
assert.ok(!storefront.includes("./assets/verre-photo-atlas"),'product permalinks must not resolve atlas paths below /products');
assert.ok(!/href="#top" aria-label="(?:Instagram|Facebook)"/.test(storefront),'unverified social placeholders must not ship');
assert.match(storefront,/attachedResponse\.ok/,'photo attachment status must be verified');
assert.match(storefront,/body\.stale && cached\.length/,'stale responses must preserve a browser last-known-good catalog');
assert.doesNotMatch(storefront,/details:\s*\{\s*\.\.\.this\.state\.customDraft/,'personal contact and address data must not be persisted as a draft');
assert.match(storefront,/\/policies\/#privacy/,'customer forms must link the privacy notice');

assert.doesNotMatch(pos,/setTimeout\(nextSale\s*,\s*4000\)/,'receipts must wait for explicit dismissal');
assert.match(pos,/session_open/);assert.match(pos,/session_close/);assert.match(pos,/syncSessionOpens\(\)/);assert.match(pos,/syncSessionCloses\(\)/);
assert.match(pos,/operator_email/,'offline records must be bound to the verified operator');
assert.match(pos,/state\.syncDelay=Math\.min\(state\.syncDelay\*2,30000\)/,'retry backoff must persist across calls');
assert.match(pos,/data-review-export/);assert.match(pos,/data-review-retry/);
assert.match(posHtml,/for="search">Search products/);assert.match(posHtml,/aria-labelledby="queue-title"/);
assert.equal((posHtml.match(/data-close aria-label=/g)||[]).length,2,'POS close buttons need accessible names');

assert.match(adminHtml,/href="\/admin\/#dashboard"/);
assert.match(admin,/localStorage\.setItem\('verre\.pos\.locked','1'\)/,'admin logout must lock the offline POS');
assert.match(admin,/class="order-link"/,'interactive order rows must use real buttons');
assert.match(worker,/content-security-policy-report-only/);assert.match(worker,/strict-transport-security/);assert.match(worker,/requiredWizardReady/);
assert.match(auth,/if \(!response\.ok\)/,'reset email provider rejection must be observed');
assert.match(build,/assertNoNulBytes/);assert.match(wrangler,/RATE_LIMITER/);assert.match(wrangler,/run_worker_first\s*=\s*\["\/\*"\]/);
assert.match(migration,/open_pos_session/);assert.match(migration,/close_pos_session/);assert.match(migration,/on conflict \(slug\) do nothing/);

console.log('ok - release audit regression checks');
