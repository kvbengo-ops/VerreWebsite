// node scripts/check-db.mjs — applies every migration to a real Postgres and
// exercises the RPCs against it.
//
// This exists because `custom_wizard()` once shipped with `order by g.step`
// where `g` was a subquery *column*, not a table alias. Every other check in
// this repo passed it: it is valid to a SQL parser, and the reviewing eye reads
// it as obviously fine. Postgres rejects it at CREATE time, so the first sign
// of trouble was `supabase db push` failing — which is a slow, manual, and
// entirely avoidable way to find out.
//
// Parsing SQL proves it is well-formed. Only running it proves it is correct.
//
// PGlite is Postgres compiled to WebAssembly, so this needs no Docker and no
// running server. It is a devDependency and the whole check skips cleanly if it
// is absent, so `npm test` still works on a fresh clone without it.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migrationsDir = resolve(root, 'supabase', 'migrations');

let PGlite, pgcrypto;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
} catch {
  console.log('skip — @electric-sql/pglite is not installed (npm install), migrations not executed');
  process.exit(0);
}

const db = await PGlite.create({ extensions: { pgcrypto } });

// Supabase provides these; a bare Postgres does not. Stub only what the
// migrations actually touch — a fuller fake would start hiding real breakage.
await db.exec(`
  create schema extensions;
  create extension pgcrypto with schema extensions;
  create schema storage;
  create table storage.buckets(id text primary key, name text, public boolean);
  create role service_role; create role anon; create role authenticated;
`);

// One transaction per file, which is what the Supabase CLI does. Running them
// all in a single transaction would hide exactly the ALTER TYPE ADD VALUE
// problem that the status migration exists to avoid.
for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
  try {
    await db.exec('begin;\n' + readFileSync(resolve(migrationsDir, name), 'utf8') + '\ncommit;');
  } catch (error) {
    console.error('FAIL  ' + name + '\n      ' + error.message);
    process.exit(1);
  }
}
await db.exec(readFileSync(resolve(root, 'supabase', 'seed.sql'), 'utf8'));

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const refuses = async (sql, params, why) => {
  try { await db.query(sql, params); assert.fail('expected a refusal: ' + why); }
  catch (error) {
    if (String(error.message).startsWith('expected a refusal')) throw error;
    return error.message;
  }
};

const customer = { name: 'Ana Cruz', email: 'ana@example.com', fulfillment: 'ship', ship_line1: '12 Mango Ave', ship_city: 'Cebu City' };
const brief = [
  { group_key: 'base', option_key: 'glass-panel' },
  { group_key: 'size', option_key: 'large' },
  { group_key: 'design', option_key: 'metallic' },
  { group_key: 'brief', text_value: 'My cat Biscuit.' }
];
const submit = (ref, selections = brief) => one(
  'select create_custom_request($1,$2::jsonb,$3::jsonb) as o',
  [ref, JSON.stringify(selections), JSON.stringify(customer)]
);

/* ---- the wizard the storefront reads ------------------------------ */
const { custom_wizard: steps } = await one('select custom_wizard()');
assert.deepEqual(steps.map((s) => s.key), ['base', 'size', 'design', 'brief'], 'steps must come back in order');
const medium = steps[1].options.find((o) => o.key === 'medium');
assert.equal(medium.parent_key, 'glass-panel', 'a conditional choice must name the choice it depends on');
assert.equal(medium.parent_group_key, 'base', 'and the step that choice lives in, or the wizard cannot filter');

/* ---- pricing is the database's job, not the browser's -------------- */
const { o: order } = await submit('VR-AAAA');
assert.equal(order.estimate_cents, 120000 + 110000 + 35000, 'the estimate must sum the option deltas');
assert.equal(order.total_cents, 0, 'an estimate is not revenue and must not reach the dashboard as if it were');
assert.equal(order.subtotal_cents, 0);
assert.match(order.track_token, /^[a-f0-9]{32}$/, 'every commission needs a 128-bit tracking token');

const { o: tampered } = await submit('VR-BBBB', brief.map((s) => ({ ...s, price_delta_cents: 1, price: 1 })));
assert.equal(tampered.estimate_cents, 265000, 'a price sent by the browser must change nothing');

await db.query("update custom_options set price_delta_cents = 999999 where key = 'glass-panel'");
const snapshot = await one("select price_delta_cents from custom_order_selections where option_key='glass-panel' and order_id=$1", [order.id]);
assert.equal(snapshot.price_delta_cents, 120000, 'raising a price must never rewrite a brief already submitted');
await db.query("update custom_options set price_delta_cents = 120000 where key = 'glass-panel'");

/* ---- an incomplete brief is worse than a failed submit ------------- */
assert.match(await refuses('select create_custom_request($1,$2::jsonb,$3::jsonb)',
  ['VR-CCCC', JSON.stringify([brief[0]]), JSON.stringify(customer)], 'missing required steps'),
  /missing required step/i);

await db.query("update custom_options set is_active = false where key = 'metallic'");
assert.match(await refuses('select create_custom_request($1,$2::jsonb,$3::jsonb)',
  ['VR-DDDD', JSON.stringify(brief), JSON.stringify(customer)], 'a retired choice'),
  /no longer available/i);
await db.query("update custom_options set is_active = true where key = 'metallic'");

/* ---- the public tracking page ------------------------------------- */
const { public_order_track: guessed } = await one(`select public_order_track('VR-AAAA', $1)`, ['0'.repeat(32)]);
assert.equal(guessed, null, 'a guessed ref with the wrong token must return nothing at all');
const { public_order_track: tracked } = await one('select public_order_track($1,$2)', ['VR-AAAA', order.track_token]);
assert.equal(tracked.first_name, 'Ana', 'a first name is enough to say hello with');
for (const column of ['customer_name', 'customer_email', 'customer_phone', 'ship_line1', 'track_token']) {
  assert.ok(!(column in tracked), column + ' must never reach the public tracking page');
}

/* ---- the commission pipeline -------------------------------------- */
const { set_custom_quote: quoted } = await one("select set_custom_quote($1,300000,150000,'Two coats.','kyle@verre.ph')", [order.id]);
assert.equal(quoted.status, 'quoted');
assert.equal(quoted.total_cents, 300000, 'quoting is the moment a brief becomes revenue');
assert.match(await refuses('select set_custom_quote($1,100000,200000,null,$2)', [order.id, 'kyle@verre.ph'], 'a deposit larger than the quote'),
  /deposit cannot exceed/i);

for (const status of ['awaiting_payment', 'paid', 'in_production', 'fulfilled']) {
  const { set_order_status: moved } = await one('select set_order_status($1,$2::order_status,null,$3,null)', [order.id, status, 'kyle@verre.ph']);
  assert.equal(moved.status, status, 'the pipeline must accept ' + status);
}
const stamps = await one('select production_started_at, shipped_at from orders where id=$1', [order.id]);
assert.ok(stamps.production_started_at && stamps.shipped_at, 'production and dispatch must be timestamped');

const commissionStock = await one('select count(*)::int as n from stock_movements where order_id=$1', [order.id]);
assert.equal(commissionStock.n, 0, 'a made-to-order piece never came off a shelf, so it moves no stock');

/* ---- the catalog path must be untouched by all of the above -------- */
await db.query("update products set cost_cents=40000 where slug='peach-sky-glass-panel'");
const { create_inquiry: web } = await one("select create_inquiry('VR-FFFF','order',$1::jsonb,$2::jsonb)",
  [JSON.stringify([{ id: 'peach-sky-glass-panel', qty: 1 }]), JSON.stringify({ name: 'Bea', email: 'b@e.co', fulfillment: 'pickup' })]);
// Cost at payment, rather than inquiry time, is the actual cost of the sale.
await db.query("update products set cost_cents=41000 where slug='peach-sky-glass-panel'");
for (const status of ['quoted', 'paid', 'fulfilled']) {
  await one('select set_order_status($1,$2::order_status,null,$3,$4)', [web.id, status, 'kyle@verre.ph', '']);
}
const webStock = await one('select count(*)::int as n from stock_movements where order_id=$1', [web.id]);
assert.ok(webStock.n > 0, 'a catalog order must still write a stock movement when it is paid');
const webCost = await one('select unit_cost_cents,cost_total_cents from order_items where order_id=$1', [web.id]);
assert.equal(webCost.unit_cost_cents,41000,'a paid order line snapshots the product cost at payment');
assert.equal(webCost.cost_total_cents,41000,'line cost multiplies the unit snapshot by quantity');
const { dashboard_snapshot: profitSnapshot } = await one("select dashboard_snapshot('2000-01-01'::timestamptz)");
assert.ok(profitSnapshot.product_cost_cents>=41000,'the dashboard includes recorded product cost');
assert.ok(profitSnapshot.uncosted_orders>0,'custom or historical sales without cost are reported honestly');
assert.equal(profitSnapshot.gross_profit_cents,null,'gross profit is not invented while cost coverage is incomplete');
await db.query("update orders set sold_at='2100-01-01T00:00:00Z' where id=$1",[web.id]);
const { dashboard_snapshot: completeProfit } = await one("select dashboard_snapshot('2099-01-01'::timestamptz)");
assert.equal(completeProfit.revenue_cents,85000,'sales revenue remains the amount the customer paid');
assert.equal(completeProfit.product_cost_cents,41000,'product cost is the frozen sale-time cost');
assert.equal(completeProfit.gross_profit_cents,44000,'gross profit equals sales minus product cost');
assert.equal(Number(completeProfit.gross_margin_percent),51.8,'gross margin is profit divided by sales');

const { o: fresh } = await submit('VR-GGGG');
assert.match(await refuses("select set_order_status($1,'fulfilled'::order_status,null,$2,null)", [fresh.id, 'kyle@verre.ph'], 'inquiry straight to fulfilled'),
  /invalid status transition/i);

/* ---- guard rails --------------------------------------------------- */
for (let i = 0; i < 5; i++) await db.query('select attach_custom_image($1,$2,$3)', [fresh.id, 'custom/x/' + i + '.webp', i]);
assert.match(await refuses('select attach_custom_image($1,$2,$3)', [fresh.id, 'custom/x/6.webp', 6], 'a sixth photo'),
  /enough reference photos/i);

const baseGroup = await one("select id from custom_option_groups where key='base'");
const baseOption = await one("select id from custom_options where key='charm-set'");
assert.match(await refuses('insert into custom_options(group_id,parent_option_id,key,label) values($1,$2,$3,$4)',
  [baseGroup.id, baseOption.id, 'loop', 'Loop'], 'an option depending on its own step'),
  /cannot depend on another option in its own group/i);

/* ---- account deletion cannot lock out the workroom ---------------- */
const ownerAccount = await one("insert into admin_accounts(email,display_name,role,created_by,updated_by) values('owner@verre.test','Owner','super_admin','test','test') returning id");
const peerAccount = await one("insert into admin_accounts(email,display_name,role,created_by,updated_by) values('peer@verre.test','Peer','super_admin','test','test') returning id");
const staffAccount = await one("insert into admin_accounts(email,display_name,role,created_by,updated_by) values('staff@verre.test','Staff','general_admin','test','test') returning id");
assert.match(await refuses('select delete_admin_account($1,$2)', [ownerAccount.id, 'owner@verre.test'], 'deleting your own account'),
  /cannot delete your own account/i);
await one('select delete_admin_account($1,$2)', [staffAccount.id, 'owner@verre.test']);
assert.equal((await one('select count(*)::int as n from admin_accounts where id=$1', [staffAccount.id])).n, 0,
  'a deleted staff account must be gone');
assert.equal((await one("select count(*)::int as n from admin_audit_log where action='account.delete' and entity_id=$1", [staffAccount.id])).n, 1,
  'account deletion must leave an audit record');
await one('select delete_admin_account($1,$2)', [peerAccount.id, 'owner@verre.test']);
assert.match(await refuses('select delete_admin_account($1,$2)', [ownerAccount.id, 'bootstrap@verre.test'], 'deleting the final Super Admin'),
  /keep at least one active database super admin/i);

console.log('ok — every migration applies, and the commission RPCs behave against real Postgres');
