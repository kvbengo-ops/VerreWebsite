-- Newsletter list.
--
-- Small-batch stock sells out, so "tell me when the next drop lands" is the
-- most useful thing a visitor can leave behind. Kept deliberately separate from
-- `orders`: a subscriber is not a customer, and conflating the two is how
-- people end up marketing to someone who only ever asked a question.

-- pgcrypto lives in the `extensions` schema on Supabase, which is not on the
-- search_path during migrations. Every function from it must be schema
-- qualified. `gen_random_uuid()` below needs no prefix — that one is built into
-- Postgres 13+ and lives in pg_catalog, which is why it works and
-- `gen_random_bytes` does not.
create extension if not exists pgcrypto with schema extensions;

create table subscribers (
  id                uuid primary key default gen_random_uuid(),
  email             text unique not null check (
    email = lower(email)
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  -- Opaque, per-subscriber, and the only thing an unsubscribe link needs to
  -- carry. An unsubscribe URL that contains an email address lets anyone
  -- unsubscribe anyone, and leaks the address into every mail server it passes.
  unsubscribe_token text unique not null default encode(extensions.gen_random_bytes(24), 'hex'),
  source            text not null default 'storefront',
  confirmed_at      timestamptz,
  unsubscribed_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index subscribers_active_idx on subscribers(created_at desc) where unsubscribed_at is null;

alter table subscribers enable row level security;

create trigger subscribers_touch before update on subscribers
  for each row execute function touch_updated_at();

-- Idempotent by design.
--
-- Signing up twice is not an error — it is the single most common thing a
-- person does when they are not sure the first one worked. A duplicate simply
-- returns the existing row, and a previously unsubscribed address is quietly
-- reactivated rather than rejected with "you already exist", which would both
-- annoy the subscriber and confirm to a stranger that the address is on the
-- list.
create function subscribe(p_email text, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row subscribers%rowtype;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;

  insert into subscribers(email, source)
  values (v_email, coalesce(nullif(trim(p_source), ''), 'storefront'))
  on conflict (email) do update
    set unsubscribed_at = null,
        updated_at = now()
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'token', v_row.unsubscribe_token);
end;
$$;

-- Unsubscribing is never an error either. A token that is unknown, already
-- used, or mangled by an email client all produce the same calm answer, so the
-- endpoint cannot be used to test which tokens are real.
create function unsubscribe(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_email text;
begin
  update subscribers
  set unsubscribed_at = now()
  where unsubscribe_token = p_token and unsubscribed_at is null
  returning email into v_email;

  return jsonb_build_object('ok', true, 'removed', v_email is not null);
end;
$$;

grant all on subscribers to service_role;
grant execute on function subscribe(text, text) to service_role;
grant execute on function unsubscribe(text) to service_role;
revoke all on function subscribe(text, text) from public, anon, authenticated;
revoke all on function unsubscribe(text) from public, anon, authenticated;
