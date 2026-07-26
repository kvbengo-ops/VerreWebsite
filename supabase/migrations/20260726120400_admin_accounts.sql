-- Application roles are separate from Cloudflare Access authentication.
-- Access proves the email; this table decides what that email may do.
create type admin_role as enum ('super_admin', 'general_admin', 'cashier');

create table admin_accounts (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null check (
    email = lower(email)
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  display_name text not null check (char_length(display_name) between 1 and 100),
  role        admin_role not null,
  active      boolean not null default true,
  created_by  text not null,
  updated_by  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index admin_accounts_role_active_idx on admin_accounts(role, active);

create trigger admin_accounts_touch before update on admin_accounts
  for each row execute function touch_updated_at();

alter table admin_accounts enable row level security;

-- One transaction handles create/edit/deactivate and prevents accidentally
-- removing the last database-managed Super Admin.
create function set_admin_account(
  p_id uuid,
  p_email text,
  p_display_name text,
  p_role admin_role,
  p_active boolean,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account admin_accounts%rowtype;
  v_email text := lower(trim(p_email));
  v_name text := trim(p_display_name);
begin
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 100 then
    raise exception 'Display name must be 1 to 100 characters' using errcode = '22023';
  end if;

  if p_id is null then
    insert into admin_accounts(email, display_name, role, active, created_by, updated_by)
    values(v_email, v_name, p_role, coalesce(p_active, true), p_actor, p_actor)
    returning * into v_account;
  else
    select * into v_account from admin_accounts where id = p_id for update;
    if not found then
      raise exception 'Account not found' using errcode = 'P0002';
    end if;

    if v_account.active and v_account.role = 'super_admin'
       and (not coalesce(p_active, false) or p_role <> 'super_admin')
       and (select count(*) from admin_accounts where active and role = 'super_admin') <= 1 then
      raise exception 'Keep at least one active database Super Admin' using errcode = '23514';
    end if;

    update admin_accounts
    set email = v_email,
        display_name = v_name,
        role = p_role,
        active = coalesce(p_active, false),
        updated_by = p_actor
    where id = p_id
    returning * into v_account;
  end if;

  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values(
    p_actor,
    case when p_id is null then 'account.create' else 'account.update' end,
    'admin_account',
    v_account.id,
    jsonb_build_object(
      'email', v_account.email,
      'display_name', v_account.display_name,
      'role', v_account.role,
      'active', v_account.active
    )
  );

  return to_jsonb(v_account);
end;
$$;

grant all on admin_accounts to service_role;
grant execute on function set_admin_account(uuid, text, text, admin_role, boolean, text) to service_role;
revoke all on function set_admin_account(uuid, text, text, admin_role, boolean, text) from public, anon, authenticated;
