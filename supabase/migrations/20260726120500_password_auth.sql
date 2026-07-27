-- Password authentication owned by Verre.
--
-- Hashing runs HERE, in Postgres, not in the Worker. Cloudflare's free plan
-- allows roughly 10ms of CPU per request and bcrypt at a safe cost factor needs
-- far more than that. The tempting workaround is to weaken the hash until it
-- fits the budget, which makes it cheap for an attacker too. Postgres has no
-- such ceiling, so the expensive comparison happens on the database and the
-- Worker only ever learns yes or no.
create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────────────────────────────────────────
-- Account columns
-- ─────────────────────────────────────────────────────────────
-- password_hash stays nullable: SUPER_ADMIN_EMAILS grants a role, but an
-- account with no hash can never sign in. Being on the list is authorization,
-- not authentication.
alter table admin_accounts
  add column if not exists password_hash    text,
  add column if not exists password_set_at  timestamptz,
  add column if not exists failed_attempts  integer not null default 0,
  add column if not exists locked_until     timestamptz,
  add column if not exists last_login_at    timestamptz;

-- ─────────────────────────────────────────────────────────────
-- Sessions
-- ─────────────────────────────────────────────────────────────
-- token_hash, never the token. A database dump must not hand somebody a set of
-- live cookies — it should hand them a set of useless digests.
create table admin_sessions (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references admin_accounts(id) on delete cascade,
  token_hash  text not null unique,
  user_agent  text,
  ip          text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index admin_sessions_account_idx on admin_sessions(account_id) where revoked_at is null;
create index admin_sessions_expiry_idx on admin_sessions(expires_at);

create table password_resets (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references admin_accounts(id) on delete cascade,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index password_resets_account_idx on password_resets(account_id);

alter table admin_sessions enable row level security;
alter table password_resets enable row level security;

-- ─────────────────────────────────────────────────────────────
-- Password verification
-- ─────────────────────────────────────────────────────────────
-- Returns the account as jsonb on success, or a reason code on failure.
--
-- Three behaviours matter more than they look:
--   1. An unknown email still runs a crypt() against a dummy hash, so the
--      response time cannot be used to enumerate accounts.
--   2. Lockout is evaluated before the comparison and reported as a distinct
--      code, but the API layer flattens every failure into one message. The
--      distinction exists for the audit log, not for the caller.
--   3. The counter resets only on success, so five wrong guesses spread across
--      an hour still lock the account.
create or replace function verify_password(p_email text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account admin_accounts%rowtype;
  v_email text := lower(trim(coalesce(p_email, '')));
  -- bcrypt hash of a value nobody will guess. Only ever used to burn the same
  -- CPU time an existing account would have cost.
  v_dummy text := '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7Xr7QzTKUqIhqHf.pQ6Y0y8OcqYzZ3W';
  v_locked boolean := false;
begin
  select * into v_account
  from admin_accounts
  where email = v_email and active
  for update;

  if not found or v_account.password_hash is null then
    perform extensions.crypt(coalesce(p_password, ''), v_dummy);
    return jsonb_build_object('ok', false, 'reason', 'INVALID');
  end if;

  if v_account.locked_until is not null and v_account.locked_until > now() then
    v_locked := true;
  end if;

  if v_account.password_hash = extensions.crypt(coalesce(p_password, ''), v_account.password_hash) then
    if v_locked then
      return jsonb_build_object('ok', false, 'reason', 'LOCKED');
    end if;
    update admin_accounts
    set failed_attempts = 0, locked_until = null, last_login_at = now()
    where id = v_account.id;
    return jsonb_build_object(
      'ok', true,
      'account', jsonb_build_object(
        'id', v_account.id,
        'email', v_account.email,
        'display_name', v_account.display_name,
        'role', v_account.role
      )
    );
  end if;

  -- Escalating lockout. Five wrong guesses buys 15 minutes; it doubles from
  -- there so a patient script gets slower, not just briefly inconvenienced.
  update admin_accounts
  set failed_attempts = failed_attempts + 1,
      locked_until = case
        when failed_attempts + 1 >= 5
        then now() + (interval '15 minutes' * power(2, least((failed_attempts + 1 - 5) / 5, 4)))
        else locked_until
      end
  where id = v_account.id;

  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values(v_email, 'auth.login_failed', 'admin_account', v_account.id,
         jsonb_build_object('failed_attempts', v_account.failed_attempts + 1));

  return jsonb_build_object('ok', false, 'reason', case when v_locked then 'LOCKED' else 'INVALID' end);
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Password setting
-- ─────────────────────────────────────────────────────────────
-- Cost factor 12. Raise it when the database can absorb it; never lower it.
create or replace function set_password(
  p_account_id uuid,
  p_password text,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_account admin_accounts%rowtype;
begin
  if char_length(coalesce(p_password, '')) < 12 then
    raise exception 'Password must be at least 12 characters' using errcode = '22023';
  end if;

  update admin_accounts
  set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
      password_set_at = now(),
      failed_attempts = 0,
      locked_until = null
  where id = p_account_id
  returning * into v_account;

  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;

  -- A password change is a revocation event. Anything already signed in with
  -- the old credential loses its session; the caller re-issues its own.
  update admin_sessions
  set revoked_at = now()
  where account_id = p_account_id and revoked_at is null;

  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values(coalesce(p_actor, v_account.email), 'auth.password_set', 'admin_account', v_account.id, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'account_id', v_account.id);
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Session lookup
-- ─────────────────────────────────────────────────────────────
-- One round trip: validate the digest, check expiry and revocation, confirm the
-- account is still active, and return the identity. Doing this as three
-- separate REST reads would leave gaps where a revoked session still resolves.
create or replace function session_identity(p_token_hash text)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'session_id', s.id,
    'account_id', a.id,
    'email', a.email,
    'display_name', a.display_name,
    'role', a.role,
    'expires_at', s.expires_at
  )
  from admin_sessions s
  join admin_accounts a on a.id = s.account_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > now()
    and a.active
  limit 1;
$$;

-- Housekeeping. Expired rows are dead weight and, for resets, a liability.
create or replace function purge_expired_auth()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  delete from admin_sessions where expires_at < now() - interval '7 days';
  get diagnostics v_count = row_count;
  delete from password_resets where expires_at < now() - interval '7 days';
  return v_count;
end;
$$;

grant all on admin_sessions, password_resets to service_role;
grant execute on function verify_password(text, text) to service_role;
grant execute on function set_password(uuid, text, text) to service_role;
grant execute on function session_identity(text) to service_role;
grant execute on function purge_expired_auth() to service_role;
revoke all on function verify_password(text, text) from public, anon, authenticated;
revoke all on function set_password(uuid, text, text) from public, anon, authenticated;
revoke all on function session_identity(text) from public, anon, authenticated;
revoke all on function purge_expired_auth() from public, anon, authenticated;
