# Verre — handmade crafts website

Static storefront rendered by the bespoke `dc` runtime and served by a
Cloudflare Worker. The Worker also accepts order and inquiry requests and sends
them through Resend.

```text
npm run build
npm test
npx wrangler dev
```

## Setup

`POST /api/inquiry` sends one email to Verre and a confirmation to the customer.
It requires three runtime values:

| Name | Purpose |
|------|---------|
| `RESEND_API_KEY` | Resend API key. Never commit it. |
| `OWNER_EMAIL` | Kyle's notification inbox. |
| `FROM_EMAIL` | Sender address on a domain verified in Resend. |

For local development, copy `.dev.vars.example` to `.dev.vars`, fill in all
three values, run `npm run build`, and then run `npx wrangler dev`.
`.dev.vars` is ignored by Git.

For production, configure the same three runtime values in the hosting
environment. With Wrangler, set each one with
`npx wrangler secret put NAME`, for example:

```text
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put OWNER_EMAIL
npx wrangler secret put FROM_EMAIL
```

Before sending, verify the domain used by `FROM_EMAIL` in Resend. The actual
owner inbox and sending domain are intentionally not hardcoded; confirm both
with Kyle before launch.

Prices sent by the browser are ignored. The Worker resolves permanent slugs and
recomputes order subtotals from Supabase. Inquiry and authentication limits use
a Durable Object, so counters survive Worker isolate and region changes.

## Database (admin, inventory, POS)

Supabase Postgres is the source of truth for the storefront, admin console, and
offline POS. The Worker-only fallback in `src/db/fallback.js` keeps the public
catalog readable if Supabase is temporarily unavailable.

`npm test` now **executes** every migration against Postgres compiled to
WebAssembly (PGlite — no Docker, no server) and then exercises the RPCs against
the result. Parsing SQL only proves it is well-formed; a SQL function body is
validated by Postgres at `CREATE` time, so a mistake like ordering by a subquery
column as though it were a table alias is invisible to a parser, invisible on
review, and fatal to `db push`. The check skips itself if the devDependency is
absent, so a fresh clone still tests green without it.

```text
npx supabase start        # local stack (needs Docker Desktop)
npx supabase db reset     # drop, re-run every migration, then load seed.sql
npx supabase test db      # pgTAP tests for record_sale / adjust_stock
npx supabase db push      # apply pending migrations to the linked project
```

| Name | Purpose |
|------|---------|
| `SUPABASE_URL` | Project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key. Bypasses RLS — **Worker only, never the browser.** |
| `CF_ACCESS_TEAM_DOMAIN` | Access issuer, such as `https://team.cloudflareaccess.com`. |
| `CF_ACCESS_AUD` | Access application audience tag checked on every admin/POS API request. |
| `SUPER_ADMIN_EMAILS` | Comma-separated bootstrap Super Admin emails. `ADMIN_EMAILS` remains a legacy alias. |

Set both the same way as the Resend values: `.dev.vars` locally,
`npx wrangler secret put NAME` in production. The **anon key is deliberately not
used** — the public site reads products through the Worker, so no Supabase
credential of any kind belongs in browser-delivered code.

### Layout

| Path | What |
|------|------|
| `supabase/migrations/*.sql` | Schema. **Append-only** — an applied migration is never edited. |
| `supabase/seed.sql` | The 8 storefront products, slugs preserved, plus an opening ledger entry each. |
| `supabase/tests/*.test.sql` | pgTAP. |

### Rules that keep the numbers honest

- **Stock is a ledger.** Never `update products set stock_on_hand = …`. Every
  change goes through `adjust_stock()` or `record_sale()`, which write a
  `stock_movements` row and the cached total in one transaction. For every
  product, `sum(stock_movements.delta)` must equal `products.stock_on_hand`.
- **Sales are idempotent** on `orders.client_uuid`. Replaying a POS sale returns
  the original order and changes nothing.
- **An offline sale that oversells still stands.** The piece is already in a
  customer's hands, so `record_sale` clamps stock at 0, books the shortfall as an
  `oversell_correction` movement, and sets `is_oversell` for the dashboard.
- **Order lines snapshot** `product_name` and `unit_price_cents`. Raising a price
  never rewrites an old receipt.
- Money is integer centavos everywhere: ₱850 is `85000`.
- RLS is enabled with **no policies** on every table. The service role key is the
  only way in, by design.

Product images live in the private `product-images` bucket at
`products/{product_id}/{uuid}.webp`, served through signed URLs.

## Custom commissions

A commission is not a checkout. The piece does not exist yet, so nobody — the
customer or Kyle — knows what it costs until he has read the brief. The
storefront wizard collects a *spec*; the price arrives afterwards, by email.

The customer walks four steps under **Custom order** on the homepage (base →
size → design → brief and reference photos), reviews a summary alongside their
contact and shipping details, and submits once. They get a tracking link; Kyle
gets the brief in `/admin` → **Custom orders**.

### Three numbers that are not the same number

| Column | Means |
|---|---|
| `estimate_cents` | What the wizard showed, summed from option `price_delta_cents`. A ballpark. |
| `quoted_cents` | What Kyle actually charges, set in admin. |
| `total_cents` | **Stays 0 until quoted.** An estimate is not revenue and must never reach the dashboard as if it were. |

The wizard displays prices, so the browser knows them — and is therefore not
trusted with them. `create_custom_request` re-reads every delta from
`custom_options` and ignores anything the client sent, the same rule the catalog
cart already follows. `src/custom.test.mjs` asserts that only keys and free text
survive validation.

### Status pipeline

```text
inquiry → quoted → awaiting_payment → paid → in_production → fulfilled
```

`awaiting_payment` and `in_production` were added for commissions. Without them a
piece sits in `quoted` from the moment a price is sent until money arrives, and
the dashboard cannot tell "waiting on the customer" from "Kyle hasn't replied
yet". Catalog orders keep their original `inquiry → quoted → paid → fulfilled`
path, and `set_order_status` still accepts it unchanged.

A commission has no `order_items`, so marking one paid writes no stock movement.
That is deliberate: nothing came off a shelf.

### Tracking, and why it needs a token

`/order/{ref}?t={track_token}` is the customer's status page. Unlike `/r/{ref}`,
it requires a 128-bit token generated at submit and delivered only in the
confirmation email. A `ref` is four characters of a 32-symbol alphabet — about a
million combinations, which is a weekend of guessing — and a receipt showing
items is a different thing from an order status showing a name and where a piece
is headed. `public_order_track` is also built up from scratch rather than
`orders` minus a few columns, so a column added later cannot leak by default.

### The options are data, not code

`/admin` → **Custom orders** → **Wizard steps** (Super Admin only) edits
`custom_option_groups` and `custom_options`. Adding a size or a finish needs no
deploy. Notes:

- An option's `key` is immutable once created — selections snapshot it.
- `parent_option_id` makes a choice conditional on an earlier one, so the sizes
  offered for a glass panel are not the ones offered for stickers. One level
  only; a deeper tree is a rules engine nobody can explain six months later.
- Removing a choice that someone has already picked **deactivates** it rather
  than deleting it, so old quotes keep their wording.
- Selections snapshot `group_label`, `option_label` and `price_delta_cents`.
  Raising a price next month never rewrites a quote sent last month.

Reference photos go to the private `custom-references` bucket at
`custom/{order_id}/{uuid}.ext`, uploaded straight from the browser through a
signed URL — streaming an 8MB phone photo through the Worker would exceed
Cloudflare's free-plan CPU and memory budget. They are attached *after* the
order row exists, so a failed photo can never cost the brief.

## Admin and POS

- `/admin` manages products, private images, inventory ledger movements,
  stocktakes, inquiries, order status, sessions, and the Postgres-aggregated
  dashboard.
- `/pos` is an installable PWA. Sales are written to IndexedDB before any
  network request, then synced oldest-first through the idempotent
  `record_sale()` RPC. Never clear browser storage while its pending count is
  non-zero.
- `/r/{ref}` is the public, read-only digital receipt.

Cloudflare Access should have separate applications for `/admin/*` (24-hour
session) and `/pos/*` (30-day session), restricted to the staff emails that
should be able to sign in. Access authenticates the email; Verre then applies
the role stored under **Admin → Accounts**:

| Role | Access |
| --- | --- |
| Super Admin | Every feature, including products and account management |
| General Admin | Sales/orders, inventory, and POS |
| Cashier | POS only |

## Local development

```
npm run dev
```

Builds once, starts `wrangler dev`, then watches `src/`, `admin/`, `pos/`,
`login/`, `assets/`, `index.html` and `support.js` and rebuilds on save.
wrangler picks the rebuild up and reloads itself, so a change needs a save and a
browser refresh — not a manual `npm run build` and a restart.

This exists because `wrangler.toml` points at build output (`main =
dist/server/index.js`, `[assets] directory = dist/client`). wrangler only ever
serves what the build produced, so an unbuilt edit genuinely does not exist yet.
Pointing wrangler at the source tree instead looks simpler and is a trap:
`[assets]` serves everything beneath its directory, and the repo root contains
`.dev.vars` — that would publish the Supabase service role key on localhost.

Two things still need the command restarted, because neither is watched:

- **`wrangler.toml`** — read once at startup.
- **New Cloudflare bindings or secrets.**

And two client caches will hide a fresh build from you:

- **The POS** is a cache-first PWA. Bump `VERSION` in `pos/sw.js` when a SHELL
  file changes, then reload twice or unregister the service worker.
- **Stylesheets** need a hard refresh (`Ctrl+Shift+R`).

## Signing in

Verre owns its own login. `/login` posts to `/api/auth/login`, which sets a
`verre_session` cookie — `HttpOnly`, `Secure`, `SameSite=Lax`, 24 hours, fixed
rather than sliding. `/admin/*` and `/pos/*` require it. A browser navigating
without one is redirected to `/login`; a `fetch` gets `401` JSON so the admin
bundle can show "session expired" instead of trying to parse an HTML page.

### Creating the first account

```
npm run create-admin
```

Prompts for email, display name, role and password, then writes them through
`set_admin_account` and `set_password`. It needs `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, so it runs from a terminal with access to
`.dev.vars` — deliberately not an HTTP endpoint. **This is also the break-glass
path**: if you lock yourself out and password reset cannot send email, re-run it
to set a new password.

`SUPER_ADMIN_EMAILS` still grants the Super Admin role, but an account with no
password hash can never sign in. Being on that list is authorization, not
authentication.

### Where hashing happens

In Postgres, via `pgcrypto` bcrypt at cost factor 12 — not in the Worker.
Cloudflare's free plan allows roughly 10ms CPU per request and a safely-tuned
hash costs far more, so hashing in the Worker either fails or gets weakened
until it fits, which makes it cheap to attack too. `verify_password` also runs a
dummy comparison for unknown emails so response time cannot be used to discover
which accounts exist. Confirm Supabase statement logging is not capturing
parameter values before going live; the password crosses as a bound parameter.

### Lockout and rate limits

Five consecutive failures lock an account for 15 minutes, doubling on repeat.
Logins are also limited to 10 per IP per 15 minutes. Every failure — unknown
email, wrong password, locked account — returns one identical message, and
`/api/auth/request-reset` always returns `200`, so neither endpoint can be used
to enumerate accounts.

The required `RATE_LIMITER` Durable Object binding is declared in
`wrangler.toml`. The public readiness check stays red if that binding is absent;
only local development and unit tests use an in-memory fallback.

### Other identity sources

Cloudflare Access support remains in `src/auth.js` and is still correctly
signature-verified. It costs nothing when unconfigured and putting Access in
front of `/admin/*` is real defence in depth. `LOCAL_AUTH_BYPASS` also remains,
gated to `localhost` / `127.0.0.1`, and cannot work on a deployed host.

The hosting dispatcher's `oai-authenticated-user-email` header has been
**removed**. It was an unsigned string whose trustworthiness depended entirely
on deployment topology. Do not reintroduce it.

The optional KV bindings are `CATALOG_CACHE` (60-second live catalog plus a
last-known-good snapshot) and `DASHBOARD_CACHE` (five-minute snapshots).
Writes purge their related live keys.

Operational recovery and reconciliation procedures are in
[`docs/runbook.md`](docs/runbook.md).

### Schema changes

Through the CLI only — `npx supabase migration new <name>`, then edit the
generated file. Changes made in the Supabase dashboard are not in Git and will
silently diverge between local and production.
