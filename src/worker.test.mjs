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
assert.ok(mail.ownerHtml.startsWith('<!doctype html>'), 'owner mail uses the complete branded email shell');
assert.ok(mail.customerHtml.includes('Verre handmade crafts'), 'customer mail carries the Verre identity');
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

// Browser navigation to a protected shell goes to the login page. A fetch from
// already-loaded admin JS gets JSON — following a redirect there hands the
// caller HTML where it expected a payload, which is how "session expired"
// becomes an unreadable parse error.
for (const path of ['/admin', '/admin/', '/pos', '/pos/']) {
  const response = await worker.fetch(
    new Request('https://verre.test' + path, { headers: { 'sec-fetch-mode': 'navigate' } }),
    env
  );
  assert.equal(response.status, 302, path + ' sends a person to the login page');
  const location = new URL(response.headers.get('location'));
  assert.equal(location.pathname, '/login');
  assert.equal(location.searchParams.get('return_to'), path);
}
assert.equal(
  (await worker.fetch(new Request('https://verre.test/api/admin/me'), env)).status,
  401,
  'admin APIs never redirect to an HTML sign-in page'
);
assert.equal(
  (await worker.fetch(new Request('https://verre.test/admin/app.js'), env)).status,
  401,
  'protected static assets remain unavailable before sign-in'
);

// The old host sign-in entry points still resolve, so a stale bookmark or a
// cached admin bundle lands on /login instead of a 404.
for (const [raw, expected] of [['https://evil.com', '/'], ['//evil.com', '/'], ['/admin/', '/admin/']]) {
  const res = await worker.fetch(
    new Request('http://localhost/signout-with-chatgpt?return_to=' + encodeURIComponent(raw)),
    shellEnv
  );
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('location'));
  assert.equal(target.pathname, '/login');
  assert.equal(target.searchParams.get('return_to'), expected, 'return_to ' + raw + ' must resolve to ' + expected);
}

// The reset link is a real URL from an email, but it is the same document as
// /login — the token in the query string selects the view.
const resetSeen = [];
const resetEnv = { ...shellEnv, ASSETS: { fetch: async (req) => {
  const assetUrl = new URL(req.url);
  resetSeen.push(assetUrl.pathname + assetUrl.search);
  // This is the redirect Cloudflare applies to an explicit index filename and
  // the reason an invitation used to land on ordinary sign-in.
  if (assetUrl.pathname === '/login/index.html') return Response.redirect(new URL('/login/', assetUrl), 307);
  return new Response('page');
} } };
const resetPage = await worker.fetch(new Request('https://verre.test/login/reset?token=abc&invite=1'), resetEnv);
assert.equal(resetPage.status, 200, 'an invitation must render rather than redirect to sign-in');
assert.deepEqual(resetSeen, ['/login/?token=abc&invite=1'], '/login/reset serves the login document without losing its token');

// /login itself must never be gated, or the sign-in page hides behind sign-in.
assert.equal((await worker.fetch(new Request('https://verre.test/login'), shellEnv)).status, 200);

// Role resolution past the bootstrap list needs a real admin_accounts table, so
// NO_ADMIN_CONFIGURED vs FORBIDDEN is asserted in scripts/check-auth.mjs against
// a live database rather than faked here.

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

/* ------------------------------------------------------------------ */
/* newsletter                                                          */
/* ------------------------------------------------------------------ */

// Stub Supabase so subscribe() reaches the RPC without a database.
const subscribeCalls = [];
const realFetchNews = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/rpc/subscribe')) {
    subscribeCalls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, id: 'x', token: 'tok' }), { headers: { 'content-type': 'application/json' } });
  }
  if (path.endsWith('/rpc/unsubscribe')) {
    return new Response(JSON.stringify({ ok: true, removed: true }), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('null', { headers: { 'content-type': 'application/json' } });
};
const newsEnv = { ...env, SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const subscribe = (payload, headers = {}) => new Request('https://verre.test/api/subscribe', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload)
});

assert.equal((await worker.fetch(new Request('https://verre.test/api/subscribe'), newsEnv)).status, 405, 'GET is not a signup');
assert.equal((await worker.fetch(subscribe({ email: 'nope' }), newsEnv)).status, 400, 'a malformed address is rejected');
assert.equal((await worker.fetch(subscribe({}), newsEnv)).status, 400, 'a missing address is rejected');

subscribeCalls.length = 0;
const first = await worker.fetch(subscribe({ email: 'Someone@Example.com ' }, { 'CF-Connecting-IP': '10.0.0.9' }), newsEnv);
assert.equal(first.status, 200);
assert.equal(subscribeCalls[0].p_email, 'someone@example.com', 'the address is normalised before it reaches the database');

// Signing up twice is the most common thing a hesitant person does. It must
// look identical to a first signup — both to be kind, and because a different
// answer would reveal whether an address is already on the list.
const again = await worker.fetch(subscribe({ email: 'someone@example.com' }, { 'CF-Connecting-IP': '10.0.0.10' }), newsEnv);
assert.equal(again.status, 200);
assert.deepEqual(await again.json(), await first.json(), 'a repeat signup is indistinguishable from the first');

// Honeypot: answered as success, never written.
subscribeCalls.length = 0;
const trapped = await worker.fetch(subscribe({ email: 'bot@example.com', hp: 'filled' }, { 'CF-Connecting-IP': '10.0.0.11' }), newsEnv);
assert.equal(trapped.status, 200, 'a caught bot is told it worked');
assert.equal(subscribeCalls.length, 0, 'a caught bot is never written to the database');

// Shares the inquiry rate limiter, so a flood from one IP is capped.
let limited = false;
for (let i = 0; i < 8; i += 1) {
  const res = await worker.fetch(subscribe({ email: 'flood' + i + '@example.com' }, { 'CF-Connecting-IP': '10.9.9.9' }), newsEnv);
  if (res.status === 429) limited = true;
}
assert.ok(limited, 'repeated signups from one IP are rate limited');

// Unsubscribe must be calm and identical whether or not the token is real —
// otherwise it becomes a way to test tokens, and someone trying to leave a list
// should never meet an error page.
const goodToken = await worker.fetch(new Request('https://verre.test/unsubscribe?t=tok'), newsEnv);
const noToken = await worker.fetch(new Request('https://verre.test/unsubscribe'), newsEnv);
assert.equal(goodToken.status, 200);
assert.equal(noToken.status, 200, 'a missing token still shows the confirmation page');
assert.match(goodToken.headers.get('content-type'), /text\/html/);
assert.match(await goodToken.text(), /unsubscribed/i);

globalThis.fetch = realFetchNews;

/* ------------------------------------------------------------------ */
/* seasonal theme injection                                            */
/* ------------------------------------------------------------------ */

const pageHtml = '<html><head><title>Verre</title></head><body>hi</body></html>';

// Models the real asset layer, which canonicalises '/index.html' back to '/'
// with a 307. With '/' in run_worker_first, a Worker that rewrites '/' to
// '/index.html' gets that redirect, returns it, is called again, and the
// browser dies with ERR_TOO_MANY_REDIRECTS. A stub that always returns the page
// cannot see this, which is why it is modelled here.
// Also models conditional requests. A real asset layer answers a repeat visit
// carrying if-none-match with 304 Not Modified — true of index.html, false of
// the page, because the season is injected after the file is read. Passing that
// 304 through leaves the browser on whatever season it first loaded until
// index.html itself changes, which is a rebuild.
const ASSET_ETAG = '"index-v1"';
const themeAssets = {
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/index.html') {
      return new Response('', { status: 307, headers: { location: '/' } });
    }
    if (req.headers.get('if-none-match') === ASSET_ETAG) {
      return new Response('', { status: 304, headers: { etag: ASSET_ETAG } });
    }
    return new Response(pageHtml, { headers: { 'content-type': 'text/html', etag: ASSET_ETAG } });
  }
};
const themeEnv = { ASSETS: themeAssets };

// The storefront path must reach ASSETS exactly as it arrived.
const storefrontSeen = [];
await worker.fetch(new Request('https://verre.test/'), {
  ASSETS: { fetch: async (req) => { storefrontSeen.push(new URL(req.url).pathname); return new Response(pageHtml, { headers: { 'content-type': 'text/html' } }); } }
});
assert.deepEqual(storefrontSeen, ['/'], "the Worker must not rewrite '/' to '/index.html'");

// No Supabase configured here, so the override read fails. The homepage must
// still render — a decoration lookup must never be able to take the storefront
// down.
const home = await worker.fetch(new Request('https://verre.test/'), themeEnv);
const homeHtml = await home.text();
assert.equal(home.status, 200, 'the storefront renders even when the settings read fails');
assert.match(homeHtml, /window\.__VERRE_THEME__=\{[\s\S]*<\/head>/, 'the theme is injected before </head>');
assert.match(homeHtml, /window\.__VERRE_MARKETS__=\[/, 'published upcoming markets are injected with the theme');
assert.match(homeHtml, /rel="canonical" href="https:\/\/verre\.test\/"/, 'the homepage has one canonical URL');
assert.match(homeHtml, /application\/ld\+json/, 'the homepage publishes structured data');
assert.ok(home.headers.get('x-verre-theme'), 'the resolved theme is reported in a header');
assert.equal(home.headers.get('content-length'), null, 'stale content-length must not survive the rewrite');

// A direct hit on /index.html gets the asset layer's canonical redirect to '/'
// and stops there. One redirect is correct; a second one means the loop is back.
const explicit = await worker.fetch(new Request('https://verre.test/index.html'), themeEnv);
assert.equal(explicit.status, 307, '/index.html canonicalises to / and is passed through');
assert.equal(explicit.headers.get('location'), '/');
const afterRedirect = await worker.fetch(new Request('https://verre.test/'), themeEnv);
assert.equal(afterRedirect.status, 200, 'following that redirect must land on the page, not another redirect');
assert.match(await afterRedirect.text(), /window\.__VERRE_THEME__=/, 'and it is themed');

// A returning browser sends if-none-match. It must still get a full, freshly
// themed document — not a 304 that pins it to the season it first saw.
const revisit = await worker.fetch(
  new Request('https://verre.test/', { headers: { 'if-none-match': ASSET_ETAG } }),
  themeEnv
);
assert.equal(revisit.status, 200, 'a conditional request must not be answered with 304');
assert.match(await revisit.text(), /window\.__VERRE_THEME__=/, 'and the page is themed again');
assert.equal(revisit.headers.get('etag'), null, "the asset's etag must not describe a page we rewrote");
assert.equal(revisit.headers.get('last-modified'), null);

// Localhost is never cached, so flipping a season in admin shows up on the next
// refresh rather than up to a minute later.
const localhost = await worker.fetch(new Request('http://localhost:8787/'), themeEnv);
assert.equal(localhost.headers.get('cache-control'), 'no-store', 'local development must not cache the storefront');

// Previews are shareable by design, but must never be cached for other people.
const preview = await worker.fetch(new Request('https://verre.test/?theme=sinulog'), themeEnv);
assert.equal(preview.headers.get('x-verre-theme'), 'sinulog');
assert.equal(preview.headers.get('cache-control'), 'no-store', 'a preview must not be cached');

// The theme id reaches the page inside a <script>. An unescaped "<" would end
// the element early and turn a query parameter into markup.
const hostile = await worker.fetch(new Request('https://verre.test/?theme=' + encodeURIComponent('</script><img src=x onerror=alert(1)>')), themeEnv);
const hostileHtml = await hostile.text();
assert.equal(hostile.headers.get('x-verre-theme'), 'default', 'an unknown theme falls back rather than erroring');
assert.ok(!hostileHtml.includes('onerror=alert(1)'), 'a hostile theme parameter never reaches the document');
const themeScript = hostileHtml.match(/<script>window\.__VERRE_THEME__=[\s\S]*?<\/script>/)?.[0] || '';
assert.ok(themeScript && (themeScript.match(/<\/script>/g) || []).length === 1,
  'the injected JSON must not be able to close its own script element');

// Search engines receive explicit discovery files, and each active product has
// a stable URL with its own canonical metadata and Product structured data.
const robotsResponse = await worker.fetch(new Request('https://verre.test/robots.txt'), themeEnv);
const robotsBody = await robotsResponse.text();
assert.match(robotsBody, /Sitemap: https:\/\/verre\.test\/sitemap\.xml/);
assert.match(robotsBody, /Disallow: \/admin/);
const workerRobots = await worker.fetch(new Request('https://verre.workers.dev/robots.txt'), themeEnv);
assert.equal(await workerRobots.text(), 'User-agent: *\nDisallow: /\n', 'the duplicate workers.dev origin is not indexed');
const hostedAliasRobots = await worker.fetch(new Request('https://verre-host.chatgpt.site/robots.txt'), {
  ...themeEnv, PUBLIC_SITE_URL: 'https://verrecrafts.shop'
});
assert.equal(await hostedAliasRobots.text(), 'User-agent: *\nDisallow: /\n', 'the hosting alias cannot compete with the custom domain');

const sitemapResponse = await worker.fetch(new Request('https://verre.test/sitemap.xml'), themeEnv);
const sitemapBody = await sitemapResponse.text();
assert.match(sitemapBody, /<loc>https:\/\/verre\.test\/products\/peach-sky-glass-panel<\/loc>/);
assert.ok(!sitemapBody.includes('/admin'), 'private tools never enter the sitemap');

const productResponse = await worker.fetch(new Request('https://verre.test/products/peach-sky-glass-panel'), themeEnv);
const productHtml = await productResponse.text();
assert.equal(productResponse.status, 200);
assert.match(productHtml, /<title>Peach Sky Glass Panel \| Handmade by Verre<\/title>/);
assert.match(productHtml, /rel="canonical" href="https:\/\/verre\.test\/products\/peach-sky-glass-panel"/);
assert.match(productHtml, /"@type":"Product"/);
const missingProduct = await worker.fetch(new Request('https://verre.test/products/not-real'), themeEnv);
assert.equal(missingProduct.status, 404);
assert.match(await missingProduct.text(), /name="robots" content="noindex,follow"/);

// Uploaded photos stay in the private bucket but get a permanent public shop
// URL. Crawlers and browsers never receive a short-lived Supabase token.
const imageId = '22222222-2222-4222-8222-222222222222';
const imageFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/rest/v1/product_images')) {
    return new Response(JSON.stringify([{ storage_path: 'products/p1/front.webp' }]), {
      headers: { 'content-type': 'application/json' }
    });
  }
  if (path.endsWith('/storage/v1/object/product-images/products/p1/front.webp')) {
    return new Response(new Uint8Array([82, 73, 70, 70]), {
      headers: { 'content-type': 'image/webp', etag: 'photo-v1' }
    });
  }
  return new Response('Not found', { status: 404 });
};
const imageResponse = await worker.fetch(
  new Request('https://verre.test/media/products/' + imageId + '.webp'),
  { ...themeEnv, SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-test' }
);
assert.equal(imageResponse.status, 200);
assert.equal(imageResponse.headers.get('content-type'), 'image/webp');
assert.match(imageResponse.headers.get('cache-control'), /max-age=86400/);
assert.equal(imageResponse.headers.get('etag'), 'photo-v1');
globalThis.fetch = imageFetch;

console.log('ok');
