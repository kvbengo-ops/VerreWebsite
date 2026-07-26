import { CATALOG, peso } from './catalog.js';

const MAX_BODY = 16 * 1024;
const RESEND_TIMEOUT_MS = 8000;
const TYPES = ['order', 'custom', 'contact'];
const FULFILLMENT = {
  pickup: 'Pickup in Cebu',
  delivery: 'Cebu delivery',
  ship: 'Ship nationwide'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/inquiry') return handleInquiry(request, env);

    if (url.pathname === '/') {
      url.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  }
};

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

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) {
    return json(429, { ok: false, error: 'Too many requests' }, { 'retry-after': '600' });
  }

  const ref = makeRef();
  const owner = env.OWNER_EMAIL;
  const from = env.FROM_EMAIL;
  if (!env.RESEND_API_KEY || !owner || !from) {
    console.error('inquiry ' + ref + ': email is not configured'); // never log the key itself
    return json(502, { ok: false, error: 'Email is not set up yet. Please message Verre on Instagram.' });
  }

  const mail = compose(parsed, ref);

  // Kyle's copy is the one that matters — if it fails, the request failed.
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
    return json(502, { ok: false, error: "That didn't go through. Please try again in a moment." });
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
    const product = CATALOG[str(entry.id)];
    if (!product) return { error: 'One of those pieces is no longer available', field: 'items' };
    const qty = entry.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
      return { error: 'Quantities must be between 1 and 20', field: 'items' };
    }
    items.push({ id: str(entry.id), name: product.name, qty, price: product.price, total: product.price * qty });
  }

  // Prices come from CATALOG, never from the request.
  const subtotal = items.reduce((sum, i) => sum + i.total, 0);
  return { type, name, email, phone, message, fulfillment, items, subtotal };
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

export const _test = { validate, makeRef, compose, rateLimited, hits };
