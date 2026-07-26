-- npx supabase test db
--
-- The whole file runs in one transaction and rolls back, so it is safe against a
-- seeded database. Fixtures are created here rather than read from seed.sql so a
-- copy edit to a product description can never break a test.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into products (id, slug, name, category, tag, price_cents, status, stock_on_hand, one_of_a_kind)
values
  ('11111111-1111-1111-1111-111111111111', 'test-one-off', 'Test One Off', 'glass', 'Glass painting', 50000, 'active', 1, true),
  ('22222222-2222-2222-2222-222222222222', 'test-stickers', 'Test Stickers', 'stickers', 'Sheet', 10000, 'active', 10, false);

insert into stock_movements (product_id, delta, reason)
values
  ('11111111-1111-1111-1111-111111111111', 1, 'initial'),
  ('22222222-2222-2222-2222-222222222222', 10, 'initial');

-- ─── a plain sale ────────────────────────────────────────────
select lives_ok($$
  select record_sale(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'pos',
    '[{"product_id":"22222222-2222-2222-2222-222222222222","qty":3}]'::jsonb,
    now(), 'cash', 50000, null, '{"name":"Ana"}'::jsonb, 'kyle@verre.ph')
$$, 'a normal POS sale succeeds');

select is(
  (select stock_on_hand from products where slug = 'test-stickers'), 7,
  'stock drops by the quantity sold');
select is(
  (select unit_price_cents from order_items where product_name = 'Test Stickers'), 10000,
  'the unit price is snapshotted onto the line');
select is(
  (select total_cents from orders where client_uuid = 'aaaaaaaa-0000-0000-0000-000000000001'), 30000,
  'the total is computed from the catalog, not the client');
select is(
  (select change_cents from orders where client_uuid = 'aaaaaaaa-0000-0000-0000-000000000001'), 20000,
  'cash change is calculated');
select is(
  (select is_oversell from orders where client_uuid = 'aaaaaaaa-0000-0000-0000-000000000001'), false,
  'a sale within stock is not flagged');

-- ─── §1.2 idempotency ────────────────────────────────────────
-- Every POS write will be retried. A replay must be a no-op that returns the
-- original order.
select is(
  (select record_sale(
     'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'pos',
     '[{"product_id":"22222222-2222-2222-2222-222222222222","qty":3}]'::jsonb,
     now(), 'cash', 50000, null, '{"name":"Ana"}'::jsonb, 'kyle@verre.ph') ->> 'ref'),
  (select ref from orders where client_uuid = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'a replayed sale returns the original order');

select is((select count(*) from orders), 1::bigint, 'the replay created no second order');
select is(
  (select stock_on_hand from products where slug = 'test-stickers'), 7,
  'the replay moved no stock');

-- ─── §1.4 history is immutable ───────────────────────────────
update products set price_cents = 99900 where slug = 'test-stickers';
select is(
  (select line_total_cents from order_items where product_name = 'Test Stickers'), 30000,
  'raising a price does not rewrite an old receipt');
update products set price_cents = 10000 where slug = 'test-stickers';

-- ─── discounts and 60-second POS undo ──────────────────────
select lives_ok($$
  select record_sale(
    'aaaaaaaa-0000-0000-0000-000000000004'::uuid, 'pos',
    '[{"product_id":"22222222-2222-2222-2222-222222222222","qty":1}]'::jsonb,
    now(), 'gcash', null, null,
    '{"discount_cents":1000,"discount_reason":"market friend","gcash_reference":"GC-123"}'::jsonb,
    'kyle@verre.ph')
$$, 'a discounted GCash sale succeeds');
select is(
  (select total_cents from orders where client_uuid = 'aaaaaaaa-0000-0000-0000-000000000004'),
  9000, 'the discount is applied inside record_sale');
select is(
  (select gcash_reference from orders where client_uuid = 'aaaaaaaa-0000-0000-0000-000000000004'),
  'GC-123', 'the optional GCash reference is retained');
select lives_ok($$
  select void_pos_sale('aaaaaaaa-0000-0000-0000-000000000004', 'kyle@verre.ph')
$$, 'a fresh POS sale can be undone');
select is(
  (select status::text from orders where client_uuid = 'aaaaaaaa-0000-0000-0000-000000000004'),
  'cancelled', 'undo preserves the order as cancelled');
select is(
  (select stock_on_hand from products where slug = 'test-stickers'),
  7, 'undo restores stock through a return movement');

-- ─── §1.3 oversell ───────────────────────────────────────────
-- One unit on hand, two sold. The second is physically already gone, so the sale
-- stands and the shortfall is booked as a correction. Sequential here, but this
-- is the exact branch two concurrent callers hit: the FOR UPDATE lock serializes
-- them, and the loser lands on this path.
-- ponytail: a real two-session concurrency test needs a second connection —
-- pgTAP is single-session. Cover it with an integration test once the Worker
-- can call this endpoint (Phase 1).
select lives_ok($$
  select record_sale(
    'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'web',
    '[{"product_id":"11111111-1111-1111-1111-111111111111","qty":1}]'::jsonb,
    now(), 'gcash', null, null, '{"name":"Web"}'::jsonb, 'web')
$$, 'the last unit sells online');

select lives_ok($$
  select record_sale(
    'aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'pos',
    '[{"product_id":"11111111-1111-1111-1111-111111111111","qty":1}]'::jsonb,
    now(), 'cash', 50000, null, '{"name":"Market"}'::jsonb, 'kyle@verre.ph')
$$, 'the same unit sells at the market — the sale is NOT rejected');

select is(
  (select is_oversell from orders where client_uuid = 'aaaaaaaa-0000-0000-0000-000000000003'), true,
  'the second sale is flagged for Kyle');
select is(
  (select stock_on_hand from products where slug = 'test-one-off'), 0,
  'stock lands at 0, never below');
select is(
  (select count(*) from stock_movements
    where product_id = '11111111-1111-1111-1111-111111111111' and reason = 'oversell_correction'),
  1::bigint, 'a compensating movement is written');

-- ─── the ledger invariant ────────────────────────────────────
-- This is the one that makes "why does it say 3 when I count 2?" answerable.
select is(
  (select count(*) from products p
    where p.stock_on_hand <> coalesce(
      (select sum(m.delta) from stock_movements m where m.product_id = p.id), 0)),
  0::bigint,
  'sum(stock_movements.delta) equals stock_on_hand for every product');

-- ─── rejections ──────────────────────────────────────────────
select throws_ok($$
  select record_sale(null, 'pos', '[]'::jsonb, now(), 'cash', null, null, '{}'::jsonb, 'k')
$$, '22023', null, 'an empty item list is rejected');

select throws_ok($$
  select record_sale(null, 'pos', '[{"product_id":"99999999-9999-9999-9999-999999999999","qty":1}]'::jsonb,
    now(), 'cash', null, null, '{}'::jsonb, 'k')
$$, '23503', null, 'an unknown product id is rejected');

select throws_ok($$
  select record_sale(null, 'pos', '[{"product_id":"22222222-2222-2222-2222-222222222222","qty":0}]'::jsonb,
    now(), 'cash', null, null, '{}'::jsonb, 'k')
$$, '22023', null, 'qty 0 is rejected');

-- ─── adjust_stock ────────────────────────────────────────────
select is(
  adjust_stock('22222222-2222-2222-2222-222222222222', 5, 'made', 'cut a new sheet', 'kyle@verre.ph'),
  12, 'adjust_stock returns the new balance');

select throws_ok($$
  select adjust_stock('22222222-2222-2222-2222-222222222222', -100, 'damaged', null, 'kyle@verre.ph')
$$, '23514', null, 'a manual adjustment cannot drive stock negative');

select throws_ok($$
  select adjust_stock('22222222-2222-2222-2222-222222222222', 0, 'stocktake', null, 'kyle@verre.ph')
$$, '22023', null, 'a zero adjustment is rejected');

select is(
  (select count(*) from products p
    where p.stock_on_hand <> coalesce(
      (select sum(m.delta) from stock_movements m where m.product_id = p.id), 0)),
  0::bigint,
  'the ledger still balances after adjustments');

-- ─── RLS is on everywhere ────────────────────────────────────
select is(
  (select count(*) from pg_tables
    where schemaname = 'public' and rowsecurity = false),
  0::bigint, 'every public table has row level security enabled');
select is((select count(*) from pg_policies where schemaname = 'public'), 0::bigint,
  'no permissive policies exist — the Worker service role is the only way in');

select * from finish();
rollback;
