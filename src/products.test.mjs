import assert from 'node:assert/strict';
import { hardDeleteProduct } from './db/products.js';

const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-test' };
const realFetch = globalThis.fetch;
const calls = [];

globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  calls.push({ path, method: options.method || 'GET', body: options.body });
  const ok = (data, status = 200) => new Response(data == null ? null : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
  if (path.endsWith('/order_items')) return ok([]);
  if (path.endsWith('/product_images')) return ok([{ storage_path: 'products/p1/front.webp' }, { storage_path: 'products/p1/back.webp' }]);
  if (path.endsWith('/products')) return ok(null, 204);
  if (path.includes('/storage/v1/object/product-images/')) return ok({});
  if (path.endsWith('/admin_audit_log')) return ok({});
  return ok({});
};

const removed = await hardDeleteProduct(env, 'p1', 'owner@verre.test');
assert.equal(removed.error, null);
assert.ok(calls.some((call) => call.path.endsWith('/products') && call.method === 'DELETE'), 'the product row is deleted');
assert.equal(calls.filter((call) => call.path.includes('/storage/v1/object/product-images/')).length, 2,
  'private product-image files are cleaned up too');
const audit = calls.find((call) => call.path.endsWith('/admin_audit_log'));
assert.ok(audit && JSON.parse(audit.body).action === 'product.delete', 'permanent deletion is audited');

let historyCalls = 0;
globalThis.fetch = async (url) => {
  historyCalls++;
  assert.ok(new URL(url).pathname.endsWith('/order_items'));
  return new Response(JSON.stringify([{ id: 'line-1' }]), { headers: { 'content-type': 'application/json' } });
};
const protectedProduct = await hardDeleteProduct(env, 'sold-product', 'owner@verre.test');
assert.equal(protectedProduct.error?.code, 'HAS_HISTORY');
assert.equal(historyCalls, 1, 'a sold product is refused before any delete or storage call');

globalThis.fetch = realFetch;
console.log('ok — permanent product deletion preserves sales history and cleans private images');
