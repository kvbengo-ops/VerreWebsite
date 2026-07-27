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

Bind a KV namespace as `AUTH_LIMITS` in production. Without it the limiter falls
back to an in-memory map that resets whenever Cloudflare recycles the isolate —
acceptable for the contact form, not for a password gate.

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
