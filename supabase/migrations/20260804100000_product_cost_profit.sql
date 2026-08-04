-- Product cost is private operational data. Snapshot it on each sold line so
-- editing a product later cannot rewrite historical profit.
alter table products
  add column cost_cents integer check (cost_cents >= 0);

alter table order_items
  add column unit_cost_cents integer check (unit_cost_cents >= 0),
  add column cost_total_cents integer check (cost_total_cents >= 0);

create function snapshot_order_item_cost()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.product_id is null then
    new.unit_cost_cents := null;
    new.cost_total_cents := null;
    return new;
  end if;

  if tg_op = 'INSERT' then
    select p.cost_cents into new.unit_cost_cents
    from products p where p.id = new.product_id;
  elsif new.product_id is distinct from old.product_id then
    select p.cost_cents into new.unit_cost_cents
    from products p where p.id = new.product_id;
  end if;

  new.cost_total_cents := case
    when new.unit_cost_cents is null then null
    else new.unit_cost_cents * new.qty
  end;
  return new;
end;
$$;

create trigger order_items_snapshot_cost
before insert or update of product_id, qty, unit_cost_cents on order_items
for each row execute function snapshot_order_item_cost();

-- A web inquiry is not a sale yet. Refresh its cost once when payment is
-- recorded. POS orders are inserted as paid, so their lines are covered by the
-- order_items insert trigger above.
create function refresh_paid_order_cost()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('paid', 'fulfilled')
     and old.status not in ('paid', 'fulfilled') then
    update order_items i
    set unit_cost_cents = p.cost_cents
    from products p
    where i.order_id = new.id and p.id = i.product_id;
  end if;
  return new;
end;
$$;

create trigger orders_refresh_paid_cost
after update of status on orders
for each row execute function refresh_paid_order_cost();

-- Existing paid lines deliberately remain NULL. Today's product cost is not a
-- reliable historical cost, so the dashboard reports incomplete coverage
-- instead of inventing profit for old sales.
create or replace function dashboard_snapshot(
  p_from timestamptz default now() - interval '30 days'
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with paid as (
    select o.*,
      coalesce((select sum(i.qty) from order_items i where i.order_id = o.id), 0)::integer as units
    from orders o
    where o.status in ('paid', 'fulfilled') and o.sold_at >= p_from
  ),
  product_totals as (
    select i.product_name as name,
      sum(i.qty)::integer as units,
      sum(i.line_total_cents)::bigint as revenue_cents
    from order_items i join paid o on o.id = i.order_id
    group by i.product_name
  ),
  cost_totals as (
    select
      coalesce(sum(i.cost_total_cents), 0)::bigint as product_cost_cents,
      coalesce(sum(i.qty) filter (where i.unit_cost_cents is null), 0)::integer as uncosted_units
    from order_items i join paid o on o.id = i.order_id
  ),
  coverage as (
    select count(*)::integer as uncosted_orders
    from paid o
    where not exists (select 1 from order_items i where i.order_id = o.id)
       or exists (
         select 1 from order_items i
         where i.order_id = o.id and i.unit_cost_cents is null
       )
  ),
  daily as (
    select (sold_at at time zone 'Asia/Manila')::date as date,
      sum(total_cents)::bigint as revenue_cents
    from paid group by 1 order by 1
  ),
  category_totals as (
    select coalesce(p.category::text, 'deleted') as category,
      sum(i.qty)::integer as units,
      sum(i.line_total_cents)::bigint as revenue_cents
    from order_items i
    join paid o on o.id = i.order_id
    left join products p on p.id = i.product_id
    group by 1
  )
  select jsonb_build_object(
    'revenue_cents', coalesce((select sum(total_cents) from paid), 0),
    'product_cost_cents', (select product_cost_cents from cost_totals),
    'gross_profit_cents', case
      when (select uncosted_orders from coverage) = 0
      then coalesce((select sum(total_cents) from paid), 0) - (select product_cost_cents from cost_totals)
      else null
    end,
    'gross_margin_percent', case
      when (select uncosted_orders from coverage) = 0
       and coalesce((select sum(total_cents) from paid), 0) > 0
      then round(
        ((coalesce((select sum(total_cents) from paid), 0) - (select product_cost_cents from cost_totals))::numeric
          / (select sum(total_cents) from paid)) * 100,
        1
      )
      else null
    end,
    'uncosted_units', (select uncosted_units from cost_totals),
    'uncosted_orders', (select uncosted_orders from coverage),
    'order_count', (select count(*) from paid),
    'average_order_cents', coalesce((select round(avg(total_cents)) from paid), 0),
    'units', coalesce((select sum(units) from paid), 0),
    'channel', coalesce((
      select jsonb_object_agg(channel, revenue)
      from (select channel::text channel, sum(total_cents) revenue from paid group by channel) x
    ), '{}'::jsonb),
    'payment', coalesce((
      select jsonb_object_agg(payment_method, revenue)
      from (select payment_method::text payment_method, sum(total_cents) revenue from paid group by payment_method) x
    ), '{}'::jsonb),
    'category', coalesce((select jsonb_agg(to_jsonb(c) order by revenue_cents desc) from category_totals c), '[]'::jsonb),
    'top_products', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.revenue_cents desc)
      from (select * from product_totals order by revenue_cents desc limit 5) t
    ), '[]'::jsonb),
    'top_products_by_units', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.units desc)
      from (select * from product_totals order by units desc limit 5) t
    ), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(to_jsonb(d) order by d.date) from daily d), '[]'::jsonb),
    'attention', jsonb_build_object(
      'unanswered', coalesce((
        select jsonb_agg(to_jsonb(o) order by o.created_at)
        from orders o where o.status = 'inquiry' and o.created_at < now() - interval '48 hours'
      ), '[]'::jsonb),
      'oversells', coalesce((
        select jsonb_agg(to_jsonb(o) order by o.created_at desc)
        from orders o where o.is_oversell and o.status <> 'cancelled'
      ), '[]'::jsonb),
      'out_of_stock', coalesce((
        select jsonb_agg(to_jsonb(p) order by p.name)
        from products p where p.status = 'active' and p.stock_on_hand = 0
      ), '[]'::jsonb),
      'low_stock', coalesce((
        select jsonb_agg(to_jsonb(p) order by p.stock_on_hand, p.name)
        from products p
        where p.status = 'active' and p.stock_on_hand > 0 and p.stock_on_hand <= p.low_stock_at
      ), '[]'::jsonb),
      'open_sessions', coalesce((
        select jsonb_agg(to_jsonb(s) order by s.opened_at)
        from pos_sessions s where s.closed_at is null and s.opened_at < now() - interval '24 hours'
      ), '[]'::jsonb),
      'ledger_drift', coalesce((select jsonb_agg(to_jsonb(d)) from ledger_drift d), '[]'::jsonb)
    )
  );
$$;

grant execute on function dashboard_snapshot(timestamptz) to service_role;
revoke all on function dashboard_snapshot(timestamptz) from public, anon, authenticated;
