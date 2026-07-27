# Verre — Build Plan: Admin, Inventory, Dashboard & POS

**Status:** blocked on `task.md`
**Implementer:** Codex
**Author of spec:** Claude
**Last updated:** 2026-07-26
**Companion doc:** `task.md` (storefront: cart, forms, product detail)

---

## 0. Read this first

### What this is

`task.md` builds a storefront with a hardcoded product list. **This document replaces that list with a real database and gives Kyle the tools to run the business:** add products, track stock, see how things are selling, and ring up sales at markets.

Four surfaces, one backend:

| Surface | Path | Who | Device |
|---------|------|-----|--------|
| **Public storefront** | `/` | Customers | Phone / desktop |
| **Admin — products & inventory** | `/admin` | Kyle | Desktop |
| **Admin — dashboard** | `/admin/dashboard` | Kyle | Desktop |
| **POS** | `/pos` | Kyle | Tablet / phone, **often offline** |

### Stack (decided — do not re-litigate)

| Concern | Choice |
|---------|--------|
| Database | **Supabase Postgres** |
| Images | **Supabase Storage** (S3-compatible, has image transforms) |
| API / hosting | **Cloudflare Workers** (existing) |
| Admin auth | **Cloudflare Access** (Zero Trust, in front of `/admin/*` and `/pos/*`) |
| POS | **Offline-first PWA** — IndexedDB queue, service worker, syncs when back online |
| Public catalog | **DB-driven** — the shop reads from Postgres |
| Payments | **Cash + GCash**, recorded manually. Digital receipt. No card processing, no hardware. |
| Money | **Integer centavos** (`price_cents`). Never a float, never a string. |
| Timezone | Store UTC. Display **Asia/Manila**. Business day boundaries are Manila-local. |

### Relationship to `task.md` — read carefully

**Sequencing:** finish `task.md` Phases 0 → D first. It ships a working storefront, and its `PRODUCTS` array becomes the **seed data** for this database. Starting both at once means building the cart against a data layer that's being rewritten underneath it.

Things in `task.md` this document supersedes, and when:

| `task.md` artifact | Fate |
|--------------------|------|
| `PRODUCTS` array in `index.html` | Becomes seed data, then is deleted in **Phase 9** |
| `src/catalog.js` (Worker price table) | Deleted in **Phase 1** — the Worker queries Postgres instead. Its `TODO` about staying in sync is resolved here. |
| `POST /api/inquiry` | Kept, but writes an `orders` row with `status='inquiry'` instead of only emailing |
| Product slugs | **Carried over unchanged.** They are already documented as immutable and may be in the wild via `?p=` links. |

---

## 1. Non-negotiable design rules

These are the four decisions that determine whether this system is trustworthy. Get them wrong and the inventory silently lies.

### 1.1 Stock is a ledger, not a number

Never `UPDATE products SET stock = stock - 1`. Every change writes a row to `stock_movements`, and `products.stock_on_hand` is a cached total updated **in the same transaction**, guarded by `CHECK (stock_on_hand >= 0)`.

This is what makes "why does it say 3 when I count 2?" an answerable question instead of a mystery. Every unit is accounted for: made, sold, reserved, damaged, gifted, corrected.

### 1.2 Sales are idempotent

The POS is offline-first, so **every write will be retried.** Bad wifi, a backgrounded tab, a tap on a stalled button. The client generates a UUID for each sale before sending it, and the server treats that UUID as the primary key of intent: a second arrival returns the *original* result and changes nothing.

Without this, one flaky sync at a market double-charges the day's revenue and double-decrements stock.

### 1.3 An offline sale that oversells is still a real sale

Kyle sells the last Cherry Red Mini Frame at a market with no signal. Meanwhile the website sells the same piece online. When the POS syncs, stock would go negative.

**Do not reject the sale.** The physical object is already in a customer's hands — the database doesn't get a vote. Instead:

1. Record the sale.
2. Write a compensating `stock_movements` row with `reason='oversell_correction'`.
3. Flag the order `is_oversell = true`.
4. Surface it loudly on the dashboard as **"Needs attention — sold twice"** with both order references, so Kyle can refund or remake.

A POS that refuses a sale because of a sync conflict is worse than useless at a market stall.

### 1.4 Order lines snapshot their product

`order_items` stores `product_name` and `unit_price_cents` **copied at sale time**, not joined live. When Kyle raises a price next month, last month's receipts must not silently change. Keep `product_id` as a nullable FK for reporting, but never rely on it for what the customer actually paid.

---

## 2. Schema

Migrations live in `supabase/migrations/`, numbered and immutable once applied. Use the Supabase CLI. **No schema changes through the dashboard UI** — they won't be in git and will diverge between environments.

### 2.1 Tables

```sql
-- ─── PRODUCTS ────────────────────────────────────────────────
create type product_status as enum ('draft', 'active', 'archived');
create type product_category as enum ('glass', 'charms', 'stickers');

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
  storage_path text not null,                    -- Supabase Storage object path
  alt          text not null,                    -- required; a11y is not optional
  position     integer not null default 0,
  created_at   timestamptz not null default now()
);
create index on product_images (product_id, position);

-- ─── STOCK LEDGER ────────────────────────────────────────────
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

-- ─── ORDERS ──────────────────────────────────────────────────
create type order_channel as enum ('web', 'pos');
create type order_status  as enum (
  'inquiry',    -- web: customer requested, awaiting Kyle's quote
  'quoted',
  'paid',
  'fulfilled',
  'cancelled'
);
create type payment_method as enum ('cash', 'gcash', 'bank_transfer', 'unpaid');
create type fulfillment_method as enum ('pickup', 'delivery', 'ship', 'in_person');

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
create index on orders (status) where status in ('inquiry','quoted');
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
```

> `stock_movements.order_id` forward-references `orders`. Create `orders` first in the migration, or add the FK in a follow-up `alter table`.

### 2.2 Row-level security

The Worker connects with the **service role key, which bypasses RLS.** Enable RLS anyway with deny-all policies on every table. It's defence in depth: if the anon key ever leaks into client code, the blast radius is zero instead of total.

- [ ] `alter table … enable row level security` on all tables
- [ ] No permissive policies. Nothing is reachable except through the Worker.
- [ ] The **anon key must never appear in browser-delivered code.** The public site reads products through the Worker, not directly from Supabase.

### 2.3 Transactional RPC functions

Anything that touches stock happens inside a Postgres function, not in Worker code. This is what makes concurrency safe — the lock and the write live in the same transaction, and the network can't interrupt them.

```sql
-- Idempotent, oversell-tolerant sale recording.
-- Returns the full order. Called by POS sync and by web order confirmation.
create function record_sale(
  p_client_uuid   uuid,
  p_channel       order_channel,
  p_items         jsonb,      -- [{ "product_id": "...", "qty": 2 }]
  p_sold_at       timestamptz,
  p_payment       payment_method,
  p_tendered_cents integer,
  p_session_id    uuid,
  p_customer      jsonb,
  p_actor         text
) returns jsonb
language plpgsql
as $$
begin
  -- 1. If p_client_uuid already exists, RETURN THE EXISTING ORDER UNCHANGED.
  --    This is the idempotency guarantee. Do not raise, do not update.
  -- 2. SELECT ... FOR UPDATE every product in p_items, ordered by id
  --    (consistent lock ordering prevents deadlock between POS and web).
  -- 3. Read current prices from products -> snapshot into order_items.
  -- 4. Insert order + order_items.
  -- 5. Insert stock_movements (negative delta) and decrement stock_on_hand.
  -- 6. If any decrement would breach the >= 0 check: clamp to 0, insert an
  --    'oversell_correction' movement for the shortfall, set is_oversell = true.
  --    NEVER abort the sale.
  -- 7. Return the order as jsonb.
end;
$$;

create function adjust_stock(
  p_product_id uuid,
  p_delta      integer,
  p_reason     stock_reason,
  p_note       text,
  p_actor      text
) returns integer   -- new stock_on_hand
language plpgsql as $$ begin /* movement + cached total, one transaction */ end; $$;
```

- [ ] Both functions are `security definer` with a locked-down `search_path`
- [ ] Write **pgTAP or SQL-based tests** for `record_sale`: duplicate `client_uuid`, concurrent sale of the same last item, oversell path, empty items, unknown product id
- [ ] Concurrency test: two simultaneous calls for the last unit — exactly one succeeds normally, the other is flagged, and stock lands at 0, never −1

---

## 3. File ownership

| Path | Phase | Notes |
|------|-------|-------|
| `supabase/migrations/*.sql` | 0 | Append-only. Never edit an applied migration. |
| `supabase/seed.sql` | 0 | Seeds from `task.md`'s `PRODUCTS` |
| `src/db/*.js` | 1 | Supabase client + typed query helpers |
| `src/worker.js` | 1, 2 | Router grows: `/api/*`, `/admin/*`, `/pos/*` |
| `src/api/admin/*.js` | 1, 3–6 | |
| `src/api/pos/*.js` | 1, 7–8 | |
| `admin/**` | 3–6 | New admin SPA |
| `pos/**` | 7–8 | New POS PWA |
| `index.html` | 9 | Only at the very end |
| `src/catalog.js` | 1 | **Deleted** |
| `support.js` | — | Never touch |

---

## PHASE 0 — Database foundation

- [ ] Supabase project created; connection details in `.dev.vars` (gitignored) and Cloudflare secrets
- [ ] Supabase CLI wired up; `supabase db reset` rebuilds from scratch locally
- [ ] All tables, types, indexes, constraints from §2.1
- [ ] RLS enabled with deny-all everywhere (§2.2)
- [ ] `record_sale` and `adjust_stock` implemented and tested (§2.3)
- [ ] Storage bucket `product-images`, **private**, with a documented path convention (`products/{product_id}/{uuid}.webp`)
- [ ] `seed.sql` imports the 8 products from `task.md`, preserving slugs, with `status='active'`, `one_of_a_kind=true` for glass pieces, and an `initial` stock movement each
- [ ] `README.md` documents: how to run migrations, how to reset local, every required env var

**Acceptance:** a clean checkout reaches a fully seeded local database with one command. The concurrency test passes.

---

## PHASE 1 — Data access layer

- [ ] Supabase client in `src/db/client.js`, service-role key from `env`, instantiated per-request (**not** at module scope — Workers isolates are shared across requests)
- [ ] Simple CRUD goes through `@supabase/supabase-js` over HTTP; **anything touching stock goes through the RPCs from §2.3.** No stock arithmetic in JavaScript, ever.
- [ ] Query helpers in `src/db/`: `products.js`, `orders.js`, `stock.js`, `stats.js`. Routes call helpers; routes never build queries inline.
- [ ] Every helper returns `{ data, error }` — no thrown strings, no silent nulls
- [ ] Delete `src/catalog.js`; `POST /api/inquiry` now resolves prices from the DB
- [ ] Signed-URL helper for reading private images (1h expiry), and a resolver that turns a `storage_path` into a public-facing transform URL

> **Note:** if PostgREST proves awkward, the fallback is `postgres.js` through the Supabase **Supavisor pooler in transaction mode**. Do not open direct unpooled connections from Workers — you'll exhaust Postgres connection slots under any real traffic.

---

## PHASE 2 — Auth

- [ ] Cloudflare Access application covering `/admin/*` and `/pos/*`
- [ ] Policy: allow-list Kyle's email. Email OTP or Google.
- [ ] **Session duration 30 days for `/pos/*`** — a market tablet cannot do an email round-trip on flaky wifi. Shorter (24h) for `/admin/*`.
- [ ] The Worker **verifies the `Cf-Access-Jwt-Assertion` JWT signature** against the team's public keys and checks `aud`. Do not trust the header's presence alone — verify the signature or the protection is decorative.
- [ ] Verified email is threaded into `created_by` / `admin_audit_log.actor`
- [ ] `/api/admin/*` and `/api/pos/*` return `401` without a valid assertion
- [ ] **Access returns a 302 to a login page when a session expires.** A `fetch` from the POS service worker will follow it and get HTML instead of JSON. Detect this (non-JSON content-type, or an `opaqueredirect`) and surface **"Session expired — reconnect to keep syncing"** rather than corrupting the queue or silently dropping sales.
- [ ] Document the bypass path for local dev (`wrangler dev` has no Access in front of it) and make sure the bypass cannot ship to production

---

## PHASE 3 — Admin shell & product management

Plain HTML + vanilla JS or a tiny library, server-rendered from the Worker where practical. **The admin does not need to use the `dc` runtime** — it's a separate app with different needs. Do not add React, Vue, or a build toolchain for it.

Visually: same palette and fonts as the storefront, but calmer. Fewer rotations, no float animations, denser layout. This is a tool Kyle uses for an hour at a time, not a shopfront.

### T3.1 — Shell
- [ ] Sidebar: Dashboard · Products · Inventory · Orders · POS · Sessions
- [ ] Signed-in email + sign-out visible
- [ ] Responsive down to tablet; desktop-first is fine here
- [ ] Consistent toast/error component used everywhere

### T3.2 — Product list
- [ ] Table: thumbnail, name, category, price, stock, status
- [ ] Search by name/slug; filter by category and status; sort by stock and name
- [ ] Low stock (`stock_on_hand <= low_stock_at`) highlighted; zero stock visually distinct
- [ ] Empty state and loading skeletons

### T3.3 — Create / edit
- [ ] Full form over every `products` column
- [ ] Slug auto-generates from name for new products; **locked with a warning once `status` has ever been `active`** (public `?p=` links depend on it)
- [ ] Price entered in pesos, stored as centavos. Handle `850`, `850.50`, `₱850`, `1,250` — and reject nonsense rather than silently coercing to 0.
- [ ] `one_of_a_kind` forces `low_stock_at = 0` and hides the threshold field
- [ ] Live preview of the storefront card as Kyle types
- [ ] Unsaved-changes warning on navigate away
- [ ] Validation mirrors the DB constraints, with inline messages
- [ ] Archive rather than delete. Hard delete only for products with **zero** order history, behind a typed confirmation.

### T3.4 — Images
- [ ] Drag-and-drop upload, multiple files
- [ ] **Browser uploads directly to Supabase Storage via a Worker-issued signed URL.** Do not proxy image bytes through the Worker — you'll hit CPU and memory limits on the first large photo.
- [ ] Client-side resize to max 1600px and convert to WebP before upload; reject > 10 MB originals
- [ ] Reorder by drag; first image is primary
- [ ] **`alt` text is required** — the storefront has proper `aria-label`s today and this must not regress it
- [ ] Delete removes both the row and the storage object

**Acceptance:** Kyle adds a brand-new product with three photos, sets stock, publishes it, and it appears on the storefront (once Phase 9 lands) with correct pricing and alt text — without anyone touching code.

---

## PHASE 4 — Inventory

### T4.1 — Stock adjustment
- [ ] From the product row: quick `+1` / `−1`
- [ ] Full adjust modal: quantity, reason (from the enum), optional note
- [ ] Every adjustment calls `adjust_stock`. **No direct writes to `stock_on_hand` from anywhere in the app.**
- [ ] Optimistic UI that rolls back cleanly on failure

### T4.2 — Movement history
- [ ] Per-product timeline: date, delta, reason, note, who, resulting balance
- [ ] Sale movements link to the order
- [ ] Filter by reason and date range
- [ ] CSV export

### T4.3 — Stocktake
- [ ] A "count everything" view: current system quantity beside a physical-count input
- [ ] Submitting writes one `stocktake` movement per discrepancy — not a blanket overwrite
- [ ] Show the variance summary before committing, and require confirmation

### T4.4 — Low stock
- [ ] Dashboard widget listing everything at or below threshold
- [ ] "Restocked" quick action → a `made` movement

**Acceptance:** stock is reconstructible from the ledger alone. `sum(delta)` per product equals `stock_on_hand` for every product — write this as a test, and consider a scheduled Worker that checks it nightly and alerts on drift.

---

## PHASE 5 — Orders

### T5.1 — Web inquiries
- [ ] `POST /api/inquiry` from `task.md` now inserts an `orders` row with `channel='web'`, `status='inquiry'`, plus `order_items` — **in addition to** sending the emails
- [ ] Emails still send even if the DB write fails; log the failure loudly. A lost inquiry is worse than an unrecorded one.
- [ ] Inquiries **do not decrement stock.** They are requests, not sales.

### T5.2 — Order management
- [ ] List with filters: status, channel, date range, search by ref/name/email
- [ ] Detail view: items, totals, customer, timeline of status changes
- [ ] Status transitions `inquiry → quoted → paid → fulfilled`, plus `cancelled` from any state
- [ ] **Marking `paid` calls `record_sale` and decrements stock.** This is the moment a web inquiry becomes a real sale.
- [ ] Cancelling a paid order writes a `return` movement restoring stock
- [ ] `mailto:` link prefilled with the order details for quoting
- [ ] Oversell orders are visually flagged with a link to the conflicting order

**Acceptance:** the full web order lifecycle runs from Kyle's side, and stock only ever moves at the correct moment.

---

## PHASE 6 — Dashboard

Answer, at a glance: *is the business okay, and what needs my attention today?*

### T6.1 — Metrics
Date range selector (Today / 7d / 30d / 90d / custom), all in **Manila time**:

- [ ] Revenue, order count, average order value — with the change vs the previous equivalent period
- [ ] Channel split: POS vs web
- [ ] Units sold
- [ ] Top 5 products by revenue and by units (they differ, and the difference is the interesting part)
- [ ] Category breakdown
- [ ] Revenue sparkline by day
- [ ] Payment method split

### T6.2 — Attention panel
Above the metrics, because it's what actually matters day to day:

- [ ] Unanswered inquiries older than 48h — the site promises a reply in 2–3 days
- [ ] Oversell conflicts
- [ ] Out of stock but still `active` on the storefront
- [ ] Low stock
- [ ] Any POS session left open more than 24h
- [ ] Nightly ledger-drift check failures (§4)

### T6.3 — Implementation
- [ ] Aggregations run **in Postgres**, not by pulling rows into the Worker
- [ ] Backing SQL views for the common rollups
- [ ] Cache in Cloudflare KV for 5 minutes with a manual refresh button
- [ ] Charts via a single CDN chart library; no framework
- [ ] Every number is drillable to the underlying orders — an unexplainable metric gets distrusted and then ignored
- [ ] Zero-data state that says so plainly instead of rendering empty axes

---

## PHASE 7 — POS (online)

Built for **one hand, standing up, in bad light, with a queue forming.** Optimize for speed of a single sale above everything else.

### T7.1 — Layout
- [ ] Two panes: scrollable product grid, persistent cart
- [ ] Large touch targets (min 48px), high contrast, generous spacing
- [ ] Tap a product to add; long-press or a stepper for quantity
- [ ] Search and category tabs
- [ ] Out-of-stock items visibly dimmed but **still tappable** — Kyle may be holding stock the system doesn't know about. Warn, don't block (§1.3).
- [ ] Works in portrait and landscape

### T7.2 — Sale flow
- [ ] Cart: line items, quantity steppers, remove, subtotal
- [ ] Optional whole-order discount (amount or percent), reason recorded
- [ ] Payment: **Cash** or **GCash**
- [ ] Cash → amount tendered, **large auto-calculated change display**, plus quick-tender buttons (exact, ₱500, ₱1000)
- [ ] GCash → reference number field, optional
- [ ] Confirm → success screen with the order ref, then auto-reset to a fresh sale after ~4s or on tap
- [ ] **Undo the last sale** within 60 seconds — voids the order and reverses stock. Mis-taps happen constantly on a busy stall.

### T7.3 — Receipts
- [ ] Digital receipt page at `/r/{ref}` — public, read-only, no PII beyond what's needed
- [ ] QR code on the success screen linking to it
- [ ] Optional: send to a customer email
- [ ] No thermal printer in this phase (decided) — but keep receipt rendering in its own module so ESC/POS can be added later without surgery

### T7.4 — Sessions
- [ ] Start a session with a label and opening float before selling
- [ ] Header shows the active session and running total
- [ ] Close a session: expected cash vs counted cash, variance shown, notes
- [ ] Session summary: total sales, by payment method, units, top sellers
- [ ] Warn on selling with no open session; don't hard-block it

---

## PHASE 8 — POS offline

The part that makes the POS actually usable at Sugbo Artist Alley.

### T8.1 — PWA
- [ ] `manifest.json`, installable, standalone display, portrait-primary, proper icons
- [ ] Service worker: **cache-first** for the app shell, **network-first with cache fallback** for product data
- [ ] Product catalog and images cached on session start so the grid renders offline
- [ ] Clear, permanent online/offline indicator — Kyle must never have to guess

### T8.2 — Queue
- [ ] Sales write to **IndexedDB first, then attempt the network.** Not the other way round. The local write is the source of truth until confirmed.
- [ ] Each sale gets a client-generated UUID at creation (§1.2)
- [ ] Queue UI: pending count, tap to inspect, manual "sync now"
- [ ] Local stock is decremented optimistically so the grid stays sensible offline
- [ ] Sessions and undo work fully offline

### T8.3 — Sync
- [ ] Auto-sync on reconnect (`online` event + periodic retry), sequential, oldest first
- [ ] Exponential backoff with jitter; cap the interval
- [ ] `POST /api/pos/sync` accepts a **batch**; the server processes each through `record_sale` and returns a per-item result. One bad sale must not fail the batch.
- [ ] Successfully synced items are removed from the queue **only after** a confirmed server response
- [ ] Oversells come back flagged and are shown to Kyle after sync — not buried
- [ ] Permanently rejected items (malformed, deleted product) move to a "needs review" list; **never silently dropped**
- [ ] Expired Access session is surfaced as an actionable message (§Phase 2), and the queue is preserved untouched

### T8.4 — Offline testing

This is the phase most likely to ship broken, because it works fine at a desk. Test it properly:

- [ ] Sell 10 items fully offline, reconnect, verify exactly 10 orders and correct stock
- [ ] Kill the connection mid-sync — no duplicates, no losses
- [ ] Force-close the app with a queue pending — it survives restart
- [ ] Sync the same batch twice — idempotency holds, totals unchanged
- [ ] Offline sale of an item the web sold concurrently — oversell path fires correctly
- [ ] Airplane mode for a simulated 6-hour market with ~30 sales
- [ ] Device storage full — degrade with a clear warning, don't lose the queue

---

## PHASE 9 — Public site reads from the database

Last, because everything else must be proven first.

- [ ] The Worker serves the storefront with products injected from Postgres
- [ ] Only `status='active'` products appear
- [ ] Real stock drives the badges from `task.md` Phase C: `One of a kind` / `Only N left` / `Sold out`
- [ ] Product images come from Supabase Storage with transforms, replacing the sprite atlas for products. **Keep the atlas** for the hero collage, about-section photos, and the Instagram grid — those aren't products.
- [ ] Responsive `srcset`, `loading="lazy"`, explicit `width`/`height` to prevent layout shift
- [ ] Cache product JSON in KV for 60s; **purge on any product or stock write** so a sold-out item doesn't linger
- [ ] `?p=<slug>` deep links still resolve, including for archived products (show a tasteful "no longer available" state rather than a 404)
- [ ] **Delete the `PRODUCTS` array from `index.html`**
- [ ] Storefront still renders if the DB is unreachable — serve the last-known-good KV snapshot with a soft "stock may be out of date" note rather than a broken page

**Acceptance:** Kyle adds a product in `/admin`, and it is live on the storefront within a minute. He sells it at a market, and the site shows it sold out after sync.

---

## PHASE 10 — Verification

### Data integrity
- [ ] For every product: `sum(stock_movements.delta) = products.stock_on_hand`
- [ ] No order has `total_cents <> subtotal_cents - discount_cents`
- [ ] No `order_items` row with a null `product_name` or `unit_price_cents`
- [ ] Every `client_uuid` is unique; replaying the full POS queue changes nothing
- [ ] Editing a product's price does not alter any historical order total

### Security
- [ ] `/admin/*`, `/pos/*`, `/api/admin/*`, `/api/pos/*` all return 401/403 unauthenticated
- [ ] Access JWT **signature** is verified, not just its presence
- [ ] Service role key and Supabase URL never reach the browser — check the built bundle
- [ ] RLS enabled everywhere with no permissive policies
- [ ] Storage bucket is private; images served via signed or transform URLs
- [ ] `.dev.vars`, `.env` gitignored; no secret in git history
- [ ] Admin inputs are sanitized — product `description` renders on the public site, so unescaped HTML there is stored XSS
- [ ] Rate limits on all public endpoints

### Operational
- [ ] Supabase automated backups on; **a restore has actually been tested**, not just enabled
- [ ] A documented runbook: rotate keys, restore a backup, reconcile a bad stocktake
- [ ] Nightly ledger-drift check with an alert
- [ ] Migrations run cleanly against a copy of production data
- [ ] Rollback plan for Phase 9 (revert to the KV snapshot / static catalog)

### Usability
- [ ] Kyle completes a full market simulation offline without help
- [ ] Adding a product takes under 3 minutes including photos
- [ ] POS: product tap → completed sale in under 15 seconds
- [ ] Dashboard loads in under 2 seconds
- [ ] Admin is keyboard-navigable; POS is thumb-navigable one-handed

---

## Out of scope

Multi-user staff accounts and roles · barcode scanning · thermal printing · card payments and terminals · a customer loyalty program · purchase orders and supplier tracking · accounting integration · automated shipping labels · a native mobile app · multi-currency.

Several of these are reasonable later. None belong in v1.

---

## Open questions for Kyle

1. **Historical data** — is there an existing spreadsheet or notebook of past sales and stock worth importing, or does this start from zero?
2. **Product photos** — the current 16-image atlas is a placeholder. Are there real per-product photos to upload during Phase 3?
3. **Discounts** — do you actually discount at markets (bundles, "3 stickers for ₱400")? If so, per-line bundle pricing needs to enter Phase 7 rather than whole-order discounts only.
4. **Consignment** — the two stockists (CR8 Cebu, Art Treats PH) hold your stock. Should the system track consigned inventory separately from what's on hand? It's a meaningful schema addition, and getting it wrong makes stock counts wrong.
5. **POS device** — what tablet or phone, and which browser? Determines how hard to lean on newer PWA APIs.
6. **GCash reconciliation** — manual reference numbers, or is there a statement export worth matching against?
7. **Multiple people selling** — will anyone other than you ever run the POS? Cheap to design for now, expensive to retrofit.
