-- Admin/order operations added after the immutable foundation migrations.

alter table orders
  add column inquiry_type text check (inquiry_type in ('order', 'custom', 'contact')),
  add column gcash_reference text,
  add column cancelled_at timestamptz,
  add column cancelled_by text,
  add column cancellation_note text;

alter table products
  add column was_ever_active boolean not null default false;

update products set was_ever_active = true where status = 'active';

create function remember_active_product() returns trigger
language plpgsql as $$
begin
  if new.status = 'active' then new.was_ever_active := true; end if;
  if tg_op = 'UPDATE' then
    if old.was_ever_active and new.slug <> old.slug then
      raise exception 'public product slugs are immutable' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger products_remember_active before insert or update on products
  for each row execute function remember_active_product();

create function create_inquiry(
  p_ref text,
  p_type text,
  p_items jsonb,
  p_customer jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_product products%rowtype;
  v_qty integer;
  v_subtotal integer := 0;
begin
  if p_type not in ('order', 'custom', 'contact') then
    raise exception 'invalid inquiry type' using errcode = '22023';
  end if;
  if p_type = 'order' and (
    p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0
  ) then
    raise exception 'order items are required' using errcode = '22023';
  end if;

  insert into orders (
    ref, channel, status, inquiry_type, customer_name, customer_email,
    customer_phone, fulfillment, note, subtotal_cents, total_cents
  ) values (
    p_ref, 'web', 'inquiry', p_type, p_customer ->> 'name',
    p_customer ->> 'email', p_customer ->> 'phone',
    nullif(p_customer ->> 'fulfillment', '')::fulfillment_method,
    p_customer ->> 'message', 0, 0
  ) returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := (v_item ->> 'qty')::integer;
    if v_qty is null or v_qty < 1 or v_qty > 20 then
      raise exception 'qty must be 1..20' using errcode = '22023';
    end if;
    select * into v_product from products where slug = v_item ->> 'id';
    if not found then
      raise exception 'unknown product %', v_item ->> 'id' using errcode = '23503';
    end if;
    insert into order_items (
      order_id, product_id, product_name, unit_price_cents, qty, line_total_cents
    ) values (
      v_order_id, v_product.id, v_product.name, v_product.price_cents,
      v_qty, v_product.price_cents * v_qty
    );
    v_subtotal := v_subtotal + v_product.price_cents * v_qty;
  end loop;

  update orders set subtotal_cents = v_subtotal, total_cents = v_subtotal
  where id = v_order_id;
  return order_as_json(v_order_id);
end;
$$;

create function set_order_status(
  p_order_id uuid,
  p_status order_status,
  p_payment payment_method,
  p_actor text,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_item order_items%rowtype;
  v_product products%rowtype;
  v_short integer;
  v_oversell boolean := false;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'unknown order' using errcode = '23503'; end if;
  if p_status <> v_order.status and p_status <> 'cancelled' and not (
    (v_order.status = 'inquiry' and p_status = 'quoted') or
    (v_order.status = 'quoted' and p_status = 'paid') or
    (v_order.status = 'paid' and p_status = 'fulfilled')
  ) then
    raise exception 'invalid status transition: % to %', v_order.status, p_status
      using errcode = '22023';
  end if;

  if p_status = 'paid' and v_order.status not in ('paid', 'fulfilled') then
    for v_item in select * from order_items where order_id = p_order_id order by product_id loop
      select * into v_product from products where id = v_item.product_id for update;
      if not found then raise exception 'order product is unavailable' using errcode = '23503'; end if;
      insert into stock_movements(product_id, delta, reason, order_id, note, created_by)
      values(v_product.id, -v_item.qty, 'sale_web', p_order_id, 'Web order marked paid', p_actor);
      v_short := greatest(v_item.qty - v_product.stock_on_hand, 0);
      if v_short > 0 then
        v_oversell := true;
        insert into stock_movements(product_id, delta, reason, order_id, note, created_by)
        values(v_product.id, v_short, 'oversell_correction', p_order_id, 'Web order oversell', p_actor);
      end if;
      update products set stock_on_hand = greatest(stock_on_hand - v_item.qty, 0)
      where id = v_product.id;
    end loop;
  elsif p_status = 'cancelled' and v_order.status in ('paid', 'fulfilled') then
    for v_item in select * from order_items where order_id = p_order_id loop
      perform adjust_stock(v_item.product_id, v_item.qty, 'return', 'Cancelled ' || v_order.ref, p_actor);
      update stock_movements set order_id = p_order_id
      where id = (
        select id from stock_movements
        where product_id = v_item.product_id and reason = 'return' and order_id is null
        order by created_at desc limit 1
      );
    end loop;
  end if;

  update orders
  set status = p_status,
      payment_method = coalesce(p_payment, payment_method),
      is_oversell = is_oversell or v_oversell,
      cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
      cancellation_note = case when p_status = 'cancelled' then p_note else cancellation_note end
  where id = p_order_id;

  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values(p_actor, 'order.status', 'order', p_order_id, jsonb_build_object('from', v_order.status, 'to', p_status));
  return order_as_json(p_order_id);
end;
$$;

create view ledger_drift as
select p.id, p.name, p.stock_on_hand,
       coalesce(sum(m.delta), 0)::integer as ledger_total
from products p left join stock_movements m on m.product_id = p.id
group by p.id having p.stock_on_hand <> coalesce(sum(m.delta), 0);

create view daily_sales_manila as
select (sold_at at time zone 'Asia/Manila')::date as business_date,
       channel, payment_method, count(*)::integer as order_count,
       sum(total_cents)::bigint as revenue_cents,
       sum((select coalesce(sum(qty), 0) from order_items i where i.order_id = o.id))::bigint as units
from orders o
where status in ('paid', 'fulfilled')
group by 1, 2, 3;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function make_order_ref() to service_role;
grant execute on function order_as_json(uuid) to service_role;
grant execute on function record_sale(uuid, order_channel, jsonb, timestamptz, payment_method, integer, uuid, jsonb, text) to service_role;
grant execute on function adjust_stock(uuid, integer, stock_reason, text, text) to service_role;
grant execute on function create_inquiry(text, text, jsonb, jsonb) to service_role;
grant execute on function set_order_status(uuid, order_status, payment_method, text, text) to service_role;

revoke all on function create_inquiry(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function set_order_status(uuid, order_status, payment_method, text, text) from public, anon, authenticated;

-- A busy-stall mis-tap can be undone for 60 seconds. Reversing a sale is a
-- ledger operation: it never deletes the order or its original movements.
create function void_pos_sale(
  p_client_uuid uuid,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_item order_items%rowtype;
begin
  select * into v_order
  from orders
  where client_uuid = p_client_uuid and channel = 'pos'
  for update;

  if not found then
    raise exception 'void_pos_sale: sale not found' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    return order_as_json(v_order.id);
  end if;
  if now() > v_order.sold_at + interval '60 seconds' then
    raise exception 'void_pos_sale: undo window has closed' using errcode = '22023';
  end if;

  for v_item in
    select * from order_items where order_id = v_order.id order by product_id
  loop
    perform 1 from products where id = v_item.product_id for update;
    insert into stock_movements(product_id, delta, reason, order_id, note, created_by)
    values (v_item.product_id, v_item.qty, 'return', v_order.id, 'POS undo', p_actor);
    update products
    set stock_on_hand = stock_on_hand + v_item.qty
    where id = v_item.product_id;
  end loop;

  update orders
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = p_actor,
      cancellation_note = 'POS undo',
      updated_at = now()
  where id = v_order.id;

  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values (p_actor, 'sale.undo', 'order', v_order.id, jsonb_build_object('client_uuid', p_client_uuid));

  return order_as_json(v_order.id);
end;
$$;

grant execute on function void_pos_sale(uuid, text) to service_role;
revoke all on function void_pos_sale(uuid, text) from public, anon, authenticated;
