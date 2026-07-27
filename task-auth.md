# Verre — Build Plan: Real Login

**Status:** ready to start — **do this before any further admin work**
**Implementer:** Codex
**Author of spec:** Claude
**Supersedes:** `task-admin.md` Phase 2 (Cloudflare Access)

---

## 0. Why this exists

`/admin` and `/pos` currently have no login of their own. Identity comes from whatever is in front of the Worker — a hosting dispatcher's `oai-authenticated-user-email` header, or a `localhost` dev bypass. That was fine as scaffolding and is not fine as a product.

A hostname-pinning fix landed in `src/auth.js` and closed the immediate hole (an unsigned header was being trusted on any hostname, including the un-fronted `*.workers.dev` origin). **That fix is a stopgap.** It makes the header safe *given* a correctly configured dispatcher; it does not give Verre an authentication system it owns.

### Decisions (settled — do not re-litigate)

| Question | Answer |
|----------|--------|
| Who signs in | **Kyle only, for now.** Keep the existing `super_admin` / `general_admin` / `cashier` roles in `src/roles.js` — do not delete them — but build no invite flow, no user-management UI. |
| Mechanism | **Email + password, built in-house.** A real `/login` page. |
| Session length | **24 hours, fixed.** Not sliding. |
| Hosting dependency | **None.** Must work on any host, with no domain on Cloudflare and no ChatGPT session. |

### Consequences to accept

You are taking ownership of password storage, session lifecycle, brute-force resistance, and account recovery. That is a real burden and the reason the original spec reached for Cloudflare Access. It is the right trade here — it removes the dependency on a specific host and works for cashiers later — but it means the checklist in §7 is not optional polish. It *is* the feature.

---

## 1. The one hard constraint: CPU time

A proper password hash is deliberately slow. **Cloudflare Workers on the free plan allow ~10ms CPU per request.** PBKDF2 at OWASP's recommended 600,000 iterations costs well over 100ms of CPU. Hashing in the Worker will fail, and the tempting fix — dropping the iteration count until it fits — produces a hash that is fast for an attacker too. That is worse than useless: it looks like security and isn't.

**So hash in Postgres, not in the Worker.**

Supabase ships `pgcrypto`. bcrypt runs inside a `security definer` Postgres function; the Worker passes the candidate password through and receives a boolean. The expensive work happens on the database's CPU, which has no 10ms ceiling.

```sql
create extension if not exists pgcrypto;

-- Verify. Returns the account row on success, NULL on failure.
-- Always runs a hash comparison, even for a non-existent email, so response
-- time does not reveal whether an account exists.
create function verify_password(p_email text, p_password text)
returns admin_accounts
language plpgsql security definer set search_path = public, extensions
as $$ /* … */ $$;

-- Set/change. Cost factor 12.
create function set_password(p_account_id uuid, p_password text)
returns void
language plpgsql security definer set search_path = public, extensions
as $$ /* crypt(p_password, gen_salt('bf', 12)) */ $$;
```

**Caveat that must be handled, not just noted:** the plaintext password crosses into Postgres as a query parameter. Confirm Supabase statement logging (`log_statement`, `log_min_duration_statement`) will not capture parameter values for these calls, and document the finding in `README.md`. Never build these calls by string interpolation — parameterized only, always.

**If bcrypt-in-Postgres proves unworkable,** the fallback is PBKDF2-SHA256 in the Worker at ≥600k iterations *on the Workers Paid plan* (30s CPU). Do not implement the fallback at a reduced iteration count.

---

## 2. Schema

New migration. `admin_accounts` already exists (see `src/db/accounts.js`) — extend it.

```sql
alter table admin_accounts
  add column password_hash        text,
  add column password_set_at      timestamptz,
  add column failed_attempts      integer not null default 0,
  add column locked_until         timestamptz,
  add column last_login_at        timestamptz;

create table admin_sessions (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references admin_accounts(id) on delete cascade,
  token_hash   text not null unique,   -- SHA-256 of the cookie value. NEVER the token itself.
  user_agent   text,
  ip           text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index on admin_sessions (account_id) where revoked_at is null;
create index on admin_sessions (expires_at);

create table password_resets (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references admin_accounts(id) on delete cascade,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
```

- [ ] RLS enabled with deny-all on both new tables, consistent with §2.2 of `task-admin.md`
- [ ] **Store `token_hash`, never the raw token.** A leaked database dump must not hand over live sessions.
- [ ] Scheduled Worker (or a `pg_cron` job) purges expired sessions and resets daily

---

## 3. Endpoints

All under `/api/auth/`. All `POST` except where noted. All rate limited.

| Route | Behaviour |
|-------|-----------|
| `POST /api/auth/login` | `{email, password}` → sets session cookie, returns `{ok:true, user}` |
| `POST /api/auth/logout` | Revokes the current session, clears the cookie |
| `POST /api/auth/logout-all` | Revokes every session for the account |
| `GET  /api/auth/me` | Current user or `401` |
| `POST /api/auth/request-reset` | `{email}` → emails a link via Resend. **Always returns `200`,** whether or not the account exists |
| `POST /api/auth/reset` | `{token, password}` → sets the password, revokes all sessions |
| `POST /api/auth/change-password` | Authenticated. Requires the current password. Revokes all *other* sessions |

### Cookie

```
Set-Cookie: verre_session=<32 random bytes, base64url>;
  HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400
```

- [ ] `Secure` is omitted **only** on `http://localhost`, never on a deployed host
- [ ] Token generated with `crypto.getRandomValues`, never `Math.random`
- [ ] **Rotate the token on every successful login** — prevents session fixation
- [ ] Cookie value is compared by hashing and looking up `token_hash`; comparisons of any secret use the existing `constantTimeEqual` in `src/auth.js`

---

## 4. Brute force & enumeration

The two ways a homegrown login usually fails.

- [ ] **Per-account lockout:** 5 consecutive failures → `locked_until = now() + 15 min`, escalating on repeat. Reset the counter on success.
- [ ] **Per-IP limit:** 10 login attempts per 15 minutes. Reuse the pattern in `src/worker.js`, but the existing in-memory `Map` resets on isolate recycling — **for login, back this with KV or a Durable Object.** Best-effort is acceptable for the contact form; it is not acceptable for a password gate.
- [ ] **One generic error for every failure:** *"That email or password is not right."* Never distinguish unknown-email from wrong-password, and never leak lockout state to an unauthenticated caller.
- [ ] `verify_password` runs a hash comparison even when the email does not exist, so timing does not reveal account existence (§1)
- [ ] Reset requests return `200` regardless — a reset endpoint is an enumeration oracle otherwise
- [ ] Log failures with email and IP for review; **never log passwords, tokens, or hashes**

---

## 5. Login page

New `login/index.html`, served publicly. Match the storefront's visual language — same palette, `Shrikhand` heading, pill buttons — but calm and centred.

- [ ] Email + password, `autocomplete="username"` / `"current-password"` so password managers work
- [ ] Real `<form>` with a submit button; works without JS if practical
- [ ] Loading state on submit, disabled button, no double-submit
- [ ] Error message rendered inline, `role="alert"`, focus moved to it
- [ ] "Forgot password" link → request-reset form → confirmation copy that reveals nothing
- [ ] Reset page at `/login/reset?token=…` with password + confirmation, and a visible strength minimum (≥12 characters; check against a short list of obvious passwords, do not impose character-class rules)
- [ ] After login, redirect to the originally requested path — **validated by the existing `safeReturn` helper in `src/worker.js`**, which already rejects `//evil.com`. Reuse it; do not write a second one.
- [ ] Keyboard accessible, visible focus ring, sensible on mobile

---

## 6. Wiring into the Worker

- [ ] `authenticate()` in `src/auth.js` gains a **session-cookie branch, tried first**
- [ ] `/admin/*`, `/pos/*`, `/api/admin/*`, `/api/pos/*` redirect browsers to `/login?return_to=…` and return `401` JSON to fetch/XHR (branch on `Accept` or `Sec-Fetch-Mode`)
- [ ] `run_worker_first` in `wrangler.toml` already covers the shells — **verify `/login` is *not* in that list** or the login page gates itself behind login
- [ ] `admin_audit_log` records `auth.login`, `auth.logout`, `auth.password_change`, `auth.lockout`

### Retiring the old paths

- [ ] **Delete the `TRUST_SITES_AUTH` branch and all its settings** (`SITES_HOSTNAME`, `SITES_SHARED_SECRET`) once cookie login works end to end. Do not leave it as a fallback — a disabled auth path is a re-enabled auth path in six months.
- [ ] `LOCAL_AUTH_BYPASS` **stays**, unchanged, still hostname-gated. It is genuinely useful and cannot work on a deployed host.
- [ ] Cloudflare Access support in `src/auth.js` **stays**. It is correctly implemented, costs nothing when unconfigured, and layering it in front later is real defence in depth.
- [ ] Update `README.md` and `.dev.vars.example`; remove the settings that no longer exist

### First account

- [ ] `npm run create-admin` — a Node script prompting for email and password, calling `set_password`. Not an HTTP endpoint.
- [ ] `SUPER_ADMIN_EMAILS` continues to grant the role, but **a matching email with no `password_hash` cannot sign in.** Being on the list is authorization, not authentication.

---

## 7. Verification

Not optional. This is the feature.

### Authentication
- [ ] Correct credentials → session cookie → `/admin` loads
- [ ] Wrong password, unknown email, and locked account are **indistinguishable** in body, status, and timing
- [ ] Session expires at 24h and does not slide
- [ ] Logout revokes server-side — replaying the captured cookie afterwards fails
- [ ] Logout-all kills other browsers
- [ ] Password change revokes other sessions but keeps the current one
- [ ] Reset link is single-use and expires in 1 hour
- [ ] Reset revokes all existing sessions

### Attack surface
- [ ] 6 wrong passwords → locked; correct password during lockout still fails
- [ ] 11 attempts from one IP → `429`, surviving an isolate restart
- [ ] Cookie is `HttpOnly` — unreadable from `document.cookie`
- [ ] Cookie is `Secure` + `SameSite=Lax` on a deployed host
- [ ] `return_to=//evil.com`, `https://evil.com`, and `javascript:` all fall back to `/`
- [ ] No password, token, or hash appears in any log line or error response
- [ ] Password hash never leaves the database — grep every API response shape
- [ ] Session token in the DB is a hash, not the cookie value
- [ ] Direct `GET /admin/app.js` unauthenticated → `401`, not source code

### Regression
- [ ] Existing `src/*.test.mjs` still pass
- [ ] Storefront, `/api/inquiry`, and `/api/products` remain fully public and unaffected
- [ ] `npm run build` clean

---

## 8. Out of scope

Cashier PINs and device enrolment · OAuth/social login · 2FA · magic links · invite flows · a user-management UI · "remember this device".

Several become relevant the moment a second person runs the POS. The schema above already accommodates them — `admin_sessions` is per-account and roles already exist — so none of this needs redoing then.

---

## 9. Open questions for Kyle

1. **Resend readiness** — password reset needs working outbound email. Is the sending domain verified yet, or does reset ship behind `create-admin` for now?
2. **Workers plan** — free or paid? Determines whether the §1 fallback is even available.
3. **Lockout recovery** — if you lock yourself out with no verified email domain, the only way back in is `create-admin` from a terminal. Acceptable, or should there be a break-glass path?
