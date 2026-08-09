import { authenticate, authError } from './auth.js';
import { authApi } from './api/auth.js';
import { publicProducts, receiptPage } from './api/public.js';
import { customWizardApi, customRequestApi, customUploadApi, trackPage } from './api/custom.js';
import { adminApi } from './api/admin.js';
import { posApi } from './api/pos.js';
import { listPublicProducts } from './db/products.js';
import { createInquiry } from './db/orders.js';
import { addSubscriber, removeSubscriber } from './db/subscribers.js';
import { db } from './db/client.js';
import { themedPage } from './api/theme.js';
import { can, resolveUser } from './roles.js';
import { emailButton, emailMessage, emailReference, emailShell, escapeEmailHtml as esc } from './email.js';
import { productImage, productPage, robots, sitemap } from './api/seo.js';
import { canonicalRedirect } from './seo.js';
import { limited as requestLimited, RateLimiter, _test as rateLimitTest } from './rate-limit.js';

export { RateLimiter };

const MAX_BODY = 16 * 1024;
const RESEND_TIMEOUT_MS = 8000;
const TYPES = ['order', 'custom', 'contact'];
const FULFILLMENT = {
  pickup: 'Pickup in Cebu',
  delivery: 'Cebu delivery',
  ship: 'Ship nationwide'
};

const isProtected = (p) =>
  p === '/admin' || p.startsWith('/admin/') || p === '/pos' || p.startsWith('/pos/');

// Top-level navigation, as opposed to fetch/XHR from a page that is already
// loaded. Sec-Fetch-Mode is the reliable signal in current browsers; the Accept
// sniff is the fallback for anything that does not send it.
const wantsHtml = (request) => {
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
};

export default {
  async fetch(request, env) {
    return secureResponse(await routeRequest(request, env), request);
  }
};

async function routeRequest(request, env) {
    const url = new URL(request.url);

    const redirect = canonicalRedirect(request, env);
    if (redirect) return redirect;

    // Before every gate below: /api/auth/* is how you get a session in the
    // first place, so it cannot require one. Each route inside does its own
    // rate limiting and its own authorization.
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      const identity = await authenticate(request, env);
      const resolved = identity ? await resolveUser(env, identity) : { data: null };
      return authApi(request, env, url, resolved.data ? { ...identity, ...resolved.data } : null);
    }

    // Unauthenticated on purpose, and booleans only — never a value, a hostname
    // or a key fragment. Its whole job is to answer "did the secrets actually
    // reach this Worker?" without a deploy-guess-redeploy loop. Every symptom
    // in this project so far (no backend, no theme, sign-in unavailable) had
    // the same root cause and no way to see it from outside.
    if (url.pathname === '/api/health') return handleHealth(request, env);

    if (url.pathname === '/robots.txt' && request.method === 'GET') return robots(request, env);
    if (url.pathname === '/sitemap.xml' && request.method === 'GET') return sitemap(request, env);
    const productRoute = url.pathname.match(/^\/products\/([^/]+)\/?$/);
    if (productRoute && request.method === 'GET') {
      let slug;
      try { slug = decodeURIComponent(productRoute[1]); } catch { return new Response('Not found', { status: 404 }); }
      return productPage(request, env, slug);
    }
    const imageRoute = url.pathname.match(/^\/media\/products\/([0-9a-f-]+)\.webp$/i);
    if (imageRoute && request.method === 'GET') return productImage(request, env, imageRoute[1]);

    if (url.pathname === '/api/inquiry') return handleInquiry(request, env);

    // The commission wizard. Public and unauthenticated like /api/inquiry, and
    // it shares that endpoint's rate limiter deliberately: both are "a stranger
    // can make Kyle's phone buzz", so one budget covers both rather than
    // letting a flooder use each to top the other up.
    if (url.pathname === '/api/custom/wizard') return customWizardApi(request, env);
    if (url.pathname === '/api/custom/request') {
      return customRequestApi(request, env, { rateLimited, makeRef, sendEmail });
    }
    if (url.pathname === '/api/custom/upload') return customUploadApi(request, env);

    if (url.pathname === '/api/subscribe') return handleSubscribe(request, env);
    if (url.pathname === '/unsubscribe') return handleUnsubscribe(request, env, url);
    if (url.pathname === '/api/products' && request.method === 'GET') return publicProducts(request, env);
    if (url.pathname.startsWith('/api/admin/') || url.pathname === '/api/admin') {
      const access = await requestUser(request, env);
      if (access.response) return access.response;
      return can(access.user, 'admin') ? adminApi(request, env, access.user) : forbidden();
    }
    if (url.pathname.startsWith('/api/pos/') || url.pathname === '/api/pos') {
      const access = await requestUser(request, env);
      if (access.response) return access.response;
      return can(access.user, 'pos') ? posApi(request, env, access.user) : forbidden();
    }
    if (/^\/r\/VR-[A-Z2-9]{4}$/.test(url.pathname)) return receiptPage(env, url.pathname.slice(3));

    // Public commission tracking. Unlike /r/{ref}, this one also requires the
    // 128-bit token from the confirmation email — a receipt shows items and a
    // total, but an order status shows a name and where a piece is headed, and
    // four characters of ref is not enough to guard that.
    if (/^\/order\/VR-[A-Z2-9]{4}$/.test(url.pathname)) {
      return trackPage(request, env, url.pathname.slice(7));
    }


    // Old host-provided sign-in entry points. Verre owns login now; keep these
    // redirecting so any bookmark or cached admin bundle still lands somewhere
    // sensible instead of a 404.
    if (url.pathname === '/signin-with-chatgpt' || url.pathname === '/signout-with-chatgpt') {
      const back = safeReturn(url.searchParams.get('return_to'));
      return Response.redirect(new URL('/login?return_to=' + encodeURIComponent(back), url.origin), 302);
    }

    // The storefront is served with its season already resolved and injected,
    // so the hero never paints the everyday pink and then swaps.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return themedPage(request, env);
    }
    // The reset link is a real URL people click from email, but it is the same
    // document as /login — the token in the query string is what selects the
    // view. Fetch the directory URL rather than /login/index.html: Cloudflare
    // canonicalises explicit index files back to /login/, and returning that
    // redirect to the browser loses /login/reset and opens the sign-in view.
    if (url.pathname === '/login/reset' || url.pathname === '/login/reset/') {
      const page = new URL(url);
      page.pathname = '/login/';
      return env.ASSETS.fetch(new Request(page, request));
    }
    // The shells need the same gate as their APIs. Guarding only /api/admin/*
    // leaves /admin/app.js and /pos/sw.js served straight off ASSETS, so the
    // whole console is readable by anyone who guesses the path.
    if (isProtected(url.pathname)) {
      const access = await requestUser(request, env);
      if (access.response) {
        // A person typing /admin should land on the login form. A fetch from
        // already-loaded admin JS should get JSON it can branch on — following
        // a redirect there just hands the caller an HTML page where it expected
        // a payload, which is exactly how "session expired" turns into an
        // unreadable parse error.
        if (access.response.status === 401 && wantsHtml(request)) return signInRedirect(request);
        return access.response;
      }
      const capability = url.pathname === '/admin' || url.pathname.startsWith('/admin/') ? 'admin' : 'pos';
      if (!can(access.user, capability)) return forbidden();
      // Pass the path through untouched. Rewriting '/admin/' to
      // '/admin/index.html' makes the asset layer canonicalise it straight back
      // to '/admin/', and since run_worker_first routes that here too, the
      // browser bounces between the two forever. Directory indexes are the
      // asset layer's job — let it do them.
      return env.ASSETS.fetch(request);
    }
    return env.ASSETS.fetch(request);
}

function secureResponse(response, request) {
  const headers = new Headers(response.headers);
  const url = new URL(request.url);
  if (response.ok && /-v\d+\.(?:webp|png|jpg|jpeg|gif|svg|woff2?)$/i.test(url.pathname)) {
    headers.set('cache-control', 'public, max-age=31536000, immutable');
  } else if (response.ok && /\.(?:js|css|webp|png|jpg|jpeg|gif|svg|woff2?)$/i.test(url.pathname)) {
    headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
  }
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set(
    'content-security-policy-report-only',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
    "script-src 'self' 'unsafe-inline' https://unpkg.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://api.qrserver.com; " +
    "connect-src 'self' https://*.supabase.co; form-action 'self'; upgrade-insecure-requests"
  );
  if (url.protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function requestUser(request, env) {
  const identity = await authenticate(request, env);
  if (!identity) return { response: authError() };
  const resolved = await resolveUser(env, identity);
  if (resolved.error) {
    return {
      response: json(503, {
        ok:false,
        error:'Account permissions are temporarily unavailable',
        code:'AUTHORIZATION_UNAVAILABLE'
      })
    };
  }
  if (resolved.data) return { user: resolved.data };

  // With no bootstrap list AND an empty admin_accounts table, nobody can ever be
  // granted a role — including whoever is trying to grant them. That is a
  // deployment mistake, and "your account does not have permission" sends you
  // hunting through roles instead of through the secrets. Name it.
  if (!env.SUPER_ADMIN_EMAILS && !env.ADMIN_EMAILS) {
    console.error('auth: SUPER_ADMIN_EMAILS is unset — no account can be granted admin');
    return {
      response: json(503, {
        ok: false,
        error: 'No administrator is configured. Set SUPER_ADMIN_EMAILS and restart.',
        code: 'NO_ADMIN_CONFIGURED'
      })
    };
  }
  return { response: forbidden() };
}

const forbidden = () => json(403, {
  ok:false,
  error:'Your account does not have permission for this area',
  code:'FORBIDDEN'
});

// return_to arrives from the query string, so it is attacker-controlled. Only
// same-origin paths — '//evil.com' is a protocol-relative URL, not a path.
const safeReturn = (raw) => {
  const value = String(raw || '/');
  return value.startsWith('/') && !value.startsWith('//') ? value : '/';
};

function signInRedirect(request) {
  const requested = new URL(request.url);
  const signIn = new URL('/login', requested.origin);
  signIn.searchParams.set('return_to', requested.pathname + requested.search);
  return Response.redirect(signIn, 302);
}

/* ------------------------------------------------------------------ */
/* rate limit                                                          */
/* ------------------------------------------------------------------ */

// ponytail: in-memory, per-isolate, best-effort only. It resets whenever
// Cloudflare recycles the isolate and is not shared between colos, so a
// determined flooder gets through. Move to a Durable Object (or KV with a
// short TTL) the moment one is provisioned.
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;

const rateLimited = (env, ip) => requestLimited(env, 'public:' + ip, RATE_MAX, RATE_WINDOW_MS);

/* ------------------------------------------------------------------ */
/* endpoint                                                            */
/* ------------------------------------------------------------------ */

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });

const bad = (error, field) => json(400, { ok: false, error, ...(field && { field }) });

async function handleInquiry(request, env) {
  // Same-origin only — no CORS headers on purpose.
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' }, { allow: 'POST' });
  }

  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY) return bad('Message is too large');

  let raw;
  try {
    raw = await request.text();
  } catch {
    return bad('Could not read the request');
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY) return bad('Message is too large');

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return bad('Expected JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Expected JSON');

  // Honeypot: pretend it worked. A bot that learns it was caught adapts.
  if (str(body.hp)) return json(200, { ok: true, ref: makeRef() });

  const parsed = validate(body);
  if (parsed.error) return bad(parsed.error, parsed.field);

  if (parsed.type === 'order') {
    const resolved = await resolveOrder(env, parsed.items);
    if (resolved.error) return bad(resolved.error, 'items');
    parsed.items = resolved.items;
    parsed.subtotal = resolved.subtotal;
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await rateLimited(env, ip)) {
    return json(429, { ok: false, error: 'Too many requests' }, { 'retry-after': '600' });
  }

  const ref = makeRef();
  const saved = await createInquiry(env, ref, parsed);
  if (saved.error) console.error('inquiry ' + ref + ': database write failed — ' + saved.error.code);

  // Once the row exists, Kyle has the order — it shows up in /admin whatever the
  // mailer does. Telling the customer it failed just makes them submit again,
  // and now there are two rows for one order.
  const recorded = !saved.error;

  const owner = env.OWNER_EMAIL;
  const from = env.FROM_EMAIL;
  if (!env.RESEND_API_KEY || !owner || !from) {
    console.error('inquiry ' + ref + ': email is not configured'); // never log the key itself
    if (recorded) return json(200, { ok: true, ref });
    return json(502, { ok: false, error: 'Email is not set up yet. Please message Verre on Instagram.' });
  }

  const mail = compose(parsed, ref);

  // Kyle's copy is the one that matters — unless the row already saved it, in
  // which case the order is safe and only the notification is missing.
  const sentToOwner = await sendEmail(env, {
    from,
    to: owner,
    reply_to: parsed.email,
    subject: '[Verre] New ' + parsed.type + ' — ' + ref,
    text: mail.ownerText,
    html: mail.ownerHtml
  });
  if (!sentToOwner.ok) {
    console.error('inquiry ' + ref + ': owner email failed — ' + sentToOwner.error);
    if (!recorded) {
      return json(502, { ok: false, error: "That didn't go through. Please try again in a moment." });
    }
  }

  // The customer confirmation is a nicety. Losing it must not lose the order.
  const sentToCustomer = await sendEmail(env, {
    from,
    to: parsed.email,
    reply_to: owner,
    subject: "Verre — we've got your " + (parsed.type === 'order' ? 'order request' : 'message') + ' (' + ref + ')',
    text: mail.customerText,
    html: mail.customerHtml
  });
  if (!sentToCustomer.ok) {
    console.warn('inquiry ' + ref + ': confirmation email failed — ' + sentToCustomer.error);
  }

  console.log('inquiry ' + ref + ': ' + parsed.type + ' ok'); // no names, no bodies
  return json(200, { ok: true, ref });
}

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */

async function handleHealth(request, env) {
  if (request.method !== 'GET') return json(405, { ok: false, error: 'Method not allowed' }, { allow: 'GET' });

  const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  const email = Boolean(env.RESEND_API_KEY && env.OWNER_EMAIL && env.FROM_EMAIL);
  const administrator = Boolean(env.SUPER_ADMIN_EMAILS || env.ADMIN_EMAILS);
  const rateLimiting = Boolean(env.RATE_LIMITER);
  const publicOrigin = publicOriginReady(env.PUBLIC_SITE_URL);
  let database = false;
  let auth = false;
  let catalog = false;
  let customization = false;

  if (configured) {
    const [products, wizard, password] = await Promise.all([
      db(env).rest('products', 'select=id,slug,price_cents,cost_cents,stock_on_hand&status=eq.active&limit=100'),
      db(env).rpc('custom_wizard', {}),
      db(env).rpc('verify_password', { p_email: 'health-probe@invalid.test', p_password: '' })
    ]);
    database = !products.error;
    auth = !password.error;
    catalog = !products.error && (products.data || []).length > 0 && (products.data || []).every((product) =>
      Boolean(product.id && product.slug) && Number.isInteger(product.price_cents) && product.price_cents >= 0 &&
      Number.isInteger(product.cost_cents) && product.cost_cents >= 0
    );
    customization = !wizard.error && requiredWizardReady(wizard.data);
    if (products.error) console.error('health: product probe - ' + products.error.code);
    if (wizard.error) console.error('health: wizard probe - ' + wizard.error.code);
    if (password.error) console.error('health: auth probe - ' + password.error.code);
  }

  const ready = database && auth && catalog && customization && email && administrator && rateLimiting && publicOrigin;
  return json(ready ? 200 : 503, {
    ok: ready,
    data: {
      ready,
      status: ready ? 'ready' : 'not-ready',
      checks: { database, auth, catalog, customization, email, administrator, rateLimiting, publicOrigin }
    }
  }, { 'cache-control': 'no-store' });
}

function requiredWizardReady(groups) {
  const byKey = new Map((groups || []).map((group) => [group.key, group]));
  return ['base', 'size', 'design'].every((key) => (byKey.get(key)?.options || []).length > 0);
}

function publicOriginReady(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.hostname.endsWith('.workers.dev');
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* newsletter                                                          */
/* ------------------------------------------------------------------ */

async function handleSubscribe(request, env) {
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' }, { allow: 'POST' });
  }

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2048) return bad('That request is too large');
    body = JSON.parse(raw);
  } catch {
    return bad('Expected JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Expected JSON');

  // Same trick as the enquiry form: a caught bot is told it succeeded.
  if (str(body.hp)) return json(200, { ok: true });

  const email = str(body.email).toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return bad("That email doesn't look right", 'email');
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await rateLimited(env, ip)) {
    return json(429, { ok: false, error: 'Too many requests' }, { 'retry-after': '600' });
  }

  const saved = await addSubscriber(env, email, str(body.source) || 'storefront');
  if (saved.error) {
    console.error('subscribe: failed — ' + saved.error.code); // never the address
    return json(502, { ok: false, error: 'Could not sign you up just now. Please try again shortly.' });
  }

  // One response for a new address and for one already on the list. Saying
  // "you're already subscribed" turns this box into a way to check whether any
  // given person has signed up.
  console.log('subscribe: ok');
  return json(200, { ok: true });
}

async function handleUnsubscribe(request, env, url) {
  const token = str(url.searchParams.get('t'));
  // Never 404 or error on a bad token — an unsubscribe page that behaves
  // differently for real and fake tokens is a way to probe them, and someone
  // trying to leave a mailing list should never see a failure.
  if (token) {
    const done = await removeSubscriber(env, token);
    if (done.error) console.error('unsubscribe: failed — ' + done.error.code);
  }
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>Unsubscribed — Verre</title>' +
    '<div style="font-family:Poppins,system-ui,sans-serif;color:#3A2430;background:#FFF6F0;min-height:100vh;' +
    'display:grid;place-items:center;padding:24px;line-height:1.65;text-align:center">' +
    '<div style="max-width:28rem;background:#fff;border:6px solid #fff;border-radius:30px;padding:34px 32px;' +
    'box-shadow:0 14px 0 rgba(239,64,86,.12),0 26px 44px rgba(160,40,90,.16)">' +
    '<div style="font-size:38px" aria-hidden="true">💗</div>' +
    '<h1 style="margin:6px 0 10px;font-family:Shrikhand,cursive;font-weight:400;font-size:26px">You\'re unsubscribed</h1>' +
    '<p style="margin:0 0 22px;color:#7A5C6B;font-size:14px">No more new-drop emails. Thank you for having been here — ' +
    'the shop is always open if you change your mind.</p>' +
    '<a href="/" style="display:inline-block;background:linear-gradient(140deg,#FFB6D9,#F157A8);color:#fff;' +
    'text-decoration:none;font-weight:700;font-size:14px;padding:13px 26px;border-radius:999px;' +
    'border:3px solid #fff;box-shadow:0 5px 0 rgba(239,64,86,.28)">Back to Verre</a>' +
    '</div></div>',
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

const str = (v) => (typeof v === 'string' ? v.trim() : '');
// Deliberately loose: one @, no spaces, a dot in the domain. Anything
// stricter rejects real addresses; the confirmation email is the real check.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function validate(body) {
  const type = str(body.type);
  if (!TYPES.includes(type)) return { error: 'Unknown request type', field: 'type' };

  const name = str(body.name);
  if (!name) return { error: 'Please tell us your name', field: 'name' };
  if (name.length > 100) return { error: 'That name is too long', field: 'name' };

  const email = str(body.email);
  if (!email) return { error: 'Please add your email', field: 'email' };
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return { error: "That email doesn't look right", field: 'email' };
  }

  const phone = str(body.phone);
  if (phone.length > 30) return { error: 'That phone number is too long', field: 'phone' };

  const message = str(body.message);
  if (message.length > 2000) return { error: 'Please keep it under 2000 characters', field: 'message' };
  if (type !== 'order' && !message) return { error: 'Please add a message', field: 'message' };

  if (type !== 'order') return { type, name, email, phone, message, items: [], subtotal: 0 };

  const fulfillment = str(body.fulfillment);
  if (!FULFILLMENT[fulfillment]) return { error: 'Please choose how to get it to you', field: 'fulfillment' };

  const raw = body.items;
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Your cart is empty', field: 'items' };
  if (raw.length > 50) return { error: 'That is too many items for one request', field: 'items' };

  const items = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { error: 'Something in the cart is unreadable', field: 'items' };
    const id = str(entry.id);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return { error: 'One of those pieces is unreadable', field: 'items' };
    const qty = entry.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
      return { error: 'Quantities must be between 1 and 20', field: 'items' };
    }
    items.push({ id, qty });
  }

  return { type, name, email, phone, message, fulfillment, items, subtotal: 0 };
}

async function resolveOrder(env, items) {
  const catalog = await listPublicProducts(env);
  if ((catalog.stale || catalog.error) && db(env).configured) {
    return { error: 'The live catalog is temporarily unavailable. Your cart is safe; please try again shortly.' };
  }
  const bySlug = new Map((catalog.data || []).map((product) => [product.slug, product]));
  const resolved = [];
  let subtotal = 0;
  for (const item of items) {
    const product = bySlug.get(item.id);
    if (!product || product.status !== 'active') return { error: 'One of those pieces is no longer available' };
    const price = product.price_cents / 100;
    resolved.push({ ...item, name: product.name, price, total: price * item.qty });
    subtotal += price * item.qty;
  }
  return { items: resolved, subtotal };
}

// No I, O, 0, 1 — these get read aloud over the phone.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRef() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let out = '';
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return 'VR-' + out;
}

/* ------------------------------------------------------------------ */
/* email bodies                                                        */
/* ------------------------------------------------------------------ */

const LABEL = { order: 'Order request', custom: 'Custom order', contact: 'Message' };
const peso = (n) => '₱' + Number(n).toLocaleString('en-PH');

function compose(d, ref) {
  const lines = d.items.map((i) => '  ' + i.qty + ' × ' + i.name + ' — ' + peso(i.total));
  const rows = d.items
    .map(
      (i) =>
        '<tr><td style="padding:6px 12px 6px 0">' +
        esc(i.name) +
        '</td><td style="padding:6px 12px 6px 0;text-align:right">' +
        i.qty +
        '</td><td style="padding:6px 0;text-align:right">' +
        esc(peso(i.total)) +
        '</td></tr>'
    )
    .join('');

  const ownerText = [
    LABEL[d.type] + ' — ' + ref,
    '',
    'Name:  ' + d.name,
    'Email: ' + d.email,
    d.phone ? 'Phone: ' + d.phone : null,
    d.type === 'order' ? 'How:   ' + FULFILLMENT[d.fulfillment] : null,
    '',
    d.type === 'order' ? 'Items:' : null,
    d.type === 'order' ? lines.join('\n') : null,
    d.type === 'order' ? 'Subtotal: ' + peso(d.subtotal) + ' (shipping not included)' : null,
    d.message ? '' : null,
    d.message ? 'Message:\n' + d.message : null,
    '',
    'Reply to this email to answer ' + d.name + ' directly.'
  ]
    .filter((l) => l !== null)
    .join('\n');

  const ownerBody =
    '<table class="email-detail" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#FFF8F3;border-radius:16px;margin:0 0 22px">' +
    '<tr><td style="color:#9A6D82;padding:16px 18px 4px;width:34%">Customer</td><td style="padding:16px 18px 4px;text-align:right"><strong>' + esc(d.name) + '</strong></td></tr>' +
    '<tr><td style="color:#9A6D82;padding:4px 18px">Email</td><td style="padding:4px 18px;text-align:right"><a href="mailto:' + esc(d.email) + '" style="color:#F157A8">' + esc(d.email) + '</a></td></tr>' +
    (d.phone ? '<tr><td style="color:#9A6D82;padding:4px 18px">Phone</td><td style="padding:4px 18px;text-align:right">' + esc(d.phone) + '</td></tr>' : '') +
    (d.type === 'order' ? '<tr><td style="color:#9A6D82;padding:4px 18px 16px">Delivery</td><td style="padding:4px 18px 16px;text-align:right">' + esc(FULFILLMENT[d.fulfillment]) + '</td></tr>' : '') +
    '</table>' +
    (d.type === 'order'
      ? '<h2 style="font-family:Georgia,serif;font-size:20px;margin:0 0 8px">What they picked</h2>' +
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:0 0 10px">' + rows +
        '<tr><td style="padding:12px 12px 0 0;border-top:1px solid #FFD9EA"><strong>Subtotal</strong></td><td style="border-top:1px solid #FFD9EA"></td>' +
        '<td style="padding:12px 0 0;text-align:right;border-top:1px solid #FFD9EA"><strong>' + esc(peso(d.subtotal)) + '</strong></td></tr></table>' +
        '<p style="color:#7A5C6B;font-size:12px;margin:0 0 18px">Shipping is quoted separately.</p>'
      : '') +
    emailMessage(d.message) + emailReference(ref);

  const ownerHtml = emailShell({
    preheader: d.name + ' sent a new ' + LABEL[d.type].toLowerCase() + '.',
    eyebrow: 'Studio notification',
    title: 'New ' + LABEL[d.type].toLowerCase(),
    intro: esc(d.name) + ' just reached out through the Verre website.',
    body: ownerBody,
    action: emailButton('Reply to ' + d.name, 'mailto:' + d.email),
    footer: 'Private studio notification · Reply goes directly to the customer.'
  });

  const opener =
    d.type === 'order'
      ? 'Thank you for your order request! Here is what you picked:'
      : d.type === 'custom'
        ? 'Thank you for your custom order idea! Here is what you sent:'
        : 'Thank you for writing in! Here is what you sent:';

  const customerText = [
    'Hi ' + d.name + ',',
    '',
    opener,
    '',
    d.type === 'order' ? lines.join('\n') : null,
    d.type === 'order' ? '  Subtotal: ' + peso(d.subtotal) + ' (shipping quoted separately)' : null,
    d.type === 'order' ? '  Getting it to you: ' + FULFILLMENT[d.fulfillment] : null,
    d.message ? '  "' + d.message + '"' : null,
    '',
    "I'll reply within 2–3 days with a quote and payment details (GCash or bank transfer).",
    'Your reference is ' + ref + ' — keep it handy if you need to follow up.',
    '',
    'Everything is made by hand, one at a time. Thank you for waiting on it.',
    '',
    '— Verre'
  ]
    .filter((l) => l !== null)
    .join('\n');

  const customerBody =
    '<p style="margin:0 0 20px">' + esc(opener) + '</p>' +
    (d.type === 'order'
      ? '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:0 0 12px">' + rows +
        '<tr><td style="padding:12px 12px 0 0;border-top:1px solid #FFD9EA"><strong>Subtotal</strong></td><td style="border-top:1px solid #FFD9EA"></td>' +
        '<td style="padding:12px 0 0;text-align:right;border-top:1px solid #FFD9EA"><strong>' + esc(peso(d.subtotal)) + '</strong></td></tr></table>' +
        '<p style="color:#7A5C6B;font-size:12px;margin:0 0 18px">' + esc(FULFILLMENT[d.fulfillment]) + ' · shipping quoted separately</p>'
      : '') +
    emailMessage(d.message) +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#FFF8F3;border-radius:16px;margin:22px 0"><tr><td style="padding:18px">' +
    '<strong style="display:block;margin-bottom:5px">What happens next?</strong><span style="color:#6F5662">I’ll reply within 2–3 days with a quote and payment details. Nothing is charged until you say yes.</span>' +
    '</td></tr></table>' + emailReference(ref) +
    '<p style="color:#7A5C6B;font-size:13px;margin:18px 0 0;text-align:center">Everything is made by hand, one piece at a time. Thank you for waiting on it.</p>';

  const customerHtml = emailShell({
    preheader: 'Your Verre request is safely in the studio queue.',
    eyebrow: 'Made by hand',
    title: d.type === 'order' ? 'We’ve got your order request' : 'Your note reached the studio',
    intro: 'Hi ' + esc(d.name) + ' — thank you for choosing something made slowly and with care.',
    body: customerBody,
    footer: 'You received this because you sent a request through the Verre website.'
  });

  return { ownerText, ownerHtml, customerText, customerHtml };
}

/* ------------------------------------------------------------------ */
/* resend                                                              */
/* ------------------------------------------------------------------ */

async function sendEmail(env, payload) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + env.RESEND_API_KEY,
        'content-type': 'application/json',
        'user-agent': 'verrewebsite/1.0'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS)
    });
    if (!res.ok) return { ok: false, error: 'resend ' + res.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.name };
  }
}

export const _test = { validate, resolveOrder, makeRef, compose, rateLimited, hits: rateLimitTest.fallback };
