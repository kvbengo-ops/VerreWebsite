-- Release-critical launch data and idempotent offline POS sessions.

alter table pos_sessions add column if not exists client_uuid uuid;
alter table pos_sessions add column if not exists operator_email text;
create unique index if not exists pos_sessions_client_uuid_key
  on pos_sessions (client_uuid) where client_uuid is not null;

create or replace function open_pos_session(
  p_client_uuid uuid,
  p_label text,
  p_device_label text,
  p_opening_float_cents integer,
  p_opened_at timestamptz,
  p_operator_email text
) returns pos_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare result pos_sessions;
begin
  if p_client_uuid is null or nullif(trim(p_label), '') is null then
    raise exception 'session id and label are required' using errcode = '22023';
  end if;
  if coalesce(p_opening_float_cents, 0) < 0 then
    raise exception 'opening float cannot be negative' using errcode = '22023';
  end if;

  insert into pos_sessions (
    client_uuid, label, device_label, opening_float_cents, opened_at, operator_email
  ) values (
    p_client_uuid, trim(p_label), nullif(trim(p_device_label), ''),
    coalesce(p_opening_float_cents, 0), coalesce(p_opened_at, now()), lower(trim(p_operator_email))
  )
  on conflict (client_uuid) where client_uuid is not null do nothing;

  select * into result from pos_sessions where client_uuid = p_client_uuid;
  if result.operator_email is distinct from lower(trim(p_operator_email)) then
    raise exception 'session belongs to another operator' using errcode = '42501';
  end if;
  return result;
end;
$$;

create or replace function close_pos_session(
  p_client_uuid uuid,
  p_closing_cash_cents integer,
  p_closed_at timestamptz,
  p_operator_email text
) returns pos_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare result pos_sessions;
begin
  if p_closing_cash_cents is null or p_closing_cash_cents < 0 then
    raise exception 'closing cash cannot be negative' using errcode = '22023';
  end if;
  select * into result from pos_sessions where client_uuid = p_client_uuid for update;
  if not found then
    raise exception 'session not found' using errcode = '23503';
  end if;
  if result.operator_email is distinct from lower(trim(p_operator_email)) then
    raise exception 'session belongs to another operator' using errcode = '42501';
  end if;
  if result.closed_at is null then
    update pos_sessions
       set closing_cash_cents = p_closing_cash_cents,
           closed_at = coalesce(p_closed_at, now())
     where id = result.id
     returning * into result;
  end if;
  return result;
end;
$$;

revoke all on function open_pos_session(uuid,text,text,integer,timestamptz,text) from public, anon, authenticated;
revoke all on function close_pos_session(uuid,integer,timestamptz,text) from public, anon, authenticated;
grant execute on function open_pos_session(uuid,text,text,integer,timestamptz,text) to service_role;
grant execute on function close_pos_session(uuid,integer,timestamptz,text) to service_role;

-- Seed missing launch products without overwriting any catalog edits already
-- made by the owner. Costs remain intentionally unset until the owner records
-- real material and packaging costs; readiness will continue to fail until then.
insert into products (
  slug, name, category, tag, price_cents, status, stock_on_hand, low_stock_at,
  one_of_a_kind, blurb, description, dimensions, materials, care, lead_time,
  bg_color, tape_color, sort_order
) values
('peach-sky-glass-panel','Peach Sky Glass Panel','glass','Glass painting',85000,'active',1,0,true,'A pocket-size sunset painted one soft layer at a time.','A dreamy peach-and-blue sky painted in reverse on a clear glass panel.','12 x 12 cm','Reverse-painted acrylic on tempered glass','Wipe with a dry cloth. Do not submerge.','Ships in 2-3 days','#FFD9EC','#FFD166',0),
('star-cookie-charm','Star Cookie Charm','charms','Keychain',28000,'active',4,2,false,'A sprinkle-bright star for keys, bags, and little adventures.','A hand-assembled star charm inspired by iced sugar cookies.','Approx. 11 cm long','Resin charm, glass and acrylic beads','Keep dry and avoid perfume or alcohol.','Ships in 2-3 days','#DFF4FE','#7ED3F2',1),
('cloud-bead-bracelet','Cloud Bead Bracelet','charms','Accessory',32000,'active',3,2,false,'Pastel beads and a tiny cloud for soft-sky days.','A hand-knotted stretch bracelet with milky glass and pastel beads.','Fits wrists 15-17 cm','Glass and acrylic beads, elastic cord','Roll on and off instead of stretching.','Ships in 2-3 days','#FFE1EF','#FFB6D9',2),
('sweetheart-sticker-pack','Sweetheart Sticker Pack','stickers','6 die-cuts',18000,'active',8,2,false,'Six glossy little love notes for journals and gadgets.','Six hand-drawn hearts, ribbons, and candy-bright doodles.','6 die-cuts','Gloss-laminated waterproof vinyl','Apply to a clean, dry surface.','Ships in 1-2 days','#FFF0C7','#FFD166',3),
('little-daisy-glass-cup','Little Daisy Glass Cup','glass','Glass painting',62000,'active',1,0,true,'A garden of tiny daisies wrapped around your favorite drink.','A clear tumbler dotted with individually painted daisies.','350 ml','Soda-lime glass and cured glass paint','Hand-wash gently. Do not soak.','Ships in 3-4 days','#F3FBE7','#FFB6D9',4),
('sparkle-phone-charm','Sparkle Phone Charm','charms','Accessory',26000,'active',5,2,false,'A candy-colored wrist loop with just enough sparkle.','A lightweight phone charm with translucent stars and pearly beads.','Approx. 18 cm loop','Acrylic and glass beads, nylon cord','Keep dry and avoid sharp pulls.','Ships in 2-3 days','#EDE3FF','#7ED3F2',5),
('cloud-nine-vinyl-sheet','Cloud Nine Vinyl Sheet','stickers','Sticker sheet',15000,'active',0,2,false,'Tiny clouds, stars, and daydreams on one cheerful sheet.','A kiss-cut sheet filled with clouds, stars, and sky-day doodles.','10 x 15 cm sheet','Gloss-laminated waterproof vinyl','Apply to a clean, dry surface.','Ships in 1-2 days','#E7F7FF','#EF4056',6),
('cherry-red-mini-frame','Cherry Red Mini Frame','glass','Glass painting',54000,'active',1,0,true,'A bright pair of cherries framed for the smallest happy corner.','Two glossy red cherries reverse-painted onto glass.','9 x 11 cm framed','Reverse-painted glass and sealed frame','Dust with a soft dry cloth.','Ships in 2-3 days','#FFDCD9','#FFD166',7)
on conflict (slug) do nothing;

insert into stock_movements (product_id, delta, reason, note, created_by)
select p.id, p.stock_on_hand, 'initial', 'Launch-readiness seed', 'migration'
from products p
where p.slug in (
  'peach-sky-glass-panel','star-cookie-charm','cloud-bead-bracelet','sweetheart-sticker-pack',
  'little-daisy-glass-cup','sparkle-phone-charm','cloud-nine-vinyl-sheet','cherry-red-mini-frame'
)
and p.stock_on_hand > 0
and not exists (select 1 from stock_movements m where m.product_id = p.id);

insert into custom_option_groups (key,label,helper,step,input_kind,required) values
('base','What should I make?','Every commission starts here.',1,'single',true),
('size','How big?','Choose the closest size.',2,'single',true),
('design','What look are you after?','Choose a palette and finish.',3,'single',true),
('brief','Tell me about it','Share the subject and details.',4,'text',true)
on conflict (key) do nothing;

insert into custom_options (group_id,key,label,description,price_delta_cents,lead_time_days,swatch,sort_order)
select g.id,v.key,v.label,v.description,v.price,v.lead,v.swatch,v.sort
from custom_option_groups g cross join (values
('glass-panel','Hand-painted glass panel','A framed painted-glass piece.',120000,21,'#7ED3F2',1),
('charm-set','Beaded charm or keyring','Made to your colors.',45000,10,'#FFB6D9',2),
('sticker-set','Custom sticker sheet','Die-cut and weatherproof.',35000,14,'#FFD166',3)
) v(key,label,description,price,lead,swatch,sort)
where g.key='base'
on conflict (group_id,key) do nothing;

insert into custom_options (group_id,key,label,description,price_delta_cents,lead_time_days,swatch,sort_order,parent_option_id)
select g.id,v.key,v.label,v.description,v.price,v.lead,v.swatch,v.sort,p.id
from custom_option_groups g
cross join (values
('small','Small - about A5','Fits a shelf or desk.',0,0,'#FFE0EE',1,'glass-panel'),
('medium','Medium - about A4','The most popular size.',45000,7,'#FFD1E8',2,'glass-panel'),
('large','Large - about A3','A wall piece.',110000,14,'#FFB6D9',3,'glass-panel'),
('single','A single charm','One piece, one clasp.',0,0,'#FFE0EE',1,'charm-set'),
('trio','A set of three','Matching or three variations.',28000,5,'#FFD1E8',2,'charm-set'),
('a6','A6 sheet','Six to eight die-cuts.',0,0,'#FFE0EE',1,'sticker-set'),
('a5','A5 sheet','Twelve to sixteen die-cuts.',18000,3,'#FFD1E8',2,'sticker-set')
) v(key,label,description,price,lead,swatch,sort,parent_key)
join custom_options p on p.key=v.parent_key
join custom_option_groups pg on pg.id=p.group_id and pg.key='base'
where g.key='size'
on conflict (group_id,key) do nothing;

insert into custom_options (group_id,key,label,description,price_delta_cents,lead_time_days,swatch,sort_order)
select g.id,v.key,v.label,v.description,v.price,v.lead,v.swatch,v.sort
from custom_option_groups g cross join (values
('soft-pastel','Soft pastels','Peach, pink and cream.',0,0,'#FFD9EC',1),
('bright-pop','Bright and poppy','High contrast and saturated.',0,0,'#FFD166',2),
('cool-glass','Cool and glassy','Blues and clear space.',0,0,'#7ED3F2',3),
('metallic','With metallic leaf','Gold or copper leaf.',35000,7,'#E7C089',4)
) v(key,label,description,price,lead,swatch,sort)
where g.key='design'
on conflict (group_id,key) do nothing;
