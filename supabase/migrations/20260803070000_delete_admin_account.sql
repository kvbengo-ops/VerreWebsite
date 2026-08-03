-- Permanently remove a staff account without allowing an administrator to
-- delete themselves or race two requests into removing the final Super Admin.
-- Sessions and password-reset links follow through their ON DELETE CASCADE
-- foreign keys; the audit record deliberately remains.
create function delete_admin_account(
  p_id uuid,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account admin_accounts%rowtype;
begin
  select * into v_account
  from admin_accounts
  where id = p_id
  for update;

  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;

  if lower(v_account.email) = lower(trim(p_actor)) then
    raise exception 'You cannot delete your own account' using errcode = '23514';
  end if;

  if v_account.active
     and v_account.role = 'super_admin'
     and (select count(*) from admin_accounts where active and role = 'super_admin') <= 1 then
    raise exception 'Keep at least one active database Super Admin' using errcode = '23514';
  end if;

  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values(
    p_actor,
    'account.delete',
    'admin_account',
    v_account.id,
    jsonb_build_object(
      'email', v_account.email,
      'display_name', v_account.display_name,
      'role', v_account.role,
      'active', v_account.active
    )
  );

  delete from admin_accounts where id = v_account.id;

  return jsonb_build_object(
    'id', v_account.id,
    'email', v_account.email,
    'display_name', v_account.display_name,
    'role', v_account.role,
    'active', v_account.active
  );
end;
$$;

grant execute on function delete_admin_account(uuid, text) to service_role;
revoke all on function delete_admin_account(uuid, text) from public, anon, authenticated;
