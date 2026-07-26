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
recomputes order subtotals from Supabase. The current inquiry rate limit is
best-effort: five valid requests per IP per ten minutes, stored in Worker memory.

## Database (admin, inventory, POS)

Supabase Postgres is the source of truth for the storefront, admin console, and
offline POS. The Worker-only fallback in `src/db/fallback.js` keeps the public
catalog readable if Supabase is temporarily unavailable.

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
| General Admin | Dashboard, sales/orders, inventory, sessions, and POS |
| Cashier | POS only |

Set `SUPER_ADMIN_EMAILS` first so the initial Super Admin can open Accounts.
Adding an account in Verre does not create a password or update the Cloudflare
Access policy, so the same email must also be allowed in Access. Deactivate an
account in Verre to remove its feature access immediately.

For local `wrangler dev`, set `LOCAL_AUTH_BYPASS=true`; the Worker only honors
that flag on `localhost` or `127.0.0.1`.
`TRUST_SITES_AUTH` is off by default and should only be enabled for a verified
owner-only Sites dispatcher that strips client-supplied identity headers.

The optional KV bindings are `CATALOG_CACHE` (60-second live catalog plus a
last-known-good snapshot) and `DASHBOARD_CACHE` (five-minute snapshots).
Writes purge their related live keys.

Operational recovery and reconciliation procedures are in
[`docs/runbook.md`](docs/runbook.md).

### Schema changes

Through the CLI only — `npx supabase migration new <name>`, then edit the
generated file. Changes made in the Supabase dashboard are not in Git and will
silently diverge between local and production.
