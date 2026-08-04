import assert from 'node:assert/strict';
import { listPublicMarkets, publicMarket, reorderMarkets, validateMarket } from './db/markets.js';

const valid = validateMarket({
  event_date: '2026-08-09',
  name: '  Sugbo Artist Alley  ',
  venue: ' Robinsons Galleria Cebu ',
  color: '#f157a8',
  is_published: true,
  sort_order: '2'
});
assert.equal(valid.error, undefined);
assert.deepEqual(valid.data, {
  event_date: '2026-08-09',
  name: 'Sugbo Artist Alley',
  venue: 'Robinsons Galleria Cebu',
  color: '#F157A8',
  is_published: true,
  sort_order: 2
});
assert.equal(validateMarket({ event_date: '2026-02-30', name: 'Impossible', venue: 'Cebu' }).field, 'event_date',
  'calendar rollovers are not valid market dates');
assert.equal(validateMarket({ event_date: '2026-08-09', name: '', venue: 'Cebu' }).field, 'name');
assert.equal(validateMarket({ event_date: '2026-08-09', name: 'Market', venue: 'Cebu', color: 'pink' }).field, 'color');

assert.deepEqual(publicMarket({
  id: 'market-1', event_date: '2026-09-06', name: 'Cebu Craft Fair', venue: 'Ayala Central Bloc', color: '#FFD166'
}), {
  id: 'market-1', day: '06', month: 'Sep', name: 'Cebu Craft Fair', place: 'Ayala Central Bloc', bg: '#FFD166', date: '2026-09-06'
});

const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-test' };
const realFetch = globalThis.fetch;
let requested = '';
globalThis.fetch = async (url) => {
  requested = String(url);
  return new Response(JSON.stringify([{
    id: 'market-2', event_date: '2026-08-23', name: 'Handmade Sunday', venue: 'The Outpost, Lahug', color: '#7ED3F2', sort_order: 1
  }]), { headers: { 'content-type': 'application/json' } });
};
const publicList = await listPublicMarkets(env, new Date('2026-08-03T00:00:00Z'));
assert.equal(publicList.error, null);
assert.equal(publicList.data[0].day, '23');
assert.match(requested, /is_published=eq\.true/);
assert.match(requested, /event_date=gte\.2026-08-03/);

let fetches = 0;
globalThis.fetch = async () => { fetches++; return new Response('{}'); };
const duplicateOrder = await reorderMarkets(env, ['same-id', 'same-id'], 'owner@verre.test');
assert.equal(duplicateOrder.error?.code, 'INVALID_ORDER');
assert.equal(fetches, 0, 'an invalid reorder never reaches the database');

globalThis.fetch = realFetch;
console.log('ok — market CMS validates dates, filters public entries, and shapes storefront cards');
