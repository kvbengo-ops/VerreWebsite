# Verre — Kyle's setup checklist

**Status:** ready to start
**Owner:** Kyle — nobody else can do these
**Companion docs:** `task.md` (storefront) · `task-admin.md` (admin, inventory, POS) · `docs/runbook.md` (operations)
**Last updated:** 2026-07-26

---

## 0. Read this first

The code is written and verified. `npm run build`, `src/worker.test.mjs`,
`src/auth.test.mjs`, `scripts/check-catalog.mjs` and the 31 database tests all
pass. What is left needs **your accounts, your decisions, or your hands** — none
of it can be done from the repo.

Section 1 is done. Start at section 2.

---

## 1. Docker + the local database — ✅ DONE

All four migrations applied against real Postgres 17, `seed.sql` loaded, and
**all 31 pgTAP tests pass** — including idempotent replay, the oversell path,
price-change immutability, and the ledger invariant. The 8 seeded products each
balance: `sum(stock_movements.delta) = stock_on_hand`. The `product-images`
bucket exists and is private.

`.dev.vars` is already written with the local Supabase URL and service-role key
(the shared local defaults — they only work against `127.0.0.1`).

Two Windows-specific things were fixed along the way, so they don't bite again:

- **Analytics is off** in `supabase/config.toml`. The Logflare container needs the
  Docker daemon exposed on `tcp://localhost:2375` on Windows and reports
  unhealthy without it, which fails the whole `supabase start`. Nothing here uses
  it — the dashboard aggregates in Postgres.
- **Open a new terminal after installing Docker Desktop.** The installer adds its
  `bin` folder to your PATH, but shells already running don't pick it up. That is
  the entire cause of both `docker: command not found` and the
  `LegacyDockerRunError` from `npx supabase test db`.

Day to day:

```bash
npx supabase start        # bring the stack up
npx supabase db reset     # rebuild from migrations + seed after a schema change
npx supabase test db      # 31 tests, ~0 seconds
npx supabase stop         # when you're done
```

> Never hand-edit a migration that has already been applied. Fixes go in a new
> one: `npx supabase migration new fix_whatever`.

---

## 2. Resend — partly deferred (no domain yet)

You're on a `workers.dev` subdomain, so there is no DNS you control and nothing
to verify in Resend yet. Do the part that works now:

- [ ] Create an account at [resend.com](https://resend.com)
- [ ] **API Keys → Create** → copy into `.dev.vars` as `RESEND_API_KEY`
- [ ] Set `FROM_EMAIL=Verre <onboarding@resend.dev>` — Resend's shared sender,
      usable with no domain
- [ ] Set `OWNER_EMAIL` to **the address you signed up to Resend with**

### What this gets you, and what it doesn't

`onboarding@resend.dev` only delivers to **your own signup address**. So:

| | Works now | Needs a domain |
|---|---|---|
| Order/inquiry notifications to you | ✅ | |
| Confirmation emails to customers | | ❌ silently undelivered |

The Worker already treats a failed customer confirmation as non-fatal — the
order still records, you still get notified, `200` still comes back. That makes
this a fine state for testing and a **bad state for taking real orders**: a
customer gets no receipt and no reference number.

**When you're ready to launch:** buy a domain (Cloudflare Registrar sells at
cost, roughly $5–10/year), point it at the Worker, verify it in Resend, then set
`FROM_EMAIL` to an address on it. That one purchase also unblocks section 4.

---

## 3. Supabase — the real (cloud) project

Section 1 gives you a *local* database. This gives you the one that survives a
reboot.

- [x] Project created — `https://sbwjvigwbenvqdseztop.supabase.co`
- [x] Linked, all four migrations pushed
- [x] Secret key written into `.dev.vars` (pulled via
      `npx supabase projects api-keys`, so it was never pasted anywhere)
- [x] 8 products seeded with their opening ledger entries. Verified on the cloud:
      ledger invariant holds for all 8, the publishable key reads 0 rows
      (RLS deny-all), `/api/products` returns 8 through the Worker, and
      `/admin/app.js` returns 401 from a non-localhost host.
- [x] `admin_accounts` migration pushed. Verified on the cloud: bootstrap Super
      Admin resolves with all 8 capabilities, an unknown email gets `403`
      (not the `503` it returned before the push), all four admin read endpoints
      answer `200`, and the publishable key reads 0 rows from `admin_accounts`.
- [ ] **Settings → Database → Backups** — confirm daily backups are on
- [ ] **Storage** — confirm the `product-images` bucket is **not** public

> The cloud database has only ever been **read** from. Every write path — POS
> sale, undo, stock adjust, inquiry — is proven against the local stack on the
> identical schema, but nothing has written to your real database, so there is no
> test data in it. Your first real order is the first cloud write.

> The `service_role` key bypasses every security rule in the database. It belongs
> in Worker secrets and nowhere else — never in a browser, a screenshot, or a
> chat message.

---

## 4. Sign-in — via OpenAI Sites

You deploy to a ChatGPT/Sites URL, so **the login already exists.** Sites
authenticates you and forwards a verified `oai-authenticated-user-email` header;
the Worker turns that into a role. Nobody writes or stores a password.

Signed out, a browser opening `/admin/` gets redirected to the Sites sign-in page
and returned afterwards. Verified end to end:

| Request | Signed out | Signed in as owner |
|---|---|---|
| browser `/admin/`, `/pos/` | `302` → `/signin-with-chatgpt?return_to=…` | `200` dashboard |
| `/api/admin/me` | `401` JSON — APIs never redirect to HTML | `200` `super_admin` |
| `/admin/app.js` | `401` — not downloadable | served |
| someone else's email | — | `403` refused |

### Three values to set on the deploy target

- [ ] `TRUST_SITES_AUTH=true`
- [ ] `SUPER_ADMIN_EMAILS=kvb.engo@gmail.com`
- [ ] `ADMIN_EMAILS=kvb.engo@gmail.com`

`TRUST_SITES_AUTH` is off by default and **must** ship together with the email
lists. Set alone, the Worker trusts whatever email arrives in that header.

> I could not find where the Sites pipeline exposes environment variables —
> `.openai/hosting.json` holds only a project id, and nothing else in the repo
> documents it. Set them wherever your deploy surface offers environment or
> secret configuration. `wrangler secret put` writes to Cloudflare, which is a
> different place, so it will not reach a Sites deployment.

### Two things to verify on the live URL, once

- [ ] **Signed out, open `/admin/app.js` directly.** It must return `401`, not the
      file. Static files are served *before* the Worker on Cloudflare, which is
      why `wrangler.toml` carries
      `run_worker_first = ["/admin", "/admin/*", "/pos", "/pos/*"]`. I could not
      confirm the Sites pipeline reads `wrangler.toml` at all — if that file
      downloads, the guard is not running and the console is public. Tell me and
      I will move the protection somewhere the pipeline honours.
- [ ] **Signed out, open `/admin/`.** It must bounce to the sign-in page, not show
      the dashboard.

### If you later move to your own domain

Cloudflare Access becomes available and is the stronger option — it authenticates
before a request ever reaches the Worker, instead of trusting a forwarded header.
The Worker already verifies Access JWT signatures; see the checklist below.

### `SUPER_ADMIN_EMAILS` — the account that bootstraps every other account

Codex's account system reads roles from the `admin_accounts` table, but that
table can't grant the *first* role. `SUPER_ADMIN_EMAILS` is matched before any
database lookup, so it always gets in.

- Local: already set in `.dev.vars` to `local@verre.test,kvb.engo@gmail.com`.
  It must contain `LOCAL_AUTH_EMAIL` or `/admin` returns `503`.
- Production: `npx wrangler secret put SUPER_ADMIN_EMAILS` with your real address.

### When you buy a domain, come back and do this

- [ ] Cloudflare dashboard → **Zero Trust → Access → Applications**
- [ ] Create **two** self-hosted applications:

| Application | Path | Session duration | Why |
|---|---|---|---|
| Verre Admin | `/admin/*` | 24 hours | Desk work, short session is fine |
| Verre POS | `/pos/*` | **30 days** | A market tablet cannot do an email round-trip on bad wifi |

- [ ] Policy on both: **Allow**, include → **Emails** → your email only
- [ ] Copy each application's **Application Audience (AUD) tag**
- [ ] Note your team domain — the full URL, e.g. `https://verre.cloudflareaccess.com`
- [ ] Set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `ADMIN_EMAILS`

> Two apps means two AUD tags. The Worker checks one `CF_ACCESS_AUD` — use the
> POS tag if you can only pick one, and tell Codex if you need both checked.

---

## 5. Set the secrets and deploy

Six secrets for now — the three Cloudflare Access values wait for section 4.

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put OWNER_EMAIL
npx wrangler secret put FROM_EMAIL
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SUPER_ADMIN_EMAILS
```

- [ ] All six set
- [ ] `npm run build && npx wrangler deploy`
- [ ] Optional caching — only if you want it:
      `npx wrangler kv namespace create CATALOG_CACHE` and the same for
      `DASHBOARD_CACHE`, then add the returned ids to `wrangler.toml`. The site
      runs fine without them.

### Three rules, no exceptions

- [ ] **`LOCAL_AUTH_BYPASS` never goes into production secrets.** It exists so
      `wrangler dev` works on your laptop. It is locked to `localhost`, but do not
      lean on that.
- [ ] **Never set `TRUST_SITES_AUTH=true` with `ADMIN_EMAILS` empty.** That
      combination accepts *any* email in a request header — it is an open door to
      `/admin`. If you set one, set both.
- [ ] **`.dev.vars` stays out of git.** It is already in `.gitignore`; leave it there.

---

## 6. Decisions that change the code

Answer these before more gets built — each one is cheap now and expensive later.

- [ ] **Do you actually ship nationwide?** The checkout offers Pickup in Cebu /
      Cebu delivery / Ship nationwide. If shipping isn't real, that option comes out.
- [ ] **Do you discount at markets?** Bundles like "3 stickers for ₱400" need
      per-line pricing. Only whole-order discounts exist today.
- [ ] **Consignment.** CR8 Cebu and Art Treats PH hold your stock. Should the
      system count that separately from what's in your hands? Skipping it means
      your stock numbers are knowingly wrong. Adding it later means a schema
      migration on live data.
- [ ] **Will anyone but you ever run the POS?** Designing for it now is nearly
      free; retrofitting it is not.
- [ ] **Which tablet or phone, and which browser**, for the POS? It decides how
      much the offline mode can rely on newer browser features.

---

## 7. Content only you can supply

- [ ] **Instagram and Facebook URLs.** The footer icons at `index.html:273` and
      `index.html:276` still point at `#top` — they go nowhere.
- [ ] **Is `@verrecrafts` the real handle?** It appears in the marquee
      (`index.html:246`) and has never been verified.
- [ ] **Is `hello@verrecrafts.ph` a real inbox?** It is baked into the footer at
      `index.html:279` and `index.html:283` as a `mailto:` link.
- [ ] **Approve or replace the product specs.** The dimensions, materials, care
      instructions and lead times were **invented to be plausible** — 4 mm glass,
      350 ml cup, 15–17 cm wrists. Read them once and correct anything wrong. A
      customer will hold you to them.
- [ ] **Real product photos.** The 16-image sprite atlas is placeholder art. Real
      per-product photos go in through `/admin` once section 3 is done.
- [ ] **Any past sales or stock worth importing?** A spreadsheet or a notebook —
      or does this start from zero?
- [ ] **How do you reconcile GCash?** Typed reference numbers, or is there a
      statement export worth matching against?

---

## 8. Tests only you can run

Nobody can fake these from a keyboard.

- [ ] **A real email arrives.** Submit all three forms on the deployed site —
      custom order, contact, cart checkout — and confirm both your copy and the
      customer confirmation land, and that hitting Reply reaches the customer.
- [ ] **A real market, offline.** Airplane mode on the actual POS device, ~30
      sales over a few hours, then reconnect and confirm the count and the money
      both match. This is the one most likely to surprise you.
- [ ] **A restore drill.** Actually restore a Supabase backup into a scratch
      project — `docs/runbook.md` has the steps. "Backups are enabled" is not the
      same as "a restore works", and you only find out the difference on the worst
      possible day.
- [ ] **Lock yourself out on purpose.** Open `https://<your>.workers.dev/admin`
      and `/pos/app.js` in a private window and confirm both return `401`. Do this
      again after Access is set up in section 4.

---

## Already done — don't redo these

Storefront cart, product detail modals and deep links · the inquiry/order email
endpoint with server-side pricing, validation, honeypot and rate limiting · the
database schema, stock ledger, idempotent sales and oversell handling · the admin
console · the offline POS · the operations runbook.

19 files are still uncommitted. Ask Claude or Codex to commit them in
phase-sized chunks when you're ready.
