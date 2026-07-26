// node scripts/check-catalog.mjs
//
// Supabase is authoritative. The server-side fallback must stay aligned with
// seed.sql so a database outage never serves invented prices or slugs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FALLBACK_PRODUCTS } from '../src/db/fallback.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = await readFile(resolve(root, 'supabase', 'seed.sql'), 'utf8');
const rows = [...seed.matchAll(
  /\(\s*'([a-z0-9-]+)', '([^']*)', '(\w+)', '([^']*)', (\d+), '(\w+)', (\d+), (\d+), (true|false)/g
)].map((match) => ({
  slug: match[1],
  name: match[2],
  category: match[3],
  tag: match[4],
  priceCents: Number(match[5]),
  status: match[6],
  stock: Number(match[7]),
  lowStockAt: Number(match[8]),
  oneOfAKind: match[9] === 'true'
}));

assert.deepEqual(
  rows.map((row) => row.slug),
  FALLBACK_PRODUCTS.map((product) => product.slug),
  'seed.sql products differ from the last-known-good fallback'
);

for (const [index, product] of FALLBACK_PRODUCTS.entries()) {
  const row = rows[index];
  const where = product.slug + ': ';
  assert.equal(row.name, product.name, where + 'seed name');
  assert.equal(row.category, product.category, where + 'seed category');
  assert.equal(row.tag, product.tag, where + 'seed tag');
  assert.equal(row.priceCents, product.price_cents, where + 'seed price is centavos');
  assert.equal(row.stock, product.stock_on_hand, where + 'seed stock');
  assert.equal(row.oneOfAKind, product.category === 'glass', where + 'one_of_a_kind matches category');
  if (row.oneOfAKind) assert.equal(row.lowStockAt, 0, where + 'one_of_a_kind low_stock_at is 0');
}

console.log('ok — ' + FALLBACK_PRODUCTS.length + ' products consistent across seed.sql and the fallback snapshot');
