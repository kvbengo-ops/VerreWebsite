import {
  customWizard, createCustomRequest, trackOrder,
  signReferenceUpload, attachReferenceImage
} from '../db/custom.js';
import { db } from '../db/client.js';
import { json } from './http.js';
import { emailButton, emailReference, emailShell } from '../email.js';

/* ------------------------------------------------------------------ */
/* shape                                                               */
/* ------------------------------------------------------------------ */

const MAX_BODY = 24 * 1024;
const FULFILLMENT = {
  pickup:   'Pickup in Cebu',
  delivery: 'Cebu delivery',
  ship:     'Ship nationwide'
};
// Anything that leaves Kyle's hands needs somewhere to go. Pickup does not.
const NEEDS_ADDRESS = new Set(['delivery', 'ship']);

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const bad = (error, field) => json(400, { ok: false, error, ...(field && { field }) });

/* ------------------------------------------------------------------ */
/* GET /api/custom/wizard                                              */
/* ------------------------------------------------------------------ */

export async function customWizardApi(request, env) {
  if (request.method !== 'GET') return json(405, { ok: false, error: 'Method not allowed' }, { allow: 'GET' });
  const result = await customWizard(env);
  if (result.error) {
    console.error('custom wizard: ' + result.error.code);
    return json(503, { ok: false, error: 'Custom orders are unavailable right now.', code: 'WIZARD_UNAVAILABLE' });
  }
  return json(200, { ok: true, steps: result.data || [] }, {
    'cache-control': 'public,max-age=60',
    'x-verre-wizard': result.cached ? 'hit' : 'live'
  });
}

/* ------------------------------------------------------------------ */
/* POST /api/custom/request                                            */
/* ------------------------------------------------------------------ */

export function validateCustomRequest(body) {
  const name = str(body.name);
  if (!name) return { error: 'Please tell me your name', field: 'name' };
  if (name.length > 100) return { error: 'That name is too long', field: 'name' };

  const email = str(body.email);
  if (!email) return { error: 'Please add your email', field: 'email' };
  if (email.length > 254 || !EMAIL_RE.test(email)) return { error: "That email doesn't look right", field: 'email' };

  const phone = str(body.phone);
  if (phone.length > 30) return { error: 'That phone number is too long', field: 'phone' };

  const fulfillment = str(body.fulfillment);
  if (!FULFILLMENT[fulfillment]) return { error: 'Please choose how to get it to you', field: 'fulfillment' };

  const message = str(body.message);
  if (message.length > 2000) return { error: 'Please keep it under 2000 characters', field: 'message' };

  const address = {
    ship_line1: str(body.ship_line1),
    ship_line2: str(body.ship_line2),
    ship_city: str(body.ship_city),
    ship_province: str(body.ship_province),
    ship_postcode: str(body.ship_postcode)
  };
  for (const [field, value] of Object.entries(address)) {
    if (value.length > 160) return { error: 'That address line is too long', field };
  }
  if (NEEDS_ADDRESS.has(fulfillment)) {
    if (!address.ship_line1) return { error: 'Please add a street address', field: 'ship_line1' };
    if (!address.ship_city) return { error: 'Please add a city or municipality', field: 'ship_city' };
    if (fulfillment === 'ship' && !address.ship_province) {
      return { error: 'Please add a province', field: 'ship_province' };
    }
  }

  const raw = body.selections;
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Please finish the steps first', field: 'selections' };
  if (raw.length > 40) return { error: 'That is too many selections', field: 'selections' };

  const selections = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'Something in your selections is unreadable', field: 'selections' };
    }
    const group_key = str(entry.group_key);
    if (!/^[a-z][a-z0-9_]*$/.test(group_key)) return { error: 'Something in your selections is unreadable', field: 'selections' };
    const option_key = str(entry.option_key);
    if (option_key && !/^[a-z0-9][a-z0-9_-]*$/.test(option_key)) {
      return { error: 'One of those choices is unreadable', field: 'selections' };
    }
    const text_value = str(entry.text_value);
    if (text_value.length > 2000) return { error: 'Please keep each answer under 2000 characters', field: 'selections' };
    if (!option_key && !text_value) continue;      // an untouched optional step
    selections.push({ group_key, option_key: option_key || null, text_value: text_value || null });
  }
  if (!selections.length) return { error: 'Please finish the steps first', field: 'selections' };

  // Prices are NOT read from the body. The browser may send an `estimate` — it
  // is ignored, exactly like cart prices on the catalog path. Whatever the RPC
  // computes from the option rows is the only number that exists.
  return { name, email, phone, fulfillment, message, selections, ...address };
}

export async function customRequestApi(request, env, { rateLimited, makeRef, sendEmail }) {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed' }, { allow: 'POST' });

  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY) return bad('That request is too large');

  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY) return bad('That request is too large');
    body = JSON.parse(raw);
  } catch {
    return bad('Expected JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Expected JSON');

  // Same honeypot as the enquiry form: a caught bot is told it worked.
  if (str(body.hp)) return json(200, { ok: true, ref: makeRef() });

  const parsed = validateCustomRequest(body);
  if (parsed.error) return bad(parsed.error, parsed.field);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await rateLimited(env, ip)) return json(429, { ok: false, error: 'Too many requests' }, { 'retry-after': '600' });

  const ref = makeRef();
  const saved = await createCustomRequest(env, ref, parsed);
  if (saved.error) {
    console.error('custom ' + ref + ': write failed — ' + saved.error.code);
    // Unlike the enquiry form, there is no useful fallback here. An enquiry is
    // a paragraph Kyle can read out of an email; a commission is a structured
    // spec that only exists as rows. Telling the customer it worked when the
    // rows are not there means they wait for a reply that can never come.
    return json(502, {
      ok: false,
      error: saved.error.code === '22023' || saved.error.code === '23503'
        ? 'Something you picked is no longer available. Please refresh and try again.'
        : "That didn't go through. Please try again in a moment."
    });
  }

  const order = saved.data || {};
  const token = order.track_token;
  const trackUrl = new URL('/order/' + ref, request.url);
  if (token) trackUrl.searchParams.set('t', token);

  const owner = env.OWNER_EMAIL;
  const from = env.FROM_EMAIL;
  if (env.RESEND_API_KEY && owner && from) {
    const mail = composeCustom(parsed, order, ref, trackUrl.toString());
    const toOwner = await sendEmail(env, {
      from, to: owner, reply_to: parsed.email,
      subject: '[Verre] Custom request — ' + ref,
      text: mail.ownerText, html: mail.ownerHtml
    });
    if (!toOwner.ok) console.error('custom ' + ref + ': owner email failed — ' + toOwner.error);

    const toCustomer = await sendEmail(env, {
      from, to: parsed.email, reply_to: owner,
      subject: "Verre — I've got your custom request (" + ref + ')',
      text: mail.customerText, html: mail.customerHtml
    });
    if (!toCustomer.ok) console.warn('custom ' + ref + ': confirmation failed — ' + toCustomer.error);
  } else {
    console.error('custom ' + ref + ': email is not configured');
  }

  console.log('custom ' + ref + ': ok'); // no names, no bodies
  return json(200, {
    ok: true,
    ref,
    token: token || null,
    track_url: trackUrl.pathname + trackUrl.search,
    estimate_cents: order.estimate_cents ?? null
  });
}

/* ------------------------------------------------------------------ */
/* reference photos                                                    */
/* ------------------------------------------------------------------ */

// ref + track_token is the capability. The token is 128 bits of randomness that
// only the submitter and their inbox ever saw, so holding it is proof enough to
// add photos to that one order — and it grants nothing else.
async function tokenHolder(env, body) {
  const ref = str(body.ref);
  const token = str(body.token);
  if (!/^VR-[A-Z2-9]{4}$/.test(ref) || !/^[a-f0-9]{32}$/.test(token)) return null;
  const found = await db(env).rest('orders',
    `select=id&ref=eq.${encodeURIComponent(ref)}&track_token=eq.${encodeURIComponent(token)}&limit=1`);
  return found.error ? null : (found.data?.[0]?.id || null);
}

export async function customUploadApi(request, env) {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed' }, { allow: 'POST' });
  let body;
  try { body = JSON.parse(await request.text()); } catch { return bad('Expected JSON'); }
  if (!body || typeof body !== 'object') return bad('Expected JSON');

  const orderId = await tokenHolder(env, body);
  if (!orderId) return json(404, { ok: false, error: 'That order could not be found' });

  // The signed URL is scoped to one path in a private bucket, so the worst a
  // replayed request achieves is another photo on an order the caller already
  // controls. attach_custom_image caps that at five.
  if (str(body.action) === 'attach') {
    const path = str(body.path);
    if (!path.startsWith('custom/' + orderId + '/')) return bad('That upload path is not yours', 'path');
    const attached = await attachReferenceImage(env, orderId, path, Number(body.position) || 0);
    if (attached.error) {
      const cleaned = await db(env).storage('object/custom-references/' + path, { method: 'DELETE' });
      if (cleaned.error) console.error('custom upload: orphan cleanup failed - ' + cleaned.error.code);
      return json(400, {
        ok: false,
        error: attached.error.message,
        code: cleaned.error ? 'ATTACH_FAILED_CLEANUP_PENDING' : 'ATTACH_FAILED_CLEANED'
      });
    }
    return json(200, { ok: true });
  }

  const signed = await signReferenceUpload(env, orderId, str(body.content_type));
  if (signed.error) {
    return json(signed.error.status || 502, { ok: false, error: signed.error.message });
  }
  return json(200, { ok: true, data: signed.data });
}

/* ------------------------------------------------------------------ */
/* GET /order/{ref}?t=…                                                */
/* ------------------------------------------------------------------ */

// Ordered, and matched against the row's status to decide what is done.
// 'cancelled' is deliberately absent — it is not a stage, it is an ending.
const STAGES = [
  { key: 'inquiry',          label: 'Request received',   blurb: 'I have your brief and I am reading it.' },
  { key: 'quoted',           label: 'Quote sent',         blurb: 'Check your email for the price and payment details.' },
  { key: 'awaiting_payment', label: 'Waiting on payment', blurb: 'I start as soon as the deposit lands.' },
  { key: 'paid',             label: 'Paid',               blurb: 'Payment received. You are in the queue.' },
  { key: 'in_production',    label: 'Being made',         blurb: 'This one is on the bench right now.' },
  { key: 'fulfilled',        label: 'On its way',          blurb: 'Sent. Details below.' }
];

export async function trackPage(request, env, ref) {
  const token = new URL(request.url).searchParams.get('t') || '';
  // One response for a bad token, a bad ref and an order that does not exist.
  // Anything else turns this page into a way to test whether a ref is real.
  if (!/^[a-f0-9]{32}$/.test(token)) return trackMissing();

  const result = await trackOrder(env, ref, token);
  if (result.error) {
    console.error('track ' + ref + ': ' + result.error.code);
    return trackShell('Order status', '<h1>Not right now</h1><p>I could not look that up. Please try again in a moment.</p>', 503);
  }
  const order = result.data;
  if (!order || !order.ref) return trackMissing();

  const cancelled = order.status === 'cancelled';
  const currentIndex = STAGES.findIndex((stage) => stage.key === order.status);
  const timeline = STAGES.map((stage, index) => {
    const done = !cancelled && index < currentIndex;
    const now = !cancelled && index === currentIndex;
    const tint = done ? '#F157A8' : now ? '#EF4056' : '#FFE0EE';
    return `<li style="display:flex;gap:14px;align-items:flex-start;padding:0 0 18px;position:relative;">
      <span aria-hidden="true" style="flex:none;width:22px;height:22px;border-radius:50%;background:${tint};border:4px solid #fff;box-shadow:0 0 0 2px ${tint};margin-top:2px;"></span>
      <span>
        <strong style="display:block;font-size:14px;color:${done || now ? '#3A2430' : '#B98AA0'};">${escapeHtml(stage.label)}${now ? ' <span style="color:#EF4056">— now</span>' : ''}</strong>
        <span style="font-size:13px;color:#7A5C6B;">${done || now ? escapeHtml(stage.blurb) : ''}</span>
      </span>
    </li>`;
  }).join('');

  const spec = (order.selections || []).map((row) => `<tr>
      <td style="padding:8px 14px 8px 0;color:#7A5C6B;font-size:13px;vertical-align:top;">${escapeHtml(row.group_label)}</td>
      <td style="padding:8px 0;font-size:13px;color:#3A2430;white-space:pre-wrap;">${escapeHtml(row.option_label || row.text_value || '—')}</td>
    </tr>`).join('');

  const money = order.quoted_cents != null
    ? `<p style="margin:0 0 6px;font-size:15px;"><strong>Your quote:</strong> ${peso(order.quoted_cents)}</p>` +
      (order.deposit_cents ? `<p style="margin:0 0 6px;font-size:13px;color:#7A5C6B;">Deposit to start: ${peso(order.deposit_cents)}</p>` : '')
    : order.estimate_cents != null
      ? `<p style="margin:0 0 6px;font-size:13px;color:#7A5C6B;">Estimate from the form: ${peso(order.estimate_cents)}. I'll confirm the real price by email.</p>`
      : '';

  const shipping = order.ship_tracking
    ? `<p style="margin:14px 0 0;font-size:13px;">Sent via <strong>${escapeHtml(order.ship_carrier || 'courier')}</strong> · tracking <strong>${escapeHtml(order.ship_tracking)}</strong></p>`
    : '';

  const body = cancelled
    ? `<p class="tag">Custom order</p><h1>${escapeHtml(order.ref)}</h1>
       <p style="color:#7A5C6B;">This order was cancelled. If that is a surprise, reply to any email from me and I'll sort it out.</p>`
    : `<p class="tag">Custom order</p><h1>${escapeHtml(order.ref)}</h1>
       <p style="margin:0 0 22px;color:#7A5C6B;">${order.first_name ? 'Hi ' + escapeHtml(order.first_name) + ' — h' : 'H'}ere is where your piece is up to.</p>
       <ol style="list-style:none;margin:0 0 26px;padding:0;">${timeline}</ol>
       ${money}${shipping}
       <h2 style="font-size:14px;letter-spacing:.16em;text-transform:uppercase;color:#B98AA0;margin:28px 0 6px;">What you asked for</h2>
       <table style="width:100%;border-collapse:collapse;">${spec}</table>
       <p style="margin:24px 0 0;font-size:13px;color:#7A5C6B;">Everything is made by hand, one at a time. Thank you for waiting on it. 💗</p>`;

  return trackShell('Order ' + order.ref, body, 200);
}

const trackMissing = () => trackShell(
  'Order not found',
  '<h1>Not found</h1><p style="color:#7A5C6B;">This link has expired or was mistyped. Use the tracking link from your confirmation email, or reply to it and I will resend.</p>',
  404
);

const peso = (cents) => '₱' + (Number(cents || 0) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 });
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const trackShell = (title, content, status) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
   <meta name="viewport" content="width=device-width,initial-scale=1">
   <meta name="robots" content="noindex">
   <title>${escapeHtml(title)} · Verre</title>
   <style>body{margin:0;padding:32px 18px;background:#FFF6F0;color:#3A2430;font-family:system-ui,-apple-system,sans-serif;line-height:1.6}
   .card{max-width:560px;margin:auto;background:#fff;border:6px solid #fff;border-radius:30px;padding:30px 28px;box-shadow:0 14px 0 rgba(239,64,86,.12),0 26px 44px rgba(160,40,90,.16)}
   h1{color:#EF4056;margin:6px 0 4px;font-size:30px}
   .tag{margin:0;text-transform:uppercase;letter-spacing:.2em;color:#F157A8;font-size:11px;font-weight:700}
   a{color:#F157A8}</style></head>
   <body><main class="card">${content}
   <p style="margin:26px 0 0;text-align:center;"><a href="/" style="display:inline-block;background:linear-gradient(140deg,#FFB6D9,#F157A8);color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:12px 24px;border-radius:999px;border:3px solid #fff;box-shadow:0 5px 0 rgba(239,64,86,.28)">Back to Verre</a></p>
   </main></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private,no-store' } }
);

/* ------------------------------------------------------------------ */
/* email                                                               */
/* ------------------------------------------------------------------ */

export function composeCustom(parsed, order, ref, trackUrl) {
  const selections = order.selections || [];
  const estimate = order.estimate_cents;
  const lines = selections.map((row) =>
    '  ' + row.group_label + ': ' + (row.option_label || row.text_value || '—') +
    (row.price_delta_cents ? '  (+' + peso(row.price_delta_cents) + ')' : ''));
  const rows = selections.map((row) =>
    '<tr><td style="padding:6px 14px 6px 0;color:#7A5C6B;vertical-align:top">' + escapeHtml(row.group_label) +
    '</td><td style="padding:6px 0;white-space:pre-wrap">' + escapeHtml(row.option_label || row.text_value || '—') +
    '</td></tr>').join('');

  const address = [parsed.ship_line1, parsed.ship_line2, parsed.ship_city, parsed.ship_province, parsed.ship_postcode]
    .filter(Boolean).join(', ');

  const ownerText = [
    'Custom request — ' + ref, '',
    'Name:  ' + parsed.name,
    'Email: ' + parsed.email,
    parsed.phone ? 'Phone: ' + parsed.phone : null,
    'How:   ' + FULFILLMENT[parsed.fulfillment],
    address ? 'To:    ' + address : null,
    '', 'The brief:', lines.join('\n'),
    '', estimate != null ? 'Form estimate: ' + peso(estimate) + ' — not a quote, you set the real price in /admin.' : null,
    '', 'Open /admin → Custom to quote it. Reply to this email to answer ' + parsed.name + ' directly.'
  ].filter((l) => l !== null).join('\n');

  const ownerBody =
    '<table class="email-detail" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#FFF8F3;border-radius:16px;margin:0 0 22px">' +
    '<tr><td style="color:#9A6D82;padding:16px 18px 4px;width:34%">Customer</td><td style="padding:16px 18px 4px;text-align:right"><strong>' + escapeHtml(parsed.name) + '</strong></td></tr>' +
    '<tr><td style="color:#9A6D82;padding:4px 18px">Email</td><td style="padding:4px 18px;text-align:right"><a href="mailto:' + escapeHtml(parsed.email) + '" style="color:#F157A8">' + escapeHtml(parsed.email) + '</a></td></tr>' +
    (parsed.phone ? '<tr><td style="color:#9A6D82;padding:4px 18px">Phone</td><td style="padding:4px 18px;text-align:right">' + escapeHtml(parsed.phone) + '</td></tr>' : '') +
    '<tr><td style="color:#9A6D82;padding:4px 18px' + (address ? '' : ' 16px') + '">Delivery</td><td style="padding:4px 18px' + (address ? '' : ' 16px') + ';text-align:right">' + escapeHtml(FULFILLMENT[parsed.fulfillment]) + '</td></tr>' +
    (address ? '<tr><td style="color:#9A6D82;padding:4px 18px 16px;vertical-align:top">Address</td><td style="padding:4px 18px 16px;text-align:right">' + escapeHtml(address) + '</td></tr>' : '') +
    '</table>' +
    '<h2 style="font-family:Georgia,serif;font-size:20px;margin:0 0 8px">The brief</h2>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:0 0 18px">' + rows + '</table>' +
    (estimate != null
      ? '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#FFF8F3;border-radius:16px;margin:0 0 20px"><tr><td style="padding:18px">' +
        '<strong style="display:block;margin-bottom:5px">Form estimate · ' + escapeHtml(peso(estimate)) + '</strong>' +
        '<span style="color:#6F5662">This is a ballpark, not the final quote. Set the real price in the studio dashboard.</span></td></tr></table>'
      : '') +
    emailReference(ref);

  const ownerHtml = emailShell({
    preheader: parsed.name + ' sent a custom request.',
    eyebrow: 'Studio notification',
    title: 'New custom request',
    intro: escapeHtml(parsed.name) + ' finished the commission brief.',
    body: ownerBody,
    action: emailButton('Open the studio dashboard', new URL('/admin', trackUrl).toString()),
    footer: 'Private studio notification · Reply goes directly to the customer.'
  });

  const customerText = [
    'Hi ' + parsed.name + ',', '',
    "Thank you — I've got your custom request. Here is what you sent me:", '',
    lines.join('\n'), '',
    estimate != null
      ? 'The form estimated ' + peso(estimate) + '. That is a ballpark, not the price — I read every brief myself and will send you a real quote within 2-3 days.'
      : "I'll read it properly and send you a quote within 2-3 days.",
    '', 'Track it here: ' + trackUrl,
    'Keep that link — it is the only way to see where your piece is up to.',
    '', 'Your reference is ' + ref + '.', '',
    'Everything is made by hand, one at a time. Thank you for waiting on it.', '', '— Verre'
  ].join('\n');

  const customerBody =
    '<p style="margin:0 0 18px">Here is the brief that reached the studio:</p>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:0 0 18px">' + rows + '</table>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#FFF8F3;border-radius:16px;margin:20px 0"><tr><td style="padding:18px">' +
    (estimate != null
      ? '<strong style="display:block;margin-bottom:5px">Ballpark estimate · ' + escapeHtml(peso(estimate)) + '</strong><span style="color:#6F5662">This is not the final price. I read every brief myself and will send your real quote within 2–3 days.</span>'
      : '<strong style="display:block;margin-bottom:5px">What happens next?</strong><span style="color:#6F5662">I’ll read your brief properly and send your quote within 2–3 days.</span>') +
    '</td></tr></table>' +
    emailReference(ref) +
    '<p style="color:#7A5C6B;font-size:13px;margin:18px 0 0;text-align:center">Keep your private tracking link handy—it is the easiest way to see where your piece is up to.</p>';

  const customerHtml = emailShell({
    preheader: 'Your custom Verre request is safely in the studio queue.',
    eyebrow: 'Commission received',
    title: 'Your idea is in the studio',
    intro: 'Hi ' + escapeHtml(parsed.name) + ' — thank you for trusting me with something made just for you.',
    body: customerBody,
    action: emailButton('Track your request', trackUrl),
    footer: 'You received this because you sent a custom request through the Verre website.'
  });

  return { ownerText, ownerHtml, customerText, customerHtml };
}

export const _test = { validateCustomRequest, composeCustom, STAGES, FULFILLMENT };
