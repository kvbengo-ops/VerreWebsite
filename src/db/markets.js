import { db } from './client.js';

const encode = encodeURIComponent;
const COLORS = ['#F157A8', '#7ED3F2', '#FFD166', '#EF4056'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const FALLBACK_MARKETS = [
  { event_date: '2026-08-09', name: 'Sugbo Artist Alley', venue: 'Robinsons Galleria Cebu', color: COLORS[0], sort_order: 0, is_published: true },
  { event_date: '2026-08-23', name: 'Handmade Sunday', venue: 'The Outpost, Lahug', color: COLORS[1], sort_order: 1, is_published: true },
  { event_date: '2026-09-06', name: 'Cebu Craft Fair', venue: 'Ayala Central Bloc Atrium', color: COLORS[2], sort_order: 2, is_published: true },
  { event_date: '2026-09-27', name: 'Tiny Things Market', venue: 'Talamban Times Square', color: COLORS[3], sort_order: 3, is_published: true }
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function manilaToday(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function publicMarket(row) {
  const [year, month, day] = String(row.event_date).slice(0, 10).split('-').map(Number);
  return {
    id: row.id,
    day: String(day).padStart(2, '0'),
    month: MONTHS[month - 1] || '',
    name: row.name,
    place: row.venue,
    bg: row.color,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}

export function validateMarket(input) {
  const event_date = String(input?.event_date || '').trim();
  const name = String(input?.name || '').trim();
  const venue = String(input?.venue || '').trim();
  const color = String(input?.color || COLORS[0]).trim().toUpperCase();
  const [year, month, day] = event_date.split('-').map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  const validDate = DATE_RE.test(event_date) && parsedDate.getUTCFullYear() === year && parsedDate.getUTCMonth() === month - 1 && parsedDate.getUTCDate() === day;
  if (!validDate) return { error: 'Choose a valid market date.', field: 'event_date' };
  if (!name || name.length > 100) return { error: 'Market name must be 1 to 100 characters.', field: 'name' };
  if (!venue || venue.length > 160) return { error: 'Venue must be 1 to 160 characters.', field: 'venue' };
  if (!COLOR_RE.test(color)) return { error: 'Choose a valid card color.', field: 'color' };
  return {
    data: {
      event_date, name, venue, color,
      sort_order: Number.isInteger(Number(input.sort_order)) ? Number(input.sort_order) : 0,
      is_published: input.is_published !== false
    }
  };
}

export async function listPublicMarkets(env, now = new Date()) {
  const client = db(env);
  const today = manilaToday(now);
  if (!client.configured) {
    return { data: FALLBACK_MARKETS.filter((row) => row.event_date >= today).map(publicMarket), error: null, stale: true };
  }
  const result = await client.rest(
    'site_markets',
    `select=id,event_date,name,venue,color,sort_order&is_published=eq.true&event_date=gte.${today}&order=sort_order.asc,event_date.asc`
  );
  if (result.error) {
    console.error('markets: public read failed — ' + result.error.code);
    return { data: FALLBACK_MARKETS.filter((row) => row.event_date >= today).map(publicMarket), error: result.error, stale: true };
  }
  return { data: (result.data || []).map(publicMarket), error: null, stale: false };
}

export const listMarkets = (env) => db(env).rest(
  'site_markets',
  'select=id,event_date,name,venue,color,sort_order,is_published,created_at,updated_at&order=sort_order.asc,event_date.asc'
);

export async function saveMarket(env, input, actor) {
  const parsed = validateMarket(input);
  if (parsed.error) return { data: null, error: { message: parsed.error, code: 'INVALID_MARKET', field: parsed.field } };
  const id = input.id;
  const payload = { ...parsed.data, updated_by: actor, ...(!id && { created_by: actor }) };
  const result = await db(env).rest(
    'site_markets',
    (id ? `id=eq.${encode(id)}&` : '') + 'select=*',
    { method: id ? 'PATCH' : 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(payload) }
  );
  if (!result.error) await audit(env, actor, id ? 'market.update' : 'market.create', result.data?.[0]?.id, payload);
  return result.error ? result : { data: result.data?.[0] || null, error: null };
}

export async function deleteMarket(env, id, actor) {
  const result = await db(env).rest('site_markets', `id=eq.${encode(id)}`, { method: 'DELETE' });
  if (!result.error) await audit(env, actor, 'market.delete', id, {});
  return result;
}

export async function reorderMarkets(env, ids, actor) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !id.trim())) {
    return { data: null, error: { message: 'Expected an ordered list of market IDs.', code: 'INVALID_ORDER' } };
  }
  for (const [sort_order, id] of ids.entries()) {
    const result = await db(env).rest('site_markets', `id=eq.${encode(id)}`, {
      method: 'PATCH', body: JSON.stringify({ sort_order, updated_by: actor })
    });
    if (result.error) return result;
  }
  await audit(env, actor, 'market.reorder', null, { ids });
  return { data: { ids }, error: null };
}

const audit = (env, actor, action, entityId, diff) => db(env).rest('admin_audit_log', '', {
  method: 'POST', body: JSON.stringify({ actor, action, entity: 'site_market', entity_id: entityId, diff })
});

export const _test = { manilaToday, COLORS, MONTHS };
