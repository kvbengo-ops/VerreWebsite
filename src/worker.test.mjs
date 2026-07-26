// node src/worker.test.mjs — fails loudly if inquiry validation or pricing drifts.
import assert from 'node:assert/strict';
import worker, { _test } from './worker.js';

const { validate, resolveOrder, makeRef, compose, rateLimited, hits } = _test;

const order = (over = {}) => ({
  type: 'order',
  name: 'Ana',
  email: 'ana@example.com',
  fulfillment: 'pickup',
  items: [{ id: 'peach-sky-glass-panel', qty: 2 }],
  ...over
});

// prices come from the catalog, never the client
const ok = validate(order({ items: [{ id: 'peach-sky-glass-panel', qty: 2, price: 1 }] }));
assert.equal(ok.error, undefined);
assert.equal(ok.subtotal, 0);
const priced = await resolveOrder({}, ok.items);
assert.equal(priced.error, undefined);
assert.equal(priced.subtotal, 1700);

// rejections, each with the field the form should focus
const rejects = [
  [order({ type: 'gift' }), 'type'],
  [order({ name: '   ' }), 'name'],
  [order({ name: 'x'.repeat(101) }), 'name'],
  [order({ email: 'ana@example' }), 'email'],
  [order({ email: 'a b@example.com' }), 'email'],
  [order({ phone: '9'.repeat(31) }), 'phone'],
  [order({ fulfillment: 'teleport' }), 'fulfillment'],
  [order({ items: [] }), 'items'],
  [order({ items: Array(60).fill({ id: 'star-cookie-charm', qty: 1 }) }), 'items'],
  [order({ items: [{ id: 'star-cookie-charm', qty: 0 }] }), 'items'],
  [order({ items: [{ id: 'star-cookie-charm', qty: 999 }] }), 'items'],
  [order({ items: [{ id: 'star-cookie-charm', qty: 1.5 }] }), 'items'],
  [{ type: 'contact', name: 'Ana', email: 'ana@example.com' }, 'message'],
  [{ type: 'custom', name: 'Ana', email: 'ana@example.com', message: 'x'.repeat(2001) }, 'message']
];
for (const [body, field] of rejects) {
  const r = validate(body);
  assert.ok(r.error, 'should have been rejected: ' + JSON.stringify(body).slice(0, 60));
  assert.equal(r.field, field);
}

// contact/custom skip the order-only fields entirely
assert.equal(validate({ type: 'contact', name: 'Ana', email: 'ana@example.com', message: 'hi' }).error, undefined);

assert.match(makeRef(), /^VR-[A-Z2-9]{4}$/);

// user input never lands raw in the HTML email
const unsafe = validate(order({ name: '<script>x</script>' }));
const unsafePriced = await resolveOrder({}, unsafe.items);
const mail = compose({ ...unsafe, ...unsafePriced }, 'VR-TEST');
assert.ok(!mail.ownerHtml.includes('<script>'));
assert.ok(mail.ownerHtml.includes('&lt;script&gt;'));
assert.ok(mail.customerText.includes('VR-TEST'));

// 5 through, 6th blocked
hits.clear();
for (let i = 0; i < 5; i++) assert.equal(rateLimited('1.2.3.4'), false, 'request ' + (i + 1));
assert.equal(rateLimited('1.2.3.4'), true);
assert.equal(rateLimited('5.6.7.8'), false, 'other IPs unaffected');

const env = {
  RESEND_API_KEY: 'test-key',
  OWNER_EMAIL: 'owner@example.com',
  FROM_EMAIL: 'Verre <hello@example.com>',
  ASSETS: { fetch: async () => new Response('asset') }
};
const request = (body, options = {}) => new Request('https://verre.test/api/inquiry', {
  method: options.method || 'POST',
  headers: {
    'content-type': 'application/json',
    'CF-Connecting-IP': options.ip || 'endpoint-test',
    ...(options.headers || {})
  },
  body: options.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
});

assert.equal((await worker.fetch(request(null, { method: 'GET' }), env)).status, 405);
assert.equal((await worker.fetch(request('{nope'), env)).status, 400);
assert.equal((await worker.fetch(request(order({ items: [{ id: 'missing', qty: 1 }] })), env)).status, 400);
assert.equal((await worker.fetch(request(order({ items: [{ id: 'star-cookie-charm', qty: 999 }] })), env)).status, 400);
assert.equal((await worker.fetch(request('💗'.repeat(9000)), env)).status, 400, 'UTF-8 byte length is enforced');

const originalFetch = globalThis.fetch;
const deliveries = [];
globalThis.fetch = async (_url, options) => {
  deliveries.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ id: 'email-id' }), { status: 200 });
};
hits.clear();
const sent = await worker.fetch(request(order(), { ip: 'send-test' }), env);
assert.equal(sent.status, 200);
assert.match((await sent.json()).ref, /^VR-[A-Z2-9]{4}$/);
assert.equal(deliveries.length, 2, 'owner and customer both receive mail');
assert.equal(deliveries[0].reply_to, 'ana@example.com');
assert.ok(deliveries[0].text.includes('₱1,700'), 'server catalog price appears in owner copy');

let call = 0;
globalThis.fetch = async () => {
  call += 1;
  return call === 1 ? new Response('{}', { status: 200 }) : new Response('{}', { status: 500 });
};
hits.clear();
assert.equal((await worker.fetch(request(order(), { ip: 'confirmation-fail-test' }), env)).status, 200, 'confirmation failure does not lose an order');

// With no database configured AND no mailer, nothing survives the request, so
// failing honestly is correct. (The inverse — row saved, mailer down, expect 200
// — needs a real database; it is covered by the local Supabase e2e run.)
hits.clear();
globalThis.fetch = async () => new Response('{}', { status: 500 });
const unconfigured = await worker.fetch(
  request(order(), { ip: 'unconfigured' }),
  { ...env, RESEND_API_KEY: '', OWNER_EMAIL: '', FROM_EMAIL: '' }
);
assert.equal(unconfigured.status, 502, 'nothing recorded and nothing emailed must not report success');

hits.clear();
const mailerDown = await worker.fetch(request(order(), { ip: 'mailer-down' }), env);
assert.equal(mailerDown.status, 502, 'no database either, so a dead mailer still fails honestly');

globalThis.fetch = originalFetch;

// The admin and POS shells are static files. Guarding only /api/admin/* would
// leave the whole console readable to anyone who guesses the path — which is
// exactly what happens on a workers.dev host, where Cloudflare Access cannot
// be attached at all.
const shellEnv = { ...env, LOCAL_AUTH_BYPASS: 'true', LOCAL_AUTH_EMAIL: 'local@verre.test', SUPER_ADMIN_EMAILS: 'local@verre.test' };
const shell = (path, host) => worker.fetch(new Request('https://' + host + path), shellEnv);

for (const path of ['/admin', '/admin/', '/admin/app.js', '/pos', '/pos/sw.js', '/pos/manifest.json']) {
  assert.equal((await shell(path, 'verre.workers.dev')).status, 401, path + ' is not public');
  assert.equal((await shell(path, 'localhost')).status, 200, path + ' opens for local dev');
}
assert.equal((await shell('/', 'verre.workers.dev')).status, 200, 'the storefront stays public');
assert.equal((await shell('/index.html', 'verre.workers.dev')).status, 200, 'storefront assets stay public');

// Directory indexes belong to the asset layer. Rewriting '/admin/' to
// '/admin/index.html' here makes it canonicalise back to '/admin/', and because
// run_worker_first routes that through the Worker too, the browser ping-pongs
// until it gives up with ERR_TOO_MANY_REDIRECTS.
const seen = [];
const recordingEnv = {
  ...shellEnv,
  ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('asset'); } }
};
for (const path of ['/admin', '/admin/', '/pos', '/pos/', '/admin/app.js']) {
  seen.length = 0;
  await worker.fetch(new Request('https://localhost' + path), recordingEnv);
  assert.deepEqual(seen, [path], 'the Worker must hand ' + path + ' to ASSETS unrewritten');
}

console.log('ok');
