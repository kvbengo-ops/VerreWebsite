-- One private business snapshot powers the analytics dashboard. Keep monetary
-- and cost calculations in Postgres so every admin sees the same answer.
-- Web orders begin as inquiries. Their original sold_at default is submission
-- time, so stamp the real sale time once, when payment is recorded. POS orders
-- are inserted as paid with the device's sale time and never hit this trigger.
create function stamp_web_order_sale_time()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('paid', 'in_production', 'fulfilled')
     and old.status not in ('paid', 'in_production', 'fulfilled') then
    new.sold_at := now();
  end if;
  return new;
end;
$$;

create trigger orders_stamp_web_sale_time
before update of status on orders
for each row execute function stamp_web_order_sale_time();

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
    where o.status in ('paid', 'in_production', 'fulfilled')
      and o.sold_at >= coalesce(p_from, now() - interval '30 days')
  ),
  paid_items as (
    select i.*,
      o.channel,
      o.payment_method,
      case
        when o.subtotal_cents > 0
        then round(i.line_total_cents::numeric * o.total_cents / o.subtotal_cents)::bigint
        else 0::bigint
      end as net_revenue_cents
    from order_items i
    join paid o on o.id = i.order_id
  ),
  product_totals as (
    select i.product_name as name,
      sum(i.qty)::integer as units,
      sum(i.net_revenue_cents)::bigint as revenue_cents,
      coalesce(sum(i.cost_total_cents), 0)::bigint as product_cost_cents,
      case when count(*) filter (where i.unit_cost_cents is null) = 0
        then sum(i.net_revenue_cents)::bigint - coalesce(sum(i.cost_total_cents), 0)::bigint
        else null
      end as gross_profit_cents
    from paid_items i
    group by i.product_name
  ),
  cost_totals as (
    select
      coalesce(sum(i.cost_total_cents), 0)::bigint as product_cost_cents,
      coalesce(sum(i.qty) filter (where i.unit_cost_cents is null), 0)::integer as uncosted_units
    from paid_items i
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
      count(*)::integer as order_count,
      sum(total_cents)::bigint as revenue_cents
    from paid group by 1 order by 1
  ),
  category_totals as (
    select coalesce(p.category::text, 'deleted') as category,
      sum(i.qty)::integer as units,
      sum(i.net_revenue_cents)::bigint as revenue_cents
    from paid_items i
    left join products p on p.id = i.product_id
    group by 1
  ),
  channel_totals as (
    select channel::text as channel,
      count(*)::integer as order_count,
      sum(total_cents)::bigint as revenue_cents
    from paid group by channel
  ),
  payment_totals as (
    select payment_method::text as payment_method,
      count(*)::integer as order_count,
      sum(total_cents)::bigint as revenue_cents
    from paid group by payment_method
  ),
  period_orders as (
    select * from orders
    where created_at >= coalesce(p_from, now() - interval '30 days')
  ),
  pipeline as (
    select status::text as status, count(*)::integer as order_count
    from period_orders group by status
  ),
  web_cohort as (
    select
      count(*) filter (where channel = 'web')::integer as web_orders,
      count(*) filter (
        where channel = 'web' and status in ('paid', 'in_production', 'fulfilled')
      )::integer as converted_web_orders
    from period_orders
  ),
  current_inventory as (
    select * from products where status <> 'archived'
  ),
  inventory_totals as (
    select
      count(*)::integer as current_products,
      count(*) filter (where status = 'active')::integer as active_products,
      count(*) filter (where status = 'draft')::integer as draft_products,
      (select count(*)::integer from products where status = 'archived') as archived_products,
      coalesce(sum(stock_on_hand), 0)::integer as units_on_hand,
      coalesce(sum(price_cents::bigint * stock_on_hand), 0)::bigint as retail_value_cents,
      case when count(*) filter (where stock_on_hand > 0 and cost_cents is null) = 0
        then coalesce(sum(cost_cents::bigint * stock_on_hand), 0)::bigint
        else null
      end as cost_value_cents,
      case when count(*) filter (where stock_on_hand > 0 and cost_cents is null) = 0
        then coalesce(sum((price_cents - cost_cents)::bigint * stock_on_hand), 0)::bigint
        else null
      end as potential_profit_cents,
      count(*) filter (where cost_cents is null)::integer as missing_cost_products,
      coalesce(sum(stock_on_hand) filter (where cost_cents is null), 0)::integer as missing_cost_units,
      count(*) filter (where status = 'active' and stock_on_hand = 0)::integer as out_of_stock_products,
      count(*) filter (
        where status = 'active' and stock_on_hand > 0 and stock_on_hand <= low_stock_at
      )::integer as low_stock_products
    from current_inventory
  ),
  inventory_categories as (
    select category::text as category,
      count(*)::integer as products,
      sum(stock_on_hand)::integer as units_on_hand,
      sum(price_cents::bigint * stock_on_hand)::bigint as retail_value_cents
    from current_inventory group by category
  ),
  movement_totals as (
    select reason::text as reason,
      count(*)::integer as movement_count,
      sum(delta)::integer as net_units,
      sum(abs(delta))::integer as units_affected
    from stock_movements
    where created_at >= coalesce(p_from, now() - interval '30 days')
    group by reason
  )
  select jsonb_build_object(
    'range_from', coalesce(p_from, now() - interval '30 days'),
    'range_to', now(),
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
    'discount_cents', coalesce((select sum(discount_cents) from paid), 0),
    'discount_order_count', (select count(*) from paid where discount_cents > 0),
    'discount_rate_percent', case
      when coalesce((select sum(subtotal_cents) from paid), 0) > 0
      then round((select sum(discount_cents)::numeric / sum(subtotal_cents) * 100 from paid), 1)
      else 0
    end,
    'uncosted_units', (select uncosted_units from cost_totals),
    'uncosted_orders', (select uncosted_orders from coverage),
    'order_count', (select count(*) from paid),
    'average_order_cents', coalesce((select round(avg(total_cents)) from paid), 0),
    'units', coalesce((select sum(units) from paid), 0),
    'web_conversion_percent', case
      when (select web_orders from web_cohort) > 0
      then round((select converted_web_orders::numeric / web_orders * 100 from web_cohort), 1)
      else null
    end,
    'web_orders', (select web_orders from web_cohort),
    'converted_web_orders', (select converted_web_orders from web_cohort),
    'channel', coalesce((
      select jsonb_object_agg(channel, revenue_cents) from channel_totals
    ), '{}'::jsonb),
    'payment', coalesce((
      select jsonb_object_agg(payment_method, revenue_cents) from payment_totals
    ), '{}'::jsonb),
    'channel_breakdown', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.revenue_cents desc) from channel_totals c
    ), '[]'::jsonb),
    'payment_breakdown', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.revenue_cents desc) from payment_totals p
    ), '[]'::jsonb),
    'category', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.revenue_cents desc) from category_totals c
    ), '[]'::jsonb),
    'order_pipeline', coalesce((
      select jsonb_object_agg(status, order_count) from pipeline
    ), '{}'::jsonb),
    'top_products', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.revenue_cents desc)
      from (select * from product_totals order by revenue_cents desc limit 5) t
    ), '[]'::jsonb),
    'top_products_by_units', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.units desc)
      from (select * from product_totals order by units desc limit 5) t
    ), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(to_jsonb(d) order by d.date) from daily d), '[]'::jsonb),
    'inventory', (select to_jsonb(i) || jsonb_build_object(
      'by_category', coalesce((
        select jsonb_agg(to_jsonb(c) order by c.retail_value_cents desc)
        from inventory_categories c
      ), '[]'::jsonb),
      'top_stock', coalesce((
        select jsonb_agg(to_jsonb(p) order by p.retail_value_cents desc, p.name)
        from (
          select id, name, category::text as category, status::text as status,
            stock_on_hand, low_stock_at, price_cents, cost_cents,
            price_cents::bigint * stock_on_hand as retail_value_cents,
            case when cost_cents is null then null
                 else cost_cents::bigint * stock_on_hand end as cost_value_cents
          from current_inventory
          order by price_cents::bigint * stock_on_hand desc, name
          limit 8
        ) p
      ), '[]'::jsonb)
    ) from inventory_totals i),
    'stock_movements', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.units_affected desc, m.reason)
      from movement_totals m
    ), '[]'::jsonb),
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
      'missing_cost', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'stock_on_hand', p.stock_on_hand)
                         order by p.name)
        from products p where p.status <> 'archived' and p.cost_cents is null
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
