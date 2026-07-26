-- Verre admin/inventory foundation.
-- Applied migrations are immutable — change things in a NEW migration, never here.
--
-- Table order matters: pos_sessions and orders exist before the tables that
-- reference them (stock_movements.order_id, orders.session_id).

-- ─── TYPES ───────────────────────────────────────────────────
create type product_status as enum ('draft', 'active', 'archived');
create type product_category as enum ('glass', 'charms', 'stickers');

create type stock_reason as enum (
  'made',                -- Kyle finished a piece
  'sale_pos',
  'sale_web',
  'return',
  'damaged',
  'gifted',
  'stocktake',           -- manual recount correction
  'oversell_correction',
  'initial'              -- seed import
);

create type order_channel as enum ('web', 'pos');
create type order_status as enum ('inquiry', 'quoted', 'paid', 'fulfilled', 'cancelled');
create type payment_method as enum ('cash', 'gcash', 'bank_transfer', 'unpaid');
create type fulfillment_method as enum ('pickup', 'delivery', 'ship', 'in_person');

-- ─── PRODUCTS ────────────────────────────────────────────────
create table products (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,          -- immutable once public
  name            text not null,
  category        product_category not null,
  tag             text not null,                 -- short label on the card, e.g. '6 die-cuts'
  price_cents     integer not null check (price_cents >= 0),
  status          product_status not null default 'draft',
  stock_on_hand   integer not null default 0 check (stock_on_hand >= 0),
  low_stock_at    integer not null default 2,    -- dashboard warning threshold
  one_of_a_kind   boolean not null default false,
  blurb           text,
  description     text,
  dimensions      text,
  materials       text,
  care            text,
  lead_time       text,
  bg_color        text,                          -- existing card styling
  tape_color      text,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on products (status, category);

-- ─── IMAGES ──────────────────────────────────────────────────
create table product_images (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete cascade,
  storage_path text not null,                    -- products/{product_id}/{uuid}.webp
  alt          text not null,                    -- required; a11y is not optional
  position     integer not null default 0,
  created_at   timestamptz not null default now()
);
create index on product_images (product_id, position);

-- ─── POS SESSIONS ────────────────────────────────────────────
create table pos_sessions (
  id                  uuid primary key default gen_random_uuid(),
  label               text not null,        -- 'Sugbo Artist Alley — 9 Aug'
  device_label        text,
  opening_float_cents integer not null default 0,
  closing_cash_cents  integer,
  opened_at           timestamptz not null default now(),
  closed_at           timestamptz
);

-- ─── ORDERS ──────────────────────────────────────────────────
create table orders (
  id                    uuid primary key default gen_random_uuid(),
  ref                   text unique not null,            -- 'VR-7K2M', human-facing
  client_uuid           uuid unique,                     -- IDEMPOTENCY KEY (POS). Null for web.
  channel               order_channel not null,
  status                order_status not null,
  session_id            uuid references pos_sessions(id) on delete set null,

  customer_name         text,
  customer_email        text,
  customer_phone        text,
  fulfillment           fulfillment_method,
  note                  text,

  subtotal_cents        integer not null check (subtotal_cents >= 0),
  discount_cents        integer not null default 0 check (discount_cents >= 0),
  total_cents           integer not null check (total_cents >= 0),

  payment_method        payment_method not null default 'unpaid',
  tendered_cents        integer,
  change_cents          integer,

  is_oversell           boolean not null default false,
  sold_at               timestamptz not null default now(),   -- POS: time of sale, NOT time of sync
  synced_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index on orders (created_at desc);
create index on orders (status) where status in ('inquiry', 'quoted');
create index on orders (is_oversell) where is_oversell;

create table order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id) on delete cascade,
  product_id        uuid references products(id) on delete set null,
  product_name      text not null,        -- SNAPSHOT
  unit_price_cents  integer not null,     -- SNAPSHOT
  qty               integer not null check (qty > 0),
  line_total_cents  integer not null
);
create index on order_items (order_id);

-- ─── STOCK LEDGER ────────────────────────────────────────────
create table stock_movements (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete restrict,
  delta          integer not null check (delta <> 0),   -- signed
  reason         stock_reason not null,
  order_id       uuid references orders(id) on delete set null,
  note           text,
  created_by     text,                                   -- Cloudflare Access email
  created_at     timestamptz not null default now()
);
create index on stock_movements (product_id, created_at desc);
create index on stock_movements (created_at desc);

-- ─── AUDIT ───────────────────────────────────────────────────
create table admin_audit_log (
  id          bigserial primary key,
  actor       text not null,      -- Cloudflare Access email
  action      text not null,      -- 'product.update', 'stock.adjust', 'order.cancel'
  entity      text not null,
  entity_id   uuid,
  diff        jsonb,
  created_at  timestamptz not null default now()
);

-- ─── updated_at ──────────────────────────────────────────────
-- Without this the column defaults to insert time and then quietly lies forever.
create function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger products_touch before update on products
  for each row execute function touch_updated_at();
create trigger orders_touch before update on orders
  for each row execute function touch_updated_at();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────
-- Deny-all by design. The Worker uses the service role key, which bypasses RLS.
-- No policies exist, so if the anon key ever leaks into browser code the blast
-- radius is zero. Do not add a permissive policy without a very good reason.
alter table products enable row level security;
alter table product_images enable row level security;
alter table pos_sessions enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table stock_movements enable row level security;
alter table admin_audit_log enable row level security;

-- ─── STORAGE ─────────────────────────────────────────────────
-- Private bucket. Paths follow products/{product_id}/{uuid}.webp.
-- Reads go through Worker-issued signed URLs; writes through signed upload URLs.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', false)
on conflict (id) do nothing;
