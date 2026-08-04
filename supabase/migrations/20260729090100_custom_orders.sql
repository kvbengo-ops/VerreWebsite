-- ═══════════════════════════════════════════════════════════════════
-- Custom commissions: a guided spec builder, not a checkout.
--
-- A catalog order and a commission are different animals. A catalog order
-- picks existing rows out of `products` and the price is already known. A
-- commission does not exist yet — the customer describes it, Kyle decides
-- whether he can make it and what it costs, and only then is there a number
-- anyone can pay.
--
-- So this schema stores three separate things and never confuses them:
--
--   estimate_cents  what the wizard showed the customer, from option deltas
--   quoted_cents    what Kyle actually charges after reading the brief
--   total_cents     stays 0 until quoted, because an estimate is not revenue
--                   and must never reach the dashboard as if it were
--
-- Options live in the database so Kyle can add a size or a finish without a
-- deploy. Selections snapshot their labels and prices onto the order, exactly
-- like order_items does — raising the price of "large" next month must not
-- rewrite a quote sent last month.
-- ═══════════════════════════════════════════════════════════════════

-- ─── WIZARD STEPS ────────────────────────────────────────────
-- One row per step. `step` orders them; `key` is what the Worker and the
-- browser refer to, and is immutable in practice because selections snapshot
-- it. Deactivate a group rather than deleting it — deleting cascades away the
-- option rows that historic selections point at.
create table custom_option_groups (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null check (key ~ '^[a-z][a-z0-9_]*$'),
  label       text not null,
  helper      text,                                  -- one line under the heading
  step        integer not null check (step > 0),
  input_kind  text not null default 'single'
                check (input_kind in ('single', 'multi', 'text')),
  required    boolean not null default true,
  min_choices integer not null default 1 check (min_choices >= 0),
  max_choices integer not null default 1 check (max_choices >= 1),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on custom_option_groups (step) where is_active;

-- ─── CHOICES ─────────────────────────────────────────────────
-- price_delta_cents is signed: a "no stand" choice may legitimately subtract.
--
-- parent_option_id is how a step narrows based on an earlier answer — the
-- sizes offered for a glass panel are not the sizes offered for a charm. Null
-- means "always shown". One level only; a dependency tree here would be a
-- rules engine, and Kyle would still have to explain it to himself in six
-- months.
create table custom_options (
  id                uuid primary key default gen_random_uuid(),
  group_id          uuid not null references custom_option_groups(id) on delete cascade,
  parent_option_id  uuid references custom_options(id) on delete cascade,
  key               text not null check (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  label             text not null,
  description       text,
  price_delta_cents integer not null default 0,
  lead_time_days    integer check (lead_time_days is null or lead_time_days >= 0),
  swatch            text,                            -- card tint, e.g. '#FFB6D9'
  is_active         boolean not null default true,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (group_id, key)
);
create index on custom_options (group_id, sort_order) where is_active;
create index on custom_options (parent_option_id);

-- A child option belonging to the same group as its parent would make a step
-- depend on itself and the wizard would never render it.
create function custom_option_parent_differs() returns trigger
language plpgsql as $$
declare v_parent_group uuid;
begin
  if new.parent_option_id is null then return new; end if;
  select group_id into v_parent_group from custom_options where id = new.parent_option_id;
  if v_parent_group = new.group_id then
    raise exception 'an option cannot depend on another option in its own group'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger custom_options_parent_check before insert or update on custom_options
  for each row execute function custom_option_parent_differs();

-- ─── WHAT THE CUSTOMER PICKED ────────────────────────────────
-- Every text column here is a SNAPSHOT. option_id is kept for reporting
-- ("how many people chose A5?") and is allowed to go null; the labels are what
-- the quote, the email and the tracking page actually read from.
create table custom_order_selections (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id) on delete cascade,
  step              integer not null,
  group_key         text not null,
  group_label       text not null,
  option_id         uuid references custom_options(id) on delete set null,
  option_key        text,
  option_label      text,
  price_delta_cents integer not null default 0,
  text_value        text,
  position          integer not null default 0
);
create index on custom_order_selections (order_id, step, position);

-- ─── REFERENCE PHOTOS ────────────────────────────────────────
-- For a pet portrait the photo *is* the brief. Private bucket, signed URLs
-- only — these are strangers' pets, weddings and dead relatives.
create table custom_order_images (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  storage_path text not null,                        -- custom/{order_id}/{uuid}.webp
  position     integer not null default 0,
  created_at   timestamptz not null default now()
);
create index on custom_order_images (order_id, position);

insert into storage.buckets (id, name, public)
values ('custom-references', 'custom-references', false)
on conflict (id) do nothing;

-- ─── ORDER COLUMNS ───────────────────────────────────────────
alter table orders
  add column estimate_cents      integer check (estimate_cents is null or estimate_cents >= 0),
  add column quoted_cents        integer check (quoted_cents is null or quoted_cents >= 0),
  add column deposit_cents       integer check (deposit_cents is null or deposit_cents >= 0),
  add column quote_note          text,
  add column quoted_at           timestamptz,
  add column production_started_at timestamptz,
  add column shipped_at          timestamptz,
  add column ship_carrier        text,
  add column ship_tracking       text,
  add column ship_line1          text,
  add column ship_line2          text,
  add column ship_city           text,
  add column ship_province       text,
  add column ship_postcode       text,
  -- The tracking page is public, so `ref` alone cannot guard it: four
  -- characters of a 32-symbol alphabet is about a million combinations, which
  -- is a weekend of guessing for a stranger's shipping status. The emailed link
  -- carries this token; without it the page is a 404.
  add column track_token         text unique;

create index on orders (inquiry_type, status) where inquiry_type = 'custom';

-- ─── STATUS PIPELINE ─────────────────────────────────────────
-- Replaces the version in 20260726120200. Two changes: commissions may pass
-- through awaiting_payment and in_production, and reaching 'paid' now stamps
-- the money columns. Catalog orders keep their original inquiry → quoted →
-- paid → fulfilled path untouched.
create or replace function set_order_status(
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
    (v_order.status = 'inquiry'          and p_status = 'quoted') or
    (v_order.status = 'quoted'           and p_status in ('awaiting_payment', 'paid')) or
    (v_order.status = 'awaiting_payment' and p_status = 'paid') or
    (v_order.status = 'paid'             and p_status in ('in_production', 'fulfilled')) or
    (v_order.status = 'in_production'    and p_status = 'fulfilled')
  ) then
    raise exception 'invalid status transition: % to %', v_order.status, p_status
      using errcode = '22023';
  end if;

  -- A commission has no order_items, so this loop is a no-op for one. That is
  -- correct and deliberate: nothing came off the shelf, so nothing leaves the
  -- ledger. The piece is made to order and enters stock only if it is refused.
  if p_status = 'paid' and v_order.status not in ('paid', 'in_production', 'fulfilled') then
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
  elsif p_status = 'cancelled' and v_order.status in ('paid', 'in_production', 'fulfilled') then
    for v_item in select * from order_items where order_id = p_order_id order by product_id loop
      insert into stock_movements(product_id, delta, reason, order_id, note, created_by)
      values(v_item.product_id, v_item.qty, 'return', p_order_id, 'Web order cancelled', p_actor);
      update products set stock_on_hand = stock_on_hand + v_item.qty
      where id = v_item.product_id;
    end loop;
  end if;

  update orders set
    status               = p_status,
    payment_method       = coalesce(p_payment, payment_method),
    is_oversell          = orders.is_oversell or v_oversell,
    production_started_at = case when p_status = 'in_production' and production_started_at is null
                                 then now() else production_started_at end,
    shipped_at           = case when p_status = 'fulfilled' and shipped_at is null
                                then now() else shipped_at end,
    cancelled_at         = case when p_status = 'cancelled' then now() else cancelled_at end,
    cancelled_by         = case when p_status = 'cancelled' then p_actor else cancelled_by end,
    cancellation_note    = case when p_status = 'cancelled' then p_note else cancellation_note end
  where id = p_order_id;

  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values(p_actor, 'order.status', 'orders', p_order_id,
         jsonb_build_object('from', v_order.status, 'to', p_status, 'note', p_note));

  return order_as_json(p_order_id);
end;
$$;

-- ─── THE WIZARD'S CATALOG ────────────────────────────────────
-- One call returns every active step with its choices already nested, so the
-- browser makes a single request and cannot render step 3 before step 2 has
-- loaded. Prices are included because the wizard shows a running estimate —
-- and are re-read from these same rows on submit, so a tampered browser
-- changes the display and nothing else.
create function custom_wizard() returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $$
  -- Ordered by `sort_key`, a plain column of the subquery. Writing
  -- `order by payload.step` instead would parse `payload` as a table alias and
  -- fail at CREATE time — a SQL function body is validated when it is defined,
  -- unlike plpgsql.
  select coalesce(jsonb_agg(wizard_step.payload order by wizard_step.sort_key), '[]'::jsonb)
  from (
    select
      grp.step as sort_key,
      jsonb_build_object(
        'key', grp.key, 'label', grp.label, 'helper', grp.helper,
        'step', grp.step, 'input_kind', grp.input_kind, 'required', grp.required,
        'min_choices', grp.min_choices, 'max_choices', grp.max_choices,
        'options', coalesce((
          select jsonb_agg(jsonb_build_object(
            'key', o.key, 'label', o.label, 'description', o.description,
            'price_delta_cents', o.price_delta_cents, 'lead_time_days', o.lead_time_days,
            'swatch', o.swatch,
            'parent_key', parent.key,
            'parent_group_key', parent_group.key
          ) order by o.sort_order, o.label)
          from custom_options o
          left join custom_options parent on parent.id = o.parent_option_id
          left join custom_option_groups parent_group on parent_group.id = parent.group_id
          where o.group_id = grp.id and o.is_active
        ), '[]'::jsonb)
      ) as payload
    from custom_option_groups grp
    where grp.is_active
  ) wizard_step;
$$;

-- ─── SUBMIT ──────────────────────────────────────────────────
-- p_selections: [{ "group_key": "size", "option_key": "a5", "text_value": "…" }]
--
-- Everything is re-derived here. The browser sends keys; labels and prices come
-- out of the tables. Required groups are enforced, unknown or inactive options
-- are rejected outright rather than silently dropped — a commission missing a
-- step is worse than one that failed to submit, because nobody finds out until
-- Kyle is holding the glass.
create function create_custom_request(
  p_ref text,
  p_selections jsonb,
  p_customer jsonb
) returns jsonb
language plpgsql
security definer
-- `extensions` is on the path for gen_random_bytes: pgcrypto lives there, not
-- in public (see 20260726120500).
set search_path = public, extensions, pg_temp
as $$
declare
  v_order_id  uuid;
  v_token     text;
  v_sel       jsonb;
  v_group     custom_option_groups%rowtype;
  v_option    custom_options%rowtype;
  v_estimate  integer := 0;
  v_lead      integer := 0;
  v_seen      text[] := '{}';
  v_position  integer;
  v_text      text;
begin
  if p_selections is null or jsonb_typeof(p_selections) <> 'array'
     or jsonb_array_length(p_selections) = 0 then
    raise exception 'a custom request needs at least one selection' using errcode = '22023';
  end if;
  if jsonb_array_length(p_selections) > 40 then
    raise exception 'too many selections' using errcode = '22023';
  end if;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');

  insert into orders (
    ref, channel, status, inquiry_type, customer_name, customer_email,
    customer_phone, fulfillment, note, subtotal_cents, total_cents,
    ship_line1, ship_line2, ship_city, ship_province, ship_postcode, track_token
  ) values (
    p_ref, 'web', 'inquiry', 'custom',
    nullif(p_customer ->> 'name', ''),
    nullif(p_customer ->> 'email', ''),
    nullif(p_customer ->> 'phone', ''),
    nullif(p_customer ->> 'fulfillment', '')::fulfillment_method,
    nullif(p_customer ->> 'message', ''),
    -- An estimate is not revenue. These stay 0 until Kyle sends a real quote,
    -- so an unanswered commission can never inflate the dashboard.
    0, 0,
    nullif(p_customer ->> 'ship_line1', ''), nullif(p_customer ->> 'ship_line2', ''),
    nullif(p_customer ->> 'ship_city', ''), nullif(p_customer ->> 'ship_province', ''),
    nullif(p_customer ->> 'ship_postcode', ''), v_token
  ) returning id into v_order_id;

  v_position := 0;
  for v_sel in select * from jsonb_array_elements(p_selections) loop
    select * into v_group from custom_option_groups
      where key = v_sel ->> 'group_key' and is_active;
    if not found then
      raise exception 'unknown step %', v_sel ->> 'group_key' using errcode = '23503';
    end if;

    v_text := nullif(btrim(coalesce(v_sel ->> 'text_value', '')), '');
    if v_text is not null and length(v_text) > 2000 then
      raise exception 'that answer is too long' using errcode = '22023';
    end if;

    if v_group.input_kind = 'text' then
      if v_group.required and v_text is null then
        raise exception 'step % needs an answer', v_group.key using errcode = '22023';
      end if;
      insert into custom_order_selections (
        order_id, step, group_key, group_label, text_value, position
      ) values (
        v_order_id, v_group.step, v_group.key, v_group.label, v_text, v_position
      );
    else
      select * into v_option from custom_options
        where group_id = v_group.id and key = v_sel ->> 'option_key' and is_active;
      if not found then
        raise exception 'that choice is no longer available' using errcode = '23503';
      end if;
      insert into custom_order_selections (
        order_id, step, group_key, group_label, option_id, option_key,
        option_label, price_delta_cents, text_value, position
      ) values (
        v_order_id, v_group.step, v_group.key, v_group.label, v_option.id, v_option.key,
        v_option.label, v_option.price_delta_cents, v_text, v_position
      );
      v_estimate := v_estimate + v_option.price_delta_cents;
      v_lead := greatest(v_lead, coalesce(v_option.lead_time_days, 0));
    end if;

    v_seen := v_seen || v_group.key;
    v_position := v_position + 1;
  end loop;

  -- Enforced after the loop so the error names every missing step at once
  -- instead of one per resubmit.
  if exists (
    select 1 from custom_option_groups
    where is_active and required and not (key = any(v_seen))
  ) then
    raise exception 'missing required step(s): %', (
      select string_agg(label, ', ' order by step) from custom_option_groups
      where is_active and required and not (key = any(v_seen))
    ) using errcode = '22023';
  end if;

  update orders set estimate_cents = greatest(v_estimate, 0) where id = v_order_id;
  return custom_order_as_json(v_order_id);
end;
$$;

-- ─── QUOTE ───────────────────────────────────────────────────
-- Kyle reads the brief and sets a real price. This is the only path that writes
-- total_cents for a commission, which is why it also moves the status: a quoted
-- amount sitting on a row still marked 'inquiry' is the state that makes people
-- ask "did I already send this?".
create function set_custom_quote(
  p_order_id uuid,
  p_quoted_cents integer,
  p_deposit_cents integer,
  p_note text,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_order orders%rowtype;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'unknown order' using errcode = '23503'; end if;
  if v_order.inquiry_type is distinct from 'custom' then
    raise exception 'only a custom request can be quoted' using errcode = '22023';
  end if;
  if p_quoted_cents is null or p_quoted_cents < 0 then
    raise exception 'a quote needs an amount' using errcode = '22023';
  end if;
  if coalesce(p_deposit_cents, 0) > p_quoted_cents then
    raise exception 'the deposit cannot exceed the quote' using errcode = '22023';
  end if;
  if v_order.status not in ('inquiry', 'quoted') then
    raise exception 'this order has moved past quoting' using errcode = '22023';
  end if;

  update orders set
    quoted_cents   = p_quoted_cents,
    deposit_cents  = coalesce(p_deposit_cents, 0),
    quote_note     = p_note,
    quoted_at      = now(),
    subtotal_cents = p_quoted_cents,
    total_cents    = p_quoted_cents,
    status         = 'quoted'
  where id = p_order_id;

  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values(p_actor, 'order.quote', 'orders', p_order_id,
         jsonb_build_object('quoted_cents', p_quoted_cents,
                            'deposit_cents', coalesce(p_deposit_cents, 0)));

  return custom_order_as_json(p_order_id);
end;
$$;

create function set_custom_shipping(
  p_order_id uuid,
  p_carrier text,
  p_tracking text,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update orders set ship_carrier = nullif(btrim(coalesce(p_carrier, '')), ''),
                    ship_tracking = nullif(btrim(coalesce(p_tracking, '')), '')
  where id = p_order_id;
  if not found then raise exception 'unknown order' using errcode = '23503'; end if;
  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values(p_actor, 'order.shipping', 'orders', p_order_id,
         jsonb_build_object('carrier', p_carrier, 'tracking', p_tracking));
  return custom_order_as_json(p_order_id);
end;
$$;

-- ─── READ ────────────────────────────────────────────────────
create function custom_order_as_json(p_order_id uuid) returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(o) || jsonb_build_object(
    'selections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'step', s.step, 'group_key', s.group_key, 'group_label', s.group_label,
        'option_key', s.option_key, 'option_label', s.option_label,
        'price_delta_cents', s.price_delta_cents, 'text_value', s.text_value
      ) order by s.step, s.position)
      from custom_order_selections s where s.order_id = o.id
    ), '[]'::jsonb),
    'images', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'storage_path', i.storage_path)
             order by i.position)
      from custom_order_images i where i.order_id = o.id
    ), '[]'::jsonb)
  )
  from orders o where o.id = p_order_id;
$$;

-- The public tracking page. Deliberately not `custom_order_as_json` minus a few
-- columns — this builds up from nothing, so a column added to `orders` later
-- cannot leak by default. No email, no phone, no street address; a stranger
-- holding a guessed link learns only that someone ordered something.
create function public_order_track(p_ref text, p_token text) returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ref', o.ref,
    'status', o.status,
    'inquiry_type', o.inquiry_type,
    'first_name', split_part(coalesce(o.customer_name, ''), ' ', 1),
    'estimate_cents', o.estimate_cents,
    'quoted_cents', o.quoted_cents,
    'deposit_cents', o.deposit_cents,
    'quote_note', o.quote_note,
    'fulfillment', o.fulfillment,
    'ship_carrier', o.ship_carrier,
    'ship_tracking', o.ship_tracking,
    'ship_city', o.ship_city,
    'created_at', o.created_at,
    'quoted_at', o.quoted_at,
    'production_started_at', o.production_started_at,
    'shipped_at', o.shipped_at,
    'cancelled_at', o.cancelled_at,
    'selections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'group_label', s.group_label, 'option_label', s.option_label,
        'text_value', s.text_value
      ) order by s.step, s.position)
      from custom_order_selections s where s.order_id = o.id
    ), '[]'::jsonb)
  )
  from orders o
  where o.ref = p_ref
    and o.track_token is not null
    and o.track_token = p_token;
$$;

create function attach_custom_image(p_order_id uuid, p_path text, p_position integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  select count(*) into v_count from custom_order_images where order_id = p_order_id;
  if v_count >= 5 then
    raise exception 'that is enough reference photos' using errcode = '22023';
  end if;
  insert into custom_order_images (order_id, storage_path, position)
  values (p_order_id, p_path, coalesce(p_position, v_count));
  return jsonb_build_object('ok', true);
end;
$$;

-- ─── RLS ─────────────────────────────────────────────────────
-- Deny-all with no policies, same as every other table. The service role key
-- is the only way in.
alter table custom_option_groups    enable row level security;
alter table custom_options          enable row level security;
alter table custom_order_selections enable row level security;
alter table custom_order_images     enable row level security;

create trigger custom_option_groups_touch before update on custom_option_groups
  for each row execute function touch_updated_at();
create trigger custom_options_touch before update on custom_options
  for each row execute function touch_updated_at();

-- ─── GRANTS ──────────────────────────────────────────────────
revoke all on function custom_wizard() from public, anon, authenticated;
revoke all on function create_custom_request(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function set_custom_quote(uuid, integer, integer, text, text) from public, anon, authenticated;
revoke all on function set_custom_shipping(uuid, text, text, text) from public, anon, authenticated;
revoke all on function custom_order_as_json(uuid) from public, anon, authenticated;
revoke all on function public_order_track(text, text) from public, anon, authenticated;
revoke all on function attach_custom_image(uuid, text, integer) from public, anon, authenticated;

grant execute on function custom_wizard() to service_role;
grant execute on function create_custom_request(text, jsonb, jsonb) to service_role;
grant execute on function set_custom_quote(uuid, integer, integer, text, text) to service_role;
grant execute on function set_custom_shipping(uuid, text, text, text) to service_role;
grant execute on function custom_order_as_json(uuid) to service_role;
grant execute on function public_order_track(text, text) to service_role;
grant execute on function attach_custom_image(uuid, text, integer) to service_role;

-- ─── SEED: the four steps ────────────────────────────────────
-- Starting content, not fixed content. Everything below is editable in
-- /admin → Custom, which is the whole point of putting it in a table.
insert into custom_option_groups (key, label, helper, step, input_kind, required) values
  ('base', 'What should I make?', 'Every commission starts here.', 1, 'single', true),
  ('size', 'How big?', 'Rough sizes — I can work to an exact measurement, just say so in the last step.', 2, 'single', true),
  ('design', 'What look are you after?', 'This sets the palette and finish, not the subject.', 3, 'single', true),
  ('brief', 'Tell me about it', 'The more you tell me, the closer the first draft lands.', 4, 'text', true);

insert into custom_options (group_id, key, label, description, price_delta_cents, lead_time_days, swatch, sort_order)
select g.id, v.key, v.label, v.description, v.price, v.lead, v.swatch, v.sort
from custom_option_groups g, (values
  ('glass-panel', 'Hand-painted glass panel', 'A framed piece of painted glass. The classic.', 120000, 21, '#7ED3F2', 1),
  ('charm-set',   'Beaded charm or keyring',  'Made to your colours, with a small painted centrepiece.', 45000, 10, '#FFB6D9', 2),
  ('sticker-set', 'Custom sticker sheet',     'Your artwork or mine, die-cut and weatherproof.', 35000, 14, '#FFD166', 3)
) as v(key, label, description, price, lead, swatch, sort)
where g.key = 'base';

insert into custom_options (group_id, key, label, description, price_delta_cents, lead_time_days, swatch, sort_order, parent_option_id)
select g.id, v.key, v.label, v.description, v.price, v.lead, v.swatch, v.sort, p.id
from custom_option_groups g,
     custom_options p join custom_option_groups pg on pg.id = p.group_id and pg.key = 'base',
     (values
  ('small',  'Small — about A5',     'Fits a shelf or a desk.',              0,     0,  '#FFE0EE', 1, 'glass-panel'),
  ('medium', 'Medium — about A4',    'The size most people picture.',        45000, 7,  '#FFD1E8', 2, 'glass-panel'),
  ('large',  'Large — about A3',     'A wall piece. Needs a courier.',       110000, 14, '#FFB6D9', 3, 'glass-panel'),
  ('single', 'A single charm',       'One piece, one clasp.',                0,     0,  '#FFE0EE', 1, 'charm-set'),
  ('trio',   'A set of three',       'Matching, or three variations.',       28000, 5,  '#FFD1E8', 2, 'charm-set'),
  ('a6',     'A6 sheet',             'Roughly six to eight die-cuts.',       0,     0,  '#FFE0EE', 1, 'sticker-set'),
  ('a5',     'A5 sheet',             'Roughly twelve to sixteen die-cuts.',  18000, 3,  '#FFD1E8', 2, 'sticker-set')
) as v(key, label, description, price, lead, swatch, sort, parent_key)
where g.key = 'size' and p.key = v.parent_key;

insert into custom_options (group_id, key, label, description, price_delta_cents, lead_time_days, swatch, sort_order)
select g.id, v.key, v.label, v.description, v.price, v.lead, v.swatch, v.sort
from custom_option_groups g, (values
  ('soft-pastel', 'Soft pastels',      'Peach, pink and cream. What the shop is known for.', 0,     0, '#FFD9EC', 1),
  ('bright-pop',  'Bright and poppy',  'High contrast, saturated, a lot of yellow.',         0,     0, '#FFD166', 2),
  ('cool-glass',  'Cool and glassy',   'Blues and clear space. Reads well backlit.',         0,     0, '#7ED3F2', 3),
  ('metallic',    'With metallic leaf', 'Gold or copper leaf worked into the piece.',        35000, 7, '#E7C089', 4)
) as v(key, label, description, price, lead, swatch, sort)
where g.key = 'design';
