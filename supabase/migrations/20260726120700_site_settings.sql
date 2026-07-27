-- Single-row settings for the storefront.
--
-- A one-row table rather than a key/value store: there are a handful of these
-- and they are read on every page render, so one row and one round trip beats
-- a scan and a reshape. The check constraint is what keeps it to one row.
create table site_settings (
  id             boolean primary key default true check (id),
  -- null means "follow the calendar". A theme id forces that theme on;
  -- 'default' forces the everyday look even in December, which is the setting
  -- you want if a season lands badly against a particular collection.
  theme_override text,
  updated_by     text,
  updated_at     timestamptz not null default now()
);

insert into site_settings(id) values (true) on conflict do nothing;

alter table site_settings enable row level security;

create trigger site_settings_touch before update on site_settings
  for each row execute function touch_updated_at();

-- Upsert against the fixed primary key, so this can never create a second row
-- however it is called.
create function set_theme_override(p_theme text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row site_settings%rowtype;
begin
  update site_settings
  set theme_override = nullif(trim(coalesce(p_theme, '')), ''),
      updated_by = p_actor
  where id
  returning * into v_row;

  insert into admin_audit_log(actor, action, entity, entity_id, diff)
  values(p_actor, 'theme.set', 'site_settings', null,
         jsonb_build_object('theme_override', v_row.theme_override));

  return to_jsonb(v_row);
end;
$$;

grant all on site_settings to service_role;
grant execute on function set_theme_override(text, text) to service_role;
revoke all on function set_theme_override(text, text) from public, anon, authenticated;
