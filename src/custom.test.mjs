// node src/custom.test.mjs — fails loudly if commission validation, pricing
// trust, or the tracking guard drifts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _test } from './api/custom.js';

const { validateCustomRequest, composeCustom, STAGES } = _test;
const root = resolve(import.meta.dirname, '..');

const request = (over = {}) => ({
  name: 'Ana',
  email: 'ana@example.com',
  fulfillment: 'pickup',
  selections: [
    { group_key: 'base', option_key: 'glass-panel' },
    { group_key: 'brief', text_value: 'My cat Biscuit.' }
  ],
  ...over
});

/* ---- prices are never taken from the browser ---------------------- */
// The single most valuable assertion in this file. A commission is priced from
// option rows in Postgres; anything the client says about money is noise. If
// this ever passes a number through, someone can commission an A3 panel for
// nothing and the first anyone hears of it is when Kyle ships it.
const withPrices = validateCustomRequest(request({
  estimate_cents: 1,
  total_cents: 1,
  selections: [
    { group_key: 'base', option_key: 'glass-panel', price_delta_cents: 1, price: 1 },
    { group_key: 'brief', text_value: 'My cat Biscuit.' }
  ]
}));
assert.equal(withPrices.error, undefined);
assert.equal(withPrices.estimate_cents, undefined, 'a client-sent estimate must not survive validation');
assert.equal(withPrices.total_cents, undefined, 'a client-sent total must not survive validation');
for (const selection of withPrices.selections) {
  assert.deepEqual(
    Object.keys(selection).sort(),
    ['group_key', 'option_key', 'text_value'],
    'only keys and free text may reach the database — never a price'
  );
}

/* ---- rejections, each naming the field the form should focus ------ */
const rejects = [
  [request({ name: '   ' }), 'name'],
  [request({ name: 'x'.repeat(101) }), 'name'],
  [request({ email: 'ana@example' }), 'email'],
  [request({ email: 'a b@example.com' }), 'email'],
  [request({ email: '' }), 'email'],
  [request({ fulfillment: 'teleport' }), 'fulfillment'],
  [request({ fulfillment: '' }), 'fulfillment'],
  [request({ phone: '9'.repeat(31) }), 'phone'],
  [request({ message: 'x'.repeat(2001) }), 'message'],
  [request({ selections: [] }), 'selections'],
  [request({ selections: 'all of them' }), 'selections'],
  [request({ selections: Array.from({ length: 41 }, () => ({ group_key: 'base', option_key: 'a' })) }), 'selections'],
  [request({ selections: [{ group_key: 'Base Step', option_key: 'a' }] }), 'selections'],
  [request({ selections: [{ group_key: 'base', option_key: '../../etc/passwd' }] }), 'selections'],
  [request({ selections: [{ group_key: 'base', text_value: 'x'.repeat(2001) }] }), 'selections']
];
for (const [body, field] of rejects) {
  const parsed = validateCustomRequest(body);
  assert.ok(parsed.error, JSON.stringify(body).slice(0, 70) + ' must be rejected');
  assert.equal(parsed.field, field, 'rejection must name the field to focus');
}

/* ---- an address is required only when something has to travel ----- */
assert.equal(validateCustomRequest(request({ fulfillment: 'pickup' })).error, undefined,
  'pickup must not demand a shipping address');

for (const method of ['delivery', 'ship']) {
  assert.equal(validateCustomRequest(request({ fulfillment: method })).field, 'ship_line1',
    method + ' needs a street address');
  assert.equal(validateCustomRequest(request({ fulfillment: method, ship_line1: '12 Mango Ave' })).field, 'ship_city',
    method + ' needs a city');
}
// Province matters for a courier and not for a local drop-off.
assert.equal(
  validateCustomRequest(request({ fulfillment: 'delivery', ship_line1: '12 Mango Ave', ship_city: 'Cebu City' })).error,
  undefined, 'Cebu delivery must not demand a province');
assert.equal(
  validateCustomRequest(request({ fulfillment: 'ship', ship_line1: '12 Mango Ave', ship_city: 'Cebu City' })).field,
  'ship_province', 'nationwide shipping must demand a province');

/* ---- empty steps are dropped, not sent as blanks ------------------ */
const sparse = validateCustomRequest(request({
  selections: [
    { group_key: 'base', option_key: 'glass-panel' },
    { group_key: 'extras', option_key: '', text_value: '   ' },
    { group_key: 'brief', text_value: 'My cat Biscuit.' }
  ]
}));
assert.equal(sparse.selections.length, 2, 'an untouched optional step must not be submitted as an empty row');

/* ---- the pipeline is ordered and cancellation is not a stage ------ */
assert.deepEqual(
  STAGES.map((s) => s.key),
  ['inquiry', 'quoted', 'awaiting_payment', 'paid', 'in_production', 'fulfilled'],
  'the tracking timeline must match the database status order'
);
assert.ok(!STAGES.some((s) => s.key === 'cancelled'),
  'cancelled is an ending, not a stage on the way to one');

/* ---- the emails ---------------------------------------------------- */
const parsed = validateCustomRequest(request({ fulfillment: 'ship', ship_line1: '12 Mango Ave', ship_city: 'Cebu City', ship_province: 'Cebu' }));
const mail = composeCustom(parsed, {
  estimate_cents: 120000,
  selections: [
    { group_label: 'What should I make?', option_label: 'Hand-painted glass panel', price_delta_cents: 120000 },
    { group_label: 'Tell me about it', text_value: 'My cat Biscuit.' }
  ]
}, 'VR-7K2M', 'https://verre.example/order/VR-7K2M?t=' + 'a'.repeat(32));

assert.ok(mail.customerText.includes('VR-7K2M'), 'the customer needs their reference');
assert.ok(mail.customerText.includes('/order/VR-7K2M?t='), 'the customer needs their tracking link');
assert.ok(mail.customerHtml.includes('/order/VR-7K2M?t='), 'the HTML mail needs the tracking link too');
assert.ok(mail.customerHtml.startsWith('<!doctype html>'), 'custom requests use the complete branded email shell');
assert.ok(mail.customerHtml.includes('Track your request'), 'the private tracking action is clear');
// Calling an estimate a price is a promise Kyle then has to honour or retract.
assert.ok(/not the price|ballpark/.test(mail.customerText),
  'the estimate must be described as an estimate, never as the price');
assert.ok(mail.ownerText.includes('ana@example.com') && mail.ownerText.includes('12 Mango Ave'),
  "Kyle's copy needs the address he has to ship to");
assert.ok(!mail.customerText.includes('12 Mango Ave') || mail.customerText.includes('Ana'),
  'nothing leaks into the wrong copy');

// HTML injection through a brief. These bodies are concatenated strings, so an
// unescaped label is a live cross-site scripting hole in Kyle's inbox.
const hostile = composeCustom(
  validateCustomRequest(request({ name: '<script>alert(1)</script>' })),
  { estimate_cents: 0, selections: [{ group_label: 'Brief', text_value: '<img src=x onerror=alert(1)>' }] },
  'VR-7K2M', 'https://verre.example/order/VR-7K2M'
);
assert.ok(!hostile.ownerHtml.includes('<script>alert(1)</script>'), 'a hostile name must be escaped in the owner email');
assert.ok(!hostile.ownerHtml.includes('<img src=x onerror='), 'a hostile brief must be escaped in the owner email');
assert.ok(!hostile.customerHtml.includes('<script>alert(1)</script>'), 'a hostile name must be escaped in the customer email');

/* ---- the migration keeps its promises ------------------------------ */
const sql = [
  await readFile(resolve(root, 'supabase/migrations/20260729090000_custom_status.sql'), 'utf8'),
  await readFile(resolve(root, 'supabase/migrations/20260729090100_custom_orders.sql'), 'utf8')
].join('\n');

for (const table of ['custom_option_groups', 'custom_options', 'custom_order_selections', 'custom_order_images']) {
  assert.match(sql, new RegExp('alter table ' + table + '\\s+enable row level security'), table + ' must have RLS');
}
assert.doesNotMatch(sql, /\bcreate\s+policy\b/i, 'deny-all RLS must not gain permissive policies');

for (const fn of ['create_custom_request', 'set_custom_quote', 'set_custom_shipping', 'public_order_track', 'attach_custom_image', 'custom_wizard']) {
  const start = sql.indexOf('create function ' + fn);
  assert.ok(start >= 0, fn + ' is missing from the migration');
  const block = sql.slice(start, start + 500);
  assert.match(block, /security definer/i, fn + ' must be security definer');
  assert.match(block, /set search_path = public,( extensions,)? pg_temp/i, fn + ' must lock its search_path');
}

assert.match(sql, /values \('custom-references', 'custom-references', false\)/,
  'reference photos are strangers’ pets and weddings — the bucket must be private');

// The enum has to land in its own transaction or a fresh database dies on the
// first function that names the new label.
const statusMigration = await readFile(resolve(root, 'supabase/migrations/20260729090000_custom_status.sql'), 'utf8');
assert.match(statusMigration, /alter type order_status add value/, 'the status migration must add the new stages');
assert.doesNotMatch(statusMigration, /create (function|table)/i,
  'ALTER TYPE ADD VALUE must not share a transaction with anything that uses the new label');

// The tracking page is public. Ref alone is four characters of a 32-symbol
// alphabet, which is a weekend of guessing.
const trackFn = sql.slice(sql.indexOf('create function public_order_track'));
assert.match(trackFn, /o\.track_token = p_token/, 'the tracking page must require the emailed token');
assert.doesNotMatch(trackFn.slice(0, trackFn.indexOf('$$;')), /customer_email|customer_phone|ship_line1/,
  'the public tracking page must not expose contact details or a street address');

// An unanswered commission is not revenue. Reaching the dashboard as if it were
// would overstate every month in which someone asked for a price and vanished.
const createFn = sql.slice(sql.indexOf('create function create_custom_request'));
assert.match(createFn.slice(0, createFn.indexOf('$$;')), /0, 0,/,
  'a new commission must open with subtotal_cents and total_cents at zero');

console.log('ok — commission validation, price trust, tracking guard, and migration invariants');
