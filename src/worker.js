import { authenticate, authError } from './auth.js';
import { authApi } from './api/auth.js';
import { publicProducts, receiptPage } from './api/public.js';
import { adminApi } from './api/admin.js';
import { posApi } from './api/pos.js';
import { listPublicProducts } from './db/products.js';
import { createInquiry } from './db/orders.js';
import { addSubscriber, removeSubscriber } from './db/subscribers.js';
import { themedPage } from './api/theme.js';
import { can, resolveUser } from './roles.js';

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
    const url = new URL(request.url);

    // Before every gate below: /api/auth/* is how you get a session in the
    // first place, so it cannot require one. Each route inside does its own
    // rate limiting and its own authorization.
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      const identity = await authenticate(request, env);
      const resolved = identity ? await resolveUser(env, identity) : { data: null };
      return authApi(request, env, url, resolved.data ? { ...identity, ...resolved.data } : null);
    }

    if (url.pathname === '/api/inquiry') return handleInquiry(request, env);
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
    // view. Serving the asset directly avoids shipping a duplicate page.
    if (url.pathname === '/login/reset' || url.pathname === '/login/reset/') {
      const page = new URL(url);
      page.pathname = '/login/index.html';
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
};

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
const hits = new Map();
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  return false;
}

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
  if (rateLimited(ip)) {
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
  if (rateLimited(ip)) {
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

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  const ownerHtml =
    '<div style="font-family:system-ui,sans-serif;color:#3A2430;line-height:1.55">' +
    '<h2 style="margin:0 0 4px">' + esc(LABEL[d.type]) + '</h2>' +
    '<p style="margin:0 0 16px;color:#7A5C6B">Ref <strong>' + esc(ref) + '</strong></p>' +
    '<p style="margin:0 0 16px">' +
    '<strong>' + esc(d.name) + '</strong><br>' +
    '<a href="mailto:' + esc(d.email) + '">' + esc(d.email) + '</a>' +
    (d.phone ? '<br>' + esc(d.phone) : '') +
    (d.type === 'order' ? '<br>' + esc(FULFILLMENT[d.fulfillment]) : '') +
    '</p>' +
    (d.type === 'order'
      ? '<table style="border-collapse:collapse;margin:0 0 16px">' +
        rows +
        '<tr><td style="padding:8px 12px 0 0;border-top:1px solid #FFE0EE"><strong>Subtotal</strong></td>' +
        '<td style="border-top:1px solid #FFE0EE"></td>' +
        '<td style="padding:8px 0 0;text-align:right;border-top:1px solid #FFE0EE"><strong>' +
        esc(peso(d.subtotal)) +
        '</strong></td></tr></table>' +
        '<p style="margin:0 0 16px;color:#7A5C6B">Shipping is quoted separately.</p>'
      : '') +
    (d.message ? '<p style="margin:0 0 16px;white-space:pre-wrap">' + esc(d.message) + '</p>' : '') +
    '<p style="margin:0;color:#7A5C6B">Reply to this email to answer ' + esc(d.name) + ' directly.</p>' +
    '</div>';

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

  const customerHtml =
    '<div style="font-family:system-ui,sans-serif;color:#3A2430;line-height:1.6;max-width:520px">' +
    '<p style="margin:0 0 16px">Hi ' + esc(d.name) + ',</p>' +
    '<p style="margin:0 0 16px">' + esc(opener) + '</p>' +
    (d.type === 'order'
      ? '<table style="border-collapse:collapse;margin:0 0 12px">' +
        rows +
        '<tr><td style="padding:8px 12px 0 0;border-top:1px solid #FFE0EE"><strong>Subtotal</strong></td>' +
        '<td style="border-top:1px solid #FFE0EE"></td>' +
        '<td style="padding:8px 0 0;text-align:right;border-top:1px solid #FFE0EE"><strong>' +
        esc(peso(d.subtotal)) +
        '</strong></td></tr></table>' +
        '<p style="margin:0 0 16px;color:#7A5C6B">' + esc(FULFILLMENT[d.fulfillment]) + ' · shipping quoted separately</p>'
      : '') +
    (d.message
      ? '<blockquote style="margin:0 0 16px;padding:8px 14px;border-left:3px solid #FFB6D9;color:#7A5C6B;white-space:pre-wrap">' +
        esc(d.message) +
        '</blockquote>'
      : '') +
    "<p style=\"margin:0 0 16px\">I'll reply within 2–3 days with a quote and payment details (GCash or bank transfer).</p>" +
    '<p style="margin:0 0 16px">Your reference is <strong>' + esc(ref) + '</strong> — keep it handy if you need to follow up.</p>' +
    '<p style="margin:0 0 16px;color:#7A5C6B">Everything is made by hand, one at a time. Thank you for waiting on it.</p>' +
    '<p style="margin:0">— Verre</p>' +
    '</div>';

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
        'content-type': 'application/json'
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

export const _test = { validate, resolveOrder, makeRef, compose, rateLimited, hits };
