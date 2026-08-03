-- Storefront market dates managed from the Super Admin CMS.
create table site_markets (
  id            uuid primary key default gen_random_uuid(),
  event_date    date not null,
  name          text not null check (char_length(trim(name)) between 1 and 100),
  venue         text not null check (char_length(trim(venue)) between 1 and 160),
  color         text not null default '#F157A8' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order    integer not null default 0,
  is_published  boolean not null default true,
  created_by    text not null,
  updated_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index site_markets_public_idx
  on site_markets(is_published, sort_order, event_date);

create trigger site_markets_touch before update on site_markets
  for each row execute function touch_updated_at();

alter table site_markets enable row level security;

-- Preserve the dates that were previously hard-coded on the storefront.
insert into site_markets(event_date,name,venue,color,sort_order,created_by,updated_by) values
  ('2026-08-09','Sugbo Artist Alley','Robinsons Galleria Cebu','#F157A8',0,'migration','migration'),
  ('2026-08-23','Handmade Sunday','The Outpost, Lahug','#7ED3F2',1,'migration','migration'),
  ('2026-09-06','Cebu Craft Fair','Ayala Central Bloc Atrium','#FFD166',2,'migration','migration'),
  ('2026-09-27','Tiny Things Market','Talamban Times Square','#EF4056',3,'migration','migration');

grant all on site_markets to service_role;
