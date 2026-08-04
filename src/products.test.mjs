import assert from 'node:assert/strict';
import { listProducts, listPublicProducts, removeProduct } from './db/products.js';

const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-test' };
const realFetch = globalThis.fetch;
const response = (data, status = 200) => new Response(data == null ? null : JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' }
});

// A product with no historical references can still be physically removed,
// including its private image blobs.
const deleteCalls = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  deleteCalls.push({ path, method: options.method || 'GET', body: options.body });
  if (path.endsWith('/order_items') || path.endsWith('/stock_movements')) return response([]);
  if (path.endsWith('/product_images')) return response([
    { storage_path: 'products/p1/front.webp' },
    { storage_path: 'products/p1/back.webp' }
  ]);
  if (path.endsWith('/products')) return response(null, 204);
  if (path.includes('/storage/v1/object/product-images/')) return response({});
  if (path.endsWith('/admin_audit_log')) return response({});
  return response({});
};

const removed = await removeProduct(env, 'p1', 'owner@verre.test');
assert.equal(removed.error, null);
assert.equal(removed.data.removal, 'deleted');
assert.ok(deleteCalls.some((call) => call.path.endsWith('/products') && call.method === 'DELETE'), 'a history-free product is deleted');
assert.equal(deleteCalls.filter((call) => call.path.includes('/storage/v1/object/product-images/')).length, 2,
  'permanent deletion cleans up private product images');
const deleteAudit = deleteCalls.find((call) => call.path.endsWith('/admin_audit_log'));
assert.ok(deleteAudit && JSON.parse(deleteAudit.body).action === 'product.delete', 'permanent deletion is audited');

// Order lines represent both web orders and POS sales. Either kind of line
// makes removal an archive operation, preserving the product and its photos.
const orderHistoryCalls = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  orderHistoryCalls.push({ path, method: options.method || 'GET', body: options.body });
  if (path.endsWith('/order_items')) return response([{ id: 'line-1' }]);
  if (path.endsWith('/stock_movements')) return response([]);
  if (path.endsWith('/products')) return response([{ id: 'sold-product', status: 'archived' }]);
  if (path.endsWith('/admin_audit_log')) return response({});
  return response({});
};

const soldProduct = await removeProduct(env, 'sold-product', 'owner@verre.test');
assert.equal(soldProduct.error, null);
assert.equal(soldProduct.data.removal, 'archived');
const orderArchive = orderHistoryCalls.find((call) => call.path.endsWith('/products'));
assert.equal(orderArchive.method, 'PATCH');
assert.deepEqual(JSON.parse(orderArchive.body), { status: 'archived' });
assert.ok(!orderHistoryCalls.some((call) => call.path.endsWith('/product_images')), 'archiving does not read or delete product photos');
assert.ok(!orderHistoryCalls.some((call) => call.path.includes('/storage/')), 'archiving leaves private image blobs untouched');

// Stock history alone receives the same protection, even without an order.
const stockHistoryCalls = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  stockHistoryCalls.push({ path, method: options.method || 'GET', body: options.body });
  if (path.endsWith('/order_items')) return response([]);
  if (path.endsWith('/stock_movements')) return response([{ id: 'movement-1' }]);
  if (path.endsWith('/products')) return response([{ id: 'stocked-product', status: 'archived' }]);
  if (path.endsWith('/admin_audit_log')) return response({});
  return response({});
};

const stockedProduct = await removeProduct(env, 'stocked-product', 'owner@verre.test');
assert.equal(stockedProduct.error, null);
assert.equal(stockedProduct.data.removal, 'archived');
assert.equal(stockHistoryCalls.find((call) => call.path.endsWith('/products')).method, 'PATCH');

// Archived products stay manageable from the Products page but are absent from
// the storefront and the normal inventory feed.
const listUrls = [];
globalThis.fetch = async (url) => {
  listUrls.push(String(url));
  return response([]);
};
await listProducts(env);
await listProducts(env, { include_archived: 'true' });
await listPublicProducts(env);
assert.match(listUrls[0], /status=neq\.archived/, 'normal admin/inventory lists exclude archived products');
assert.doesNotMatch(listUrls[1], /status=(?:neq|eq)\.archived/, 'product management can explicitly include archived products');
assert.match(listUrls[2], /status=eq\.active/, 'the public catalog includes only active products');

globalThis.fetch = realFetch;
console.log('ok — product removal archives history, preserves photos, and only deletes history-free products');
