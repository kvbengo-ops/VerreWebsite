import assert from 'node:assert/strict';
import { listProducts, listPublicProducts, publishProduct, removeProduct, restoreProduct, saveProduct, uploadProductImage } from './db/products.js';

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
await listPublicProducts(env, 'sold-product');
assert.match(listUrls[0], /status=neq\.archived/, 'normal admin/inventory lists exclude archived products');
assert.doesNotMatch(listUrls[1], /status=(?:neq|eq)\.archived/, 'product management can explicitly include archived products');
assert.match(listUrls[2], /status=eq\.active/, 'the public catalog includes only active products');
assert.doesNotMatch(decodeURIComponent(listUrls[2]),/cost_cents/,'buying cost must not be exposed to storefront or POS clients');
assert.match(listUrls[3], /or=\(status\.eq\.active,slug\.eq\.sold-product\)/,
  'an archived deep link resolves without adding archived products to the normal catalog');

// Cost is required on admin saves and before a draft can be published.
let saveFetches=0;
globalThis.fetch=async()=>{saveFetches++;return response({})};
const missingCost=await saveProduct(env,{name:'No cost'},'owner@verre.test');
assert.equal(missingCost.error?.code,'INVALID_PRODUCT_COST');
assert.equal(saveFetches,0,'invalid cost is rejected before a database write');

const publishCalls=[];
globalThis.fetch=async (url,options={})=>{
  const path=new URL(url).pathname;
  publishCalls.push({path,method:options.method||'GET',body:options.body});
  if(path.endsWith('/products')&&(options.method||'GET')==='GET')return response([{id:'draft-product',cost_cents:12500}]);
  if(path.endsWith('/products'))return response([{id:'draft-product',status:'active',cost_cents:12500}]);
  return response({});
};
const published=await publishProduct(env,'draft-product','owner@verre.test');
assert.equal(published.error,null);
assert.deepEqual(JSON.parse(publishCalls.find(call=>call.path.endsWith('/products')&&call.method==='PATCH').body),{status:'active'});
assert.equal(JSON.parse(publishCalls.find(call=>call.path.endsWith('/admin_audit_log')).body).action,'product.publish');

// An uploaded image row must become the signed URL consumed by both the
// storefront and POS. This is the regression boundary for falling back to the
// built-in atlas even after a photo was saved successfully.
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/products')) return response([{
    id:'photo-product', slug:'photo-product', status:'active', sort_order:1,
    product_images:[{id:'photo-1',storage_path:'products/photo-product/front.webp',alt:'Front view',position:0}]
  }]);
  if (path.includes('/storage/v1/object/sign/product-images/')) {
    return response({ signedURL:'/object/sign/product-images/products/photo-product/front.webp?token=signed-test' });
  }
  return response({});
};
const catalogWithPhoto=await listPublicProducts(env);
assert.equal(catalogWithPhoto.error,null);
assert.equal(catalogWithPhoto.data[0].images[0].alt,'Front view');
assert.equal(catalogWithPhoto.data[0].images[0].url,
  'https://db.test/storage/v1/object/sign/product-images/products/photo-product/front.webp?token=signed-test');

// A configured database failure must not resurrect the old seeded catalog.
// Removed products are more important than a deceptively full fallback grid.
globalThis.fetch = async () => response({message:'database unavailable',code:'NETWORK'},503);
const unavailableCatalog=await listPublicProducts(env);
assert.equal(unavailableCatalog.stale,true);
assert.deepEqual(unavailableCatalog.data,[]);

const restoreCalls=[];
globalThis.fetch=async (url,options={})=>{
  const path=new URL(url).pathname;
  restoreCalls.push({path,method:options.method||'GET',body:options.body});
  if(path.endsWith('/products'))return response([{id:'archived-product',status:'draft'}]);
  return response({});
};
const restored=await restoreProduct(env,'archived-product','owner@verre.test');
assert.equal(restored.error,null);
assert.deepEqual(JSON.parse(restoreCalls.find(call=>call.path.endsWith('/products')).body),{status:'draft'});
assert.equal(JSON.parse(restoreCalls.find(call=>call.path.endsWith('/admin_audit_log')).body).action,'product.restore');

// Product photos travel through the authenticated Worker and are written with
// the service role. This avoids a fragile cross-origin browser upload while
// keeping the key out of the client.
const uploadCalls=[];
globalThis.fetch=async (url,options={})=>{
  const path=new URL(url).pathname;
  uploadCalls.push({path,method:options.method||'GET',headers:options.headers,body:options.body});
  if(path.includes('/storage/v1/object/product-images/'))return response({Key:'product-images/products/p1/photo.webp'});
  if(path.endsWith('/product_images'))return response([{id:'image-1',product_id:'p1'}]);
  if(path.endsWith('/admin_audit_log'))return response({});
  return response({});
};
const imageBytes=new Uint8Array([1,2,3]).buffer;
const productId='11111111-1111-4111-8111-111111111111';
const uploaded=await uploadProductImage(env,{product_id:productId,filename:'My Product Photo.JPG',alt:'Front view',position:2},imageBytes,'owner@verre.test');
assert.equal(uploaded.error,null);
const storageUpload=uploadCalls.find(call=>call.path.includes('/storage/v1/object/product-images/'));
assert.equal(storageUpload.method,'POST');
assert.equal(storageUpload.body,imageBytes,'the prepared WebP bytes reach Supabase unchanged');
assert.equal(storageUpload.headers['content-type'],'image/webp');
assert.match(storageUpload.path,/\/storage\/v1\/object\/product-images\/products\/11111111-1111-4111-8111-111111111111\/.+\.webp$/);
const imageRow=uploadCalls.find(call=>call.path.endsWith('/product_images'));
assert.equal(JSON.parse(imageRow.body).alt,'Front view');
assert.equal(JSON.parse(imageRow.body).position,2);

globalThis.fetch = realFetch;
console.log('ok — product removal archives history, preserves photos, and only deletes history-free products');
