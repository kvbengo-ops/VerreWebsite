-- Everything that touches stock lives here, inside a transaction, so the lock
-- and the write can't be separated by a flaky network.

-- ─── helpers ─────────────────────────────────────────────────

-- No I, O, 0 or 1 — these refs get read aloud over the phone.
-- Matches the format the Worker already generates for inquiries.
create function make_order_ref() returns text
language plpgsql as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_ref text;
begin
  loop
    v_ref := 'VR-' || (
      select string_agg(substr(v_alphabet, 1 + floor(random() * 32)::int, 1), '')
      from generate_series(1, 4)
    );
    exit when not exists (select 1 from orders where ref = v_ref);
  end loop;
  return v_ref;
end;
$$;

create function order_as_json(p_order_id uuid) returns jsonb
language sql stable as $$
  select to_jsonb(o) || jsonb_build_object(
    'items',
    coalesce(
      (select jsonb_agg(to_jsonb(i) order by i.id) from order_items i where i.order_id = o.id),
      '[]'::jsonb
    )
  )
  from orders o
  where o.id = p_order_id;
$$;

-- ─── record_sale ─────────────────────────────────────────────
-- Idempotent, oversell-tolerant. Called by POS sync and by web order
-- confirmation. Returns the full order as jsonb.
create function record_sale(
  p_client_uuid    uuid,
  p_channel        order_channel,
  p_items          jsonb,      -- [{ "product_id": "...", "qty": 2 }]
  p_sold_at        timestamptz,
  p_payment        payment_method,
  p_tendered_cents integer,
  p_session_id     uuid,
  p_customer       jsonb,
  p_actor          text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing uuid;
  v_order_id uuid;
  v_item     jsonb;
  v_product  products%rowtype;
  v_qty      integer;
  v_subtotal integer := 0;
  v_total    integer;
  v_oversell boolean := false;
  v_short    integer;
  v_reason   stock_reason;
begin
  -- 1. A replayed sale returns the ORIGINAL order, unchanged. No raise, no
  --    update. This is the whole reason the POS can retry blindly.
  if p_client_uuid is not null then
    select id into v_existing from orders where client_uuid = p_client_uuid;
    if v_existing is not null then
      return order_as_json(v_existing);
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'record_sale: items must be a non-empty array' using errcode = '22023';
  end if;

  -- 2. Lock every product up front, ordered by id. Consistent lock ordering is
  --    what stops a POS sync and a web sale deadlocking on two shared items.
  perform 1
  from products
  where id in (select (e ->> 'product_id')::uuid from jsonb_array_elements(p_items) e)
  order by id
  for update;

  v_reason := case p_channel when 'pos' then 'sale_pos' else 'sale_web' end;

  insert into orders (
    ref, client_uuid, channel, status, session_id,
    customer_name, customer_email, customer_phone, fulfillment, note, gcash_reference,
    subtotal_cents, discount_cents, total_cents,
    payment_method, tendered_cents, sold_at, synced_at
  ) values (
    make_order_ref(), p_client_uuid, p_channel, 'paid', p_session_id,
    p_customer ->> 'name', p_customer ->> 'email', p_customer ->> 'phone',
    coalesce(
      (p_customer ->> 'fulfillment')::fulfillment_method,
      case p_channel when 'pos' then 'in_person'::fulfillment_method end
    ),
    concat_ws(' · ', nullif(p_customer ->> 'note', ''), nullif(p_customer ->> 'discount_reason', '')),
    nullif(p_customer ->> 'gcash_reference', ''),
    0, 0, 0,                                    -- real figures land in the update below
    coalesce(p_payment, 'unpaid'), p_tendered_cents,
    coalesce(p_sold_at, now()), now()
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'qty')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'record_sale: qty must be a positive integer' using errcode = '22023';
    end if;

    -- Re-read inside the loop: a repeated product_id must see its own decrement.
    select * into v_product from products where id = (v_item ->> 'product_id')::uuid;
    if not found then
      raise exception 'record_sale: unknown product %', v_item ->> 'product_id' using errcode = '23503';
    end if;

    -- §1.4 — snapshot name and price. Never joined live.
    insert into order_items (order_id, product_id, product_name, unit_price_cents, qty, line_total_cents)
    values (v_order_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_product.price_cents * v_qty);
    v_subtotal := v_subtotal + v_product.price_cents * v_qty;

    insert into stock_movements (product_id, delta, reason, order_id, created_by)
    values (v_product.id, -v_qty, v_reason, v_order_id, p_actor);

    -- §1.3 — the piece is already in a customer's hands. Clamp stock at zero and
    -- book the shortfall as a correction so sum(delta) still equals stock_on_hand.
    -- NEVER abort the sale.
    v_short := greatest(v_qty - v_product.stock_on_hand, 0);
    if v_short > 0 then
      v_oversell := true;
      insert into stock_movements (product_id, delta, reason, order_id, created_by, note)
      values (
        v_product.id, v_short, 'oversell_correction', v_order_id, p_actor,
        'Sold ' || v_qty || ' with ' || v_product.stock_on_hand || ' on hand'
      );
    end if;

    update products
    set stock_on_hand = greatest(stock_on_hand - v_qty, 0)
    where id = v_product.id;
  end loop;

  -- Discount data rides inside p_customer so the RPC signature stays stable for
  -- already queued offline sales. The server remains the authority for totals.
  v_total := greatest(
    v_subtotal - least(
      v_subtotal,
      greatest(coalesce((p_customer ->> 'discount_cents')::integer, 0), 0)
    ),
    0
  );

  update orders
  set subtotal_cents = v_subtotal,
      discount_cents = v_subtotal - v_total,
      total_cents    = v_total,
      change_cents   = case
                         when p_payment = 'cash' and p_tendered_cents is not null
                         then greatest(p_tendered_cents - v_total, 0)
                       end,
      is_oversell    = v_oversell
  where id = v_order_id;

  return order_as_json(v_order_id);
end;
$$;

-- ─── adjust_stock ────────────────────────────────────────────
-- Movement + cached total, one transaction. Returns the new stock_on_hand.
-- Unlike a sale, a manual adjustment that would go negative is a mistake, not a
-- fact on the ground — so this one refuses.
create function adjust_stock(
  p_product_id uuid,
  p_delta      integer,
  p_reason     stock_reason,
  p_note       text,
  p_actor      text
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stock integer;
begin
  if p_delta = 0 then
    raise exception 'adjust_stock: delta must not be zero' using errcode = '22023';
  end if;

  select stock_on_hand into v_stock from products where id = p_product_id for update;
  if not found then
    raise exception 'adjust_stock: unknown product %', p_product_id using errcode = '23503';
  end if;
  if v_stock + p_delta < 0 then
    raise exception 'adjust_stock: % would take stock below zero (% on hand)', p_delta, v_stock
      using errcode = '23514';
  end if;

  insert into stock_movements (product_id, delta, reason, note, created_by)
  values (p_product_id, p_delta, p_reason, p_note, p_actor);

  update products set stock_on_hand = v_stock + p_delta where id = p_product_id
  returning stock_on_hand into v_stock;

  return v_stock;
end;
$$;

-- security definer + a public execute grant would hand anon a way around RLS.
revoke all on function record_sale(uuid, order_channel, jsonb, timestamptz, payment_method, integer, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function adjust_stock(uuid, integer, stock_reason, text, text) from public, anon, authenticated;
