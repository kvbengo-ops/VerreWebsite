-- Dashboard aggregation stays in Postgres. The Worker fetches one compact JSON
-- snapshot instead of pulling orders and rebuilding business metrics in JS.
create function dashboard_snapshot(
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
