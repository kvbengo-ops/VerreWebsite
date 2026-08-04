# Deploying Verre

Target: **your own Cloudflare account**, via `wrangler deploy`.

`.dev.vars` is gitignored and only ever read by `wrangler dev`. A deployed Worker
sees none of it — which is why a fresh deploy has no database, no email and no
admin access until the steps below are done. Nothing is wrong; the secrets have
simply never been given to it.

---

## 0. You are currently on Cloudflare Pages. Move off it.

`verrewebsite.pages.dev` is a **Pages** project. Pages serves `dist/client` as
static files and never executes `dist/server/index.js`, so:

- every `/api/*` route 404s — which is why the login page reports "the server
  returned an unreadable response". It asked for JSON and got a 404 HTML page.
- the storefront is undressed, because the season is injected by the Worker.
- there is no database and no backend, because nothing server-side runs at all.

Nothing in the code is wrong. It is deployed to the wrong product. This repo is
a **Worker with an assets binding**: `wrangler.toml`, the `ASSETS` binding and
`run_worker_first` are all Workers-specific.

Delete the Pages project once the Worker is live, so there is no second URL
serving a broken copy.

---

## 1. Connect the repo to Workers Builds

Cloudflare dashboard → **Workers & Pages → Create → Workers → Connect to Git**,
pick `kvbengo-ops/VerreWebsite`, then set:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

Every push to the default branch builds and deploys. `wrangler.toml` at the repo
root supplies the rest.

Two repo-side details this needs, both already handled:

- **`package-lock.json` is committed.** Cloudflare runs `npm ci`, which fails
  without a lockfile even though this project has zero dependencies.
- **`dist/` stays gitignored.** The build produces it on Cloudflare's side;
  committing build output is how a stale bundle gets deployed over a fresh one.

To deploy from your machine instead:

```bash
npm run deploy
```

The first deploy publishes to `https://verre.<your-subdomain>.workers.dev`.
`workers_dev = true` in `wrangler.toml` is what makes that possible before you
own a domain.

---

## 2. Secrets

Set once, stored encrypted by Cloudflare, never in git:

Secrets are **per Worker, not per repo**. Setting them in the old Pages project
does nothing for this one.

Either through the dashboard (Worker → Settings → Variables and Secrets), or:

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put SUPER_ADMIN_EMAILS       # kvb.engo@gmail.com
wrangler secret put RESEND_API_KEY
wrangler secret put OWNER_EMAIL              # where enquiries land
wrangler secret put FROM_EMAIL               # e.g. Verre <hello@verrecrafts.ph>
```

**`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security.** It must never
appear in `[vars]`, in `wrangler.toml`, or anywhere a build could put it in
front of a browser. `wrangler secret put` only.

`SUPER_ADMIN_EMAILS` grants the Super Admin role, but an account with no
password hash still cannot sign in — being on that list is authorization, not
authentication. Create the account itself with:

```bash
npm run create-admin
```

Point it at the cloud project (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` in
your shell or `.dev.vars`), not a local Supabase.

---

## 3. Database

```bash
supabase link --project-ref <ref>   # the ref is inside your SUPABASE_URL
supabase db push
```

Migrations are append-only. Never edit one that has been applied — add a new
one.

---

## 4. KV (optional, recommended)

```bash
wrangler kv namespace create AUTH_LIMITS
wrangler kv namespace create CATALOG_CACHE
wrangler kv namespace create DASHBOARD_CACHE
```

Paste each printed id into the commented `[[kv_namespaces]]` blocks in
`wrangler.toml` and uncomment them.

The site runs without these — it just reads Supabase more often. **`AUTH_LIMITS`
is the one that matters:** without it, login rate limiting falls back to an
in-memory map that resets whenever Cloudflare recycles the isolate. Fine for a
contact form, not for a password gate.

---

## 5. What a missing domain still blocks

You said none is registered yet. Two things stay broken until one is:

- **Outbound email.** Resend will only send from a verified domain. Until then
  you can use `onboarding@resend.dev` as `FROM_EMAIL`, but it can *only* deliver
  to the address you signed up with. That means order confirmations, customer
  replies and password-reset links do not reach real customers.
- **Password reset.** It emails a link. With no working sender, the recovery
  path is `npm run create-admin` from a terminal. Worth knowing before you lock
  yourself out, not after.

Everything else — storefront, cart, admin, POS, themes, the newsletter list —
works on `workers.dev` today.

---

## 6. When the domain arrives

1. Add it to Cloudflare and point its nameservers there.
2. Add a route in `wrangler.toml`, then `wrangler deploy`.
3. Set `workers_dev = false` and redeploy.
4. Verify the domain in Resend and set `FROM_EMAIL` to an address on it.
5. Optional: put Cloudflare Access in front of `/admin/*` as a second layer.
   `src/auth.js` already verifies Access JWTs properly and costs nothing while
   unconfigured.

---

## Checklist

- [ ] Workers Builds connected to the repo, or `npm run deploy` run locally
- [ ] Old Pages project deleted
- [ ] Six secrets set
- [ ] `supabase db push`
- [ ] `npm run create-admin`, then sign in at `/login`
- [ ] KV namespaces created and bound (at least `AUTH_LIMITS`)
- [ ] Confirm `/admin` returns the login page, not the dashboard, in a private window
- [ ] Confirm the built bundle contains no secret:
      `grep -r "SUPABASE_SERVICE_ROLE_KEY\|sb_secret" dist/client` returns nothing
- [ ] Confirm the Worker is actually running: view source on the homepage and
      look for `window.__VERRE_THEME__`. If it is missing, you are being served
      static files and the backend is not executing — the exact symptom the
      Pages deploy had.
