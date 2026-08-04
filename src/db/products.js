import { db } from './client.js';
import { FALLBACK_PRODUCTS } from './fallback.js';

const ADMIN_PRODUCT_SELECT = '*,product_images(id,storage_path,alt,position)';
// Buying cost is private operational data. Public storefront and POS responses
// use an allowlist so schema additions cannot leak cost_cents to customers.
const PUBLIC_PRODUCT_SELECT = [
  'id','slug','name','category','tag','price_cents','status','stock_on_hand',
  'low_stock_at','one_of_a_kind','blurb','description','dimensions','materials',
  'care','lead_time','bg_color','tape_color','sort_order',
  'product_images(id,storage_path,alt,position)'
].join(',');
const encode = encodeURIComponent;

export async function listPublicProducts(env, includeArchivedSlug) {
  const client = db(env);
  if (!client.configured) return { data: FALLBACK_PRODUCTS, error: null, stale: true };
  const filter = includeArchivedSlug
    ? `or=(status.eq.active,slug.eq.${encode(includeArchivedSlug)})`
    : 'status=eq.active';
  const result = await client.rest('products', `select=${encode(PUBLIC_PRODUCT_SELECT)}&${filter}&order=sort_order.asc`);
  // Once a real database is configured, the seed fallback is no longer a safe
  // last-known-good catalog: removed products may have changed since deploy.
  // The public route can still use its KV snapshot, but without one an empty
  // stale catalog is safer than silently republishing archived inventory.
  if (result.error) return { data: [], error: result.error, stale: true };
  return { data: await attachSignedImages(env, result.data), error: null, stale: false };
}

export async function listProducts(env, params = {}) {
  const query = [`select=${encode(ADMIN_PRODUCT_SELECT)}`];
  if (params.search) query.push(`or=(name.ilike.*${encode(params.search)}*,slug.ilike.*${encode(params.search)}*)`);
  if (params.category) query.push('category=eq.' + encode(params.category));
  if (params.status) query.push('status=eq.' + encode(params.status));
  else if (params.include_archived !== 'true') query.push('status=neq.archived');
  query.push('order=' + (params.sort === 'stock' ? 'stock_on_hand.asc' : 'name.asc'));
  const result = await db(env).rest('products', query.join('&'));
  if (result.error) return result;
  return { data: await attachSignedImages(env, result.data), error: null };
}

export async function getProduct(env, id) {
  const result = await db(env).rest('products', `select=${encode(ADMIN_PRODUCT_SELECT)}&id=eq.${encode(id)}&limit=1`);
  return result.error ? result : { data: result.data?.[0] || null, error: null };
}

export async function saveProduct(env, product, actor) {
  const client = db(env);
  const id = product.id;
  if (!Number.isInteger(product.cost_cents) || product.cost_cents < 0) {
    return { data: null, error: { message: 'Enter a valid product cost.', code: 'INVALID_PRODUCT_COST' } };
  }
  const body = {
    slug: product.slug, name: product.name, category: product.category, tag: product.tag,
    price_cents: product.price_cents, cost_cents: product.cost_cents,
    status: product.status, low_stock_at: product.one_of_a_kind ? 0 : product.low_stock_at,
    one_of_a_kind: Boolean(product.one_of_a_kind), blurb: product.blurb || null,
    description: product.description || null, dimensions: product.dimensions || null,
    materials: product.materials || null, care: product.care || null,
    lead_time: product.lead_time || null, bg_color: product.bg_color || '#FFE1EF',
    tape_color: product.tape_color || '#FFD166', sort_order: product.sort_order || 0
  };
  const result = id
    ? await client.rest('products', `id=eq.${encode(id)}&select=*`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(body) })
    : await client.rest('products', 'select=*', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(body) });
  if (!result.error) await audit(env, actor, id ? 'product.update' : 'product.create', result.data?.[0]?.id, body);
  return result.error ? result : { data: result.data?.[0], error: null };
}

export async function archiveProduct(env, id, actor) {
  const result = await db(env).rest('products', `id=eq.${encode(id)}&select=*`, {
    method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: 'archived' })
  });
  if (!result.error) await audit(env, actor, 'product.archive', id, { status: 'archived' });
  return result;
}

export async function publishProduct(env, id, actor) {
  const client = db(env);
  const product = await client.rest('products', `id=eq.${encode(id)}&select=id,cost_cents&limit=1`);
  if (product.error) return product;
  if (!product.data?.[0]) return { data: null, error: { message: 'Product not found', code: 'NOT_FOUND', status: 404 } };
  if (product.data[0].cost_cents == null) {
    return { data: null, error: { message: 'Add the product cost before publishing it to the shop.', code: 'COST_REQUIRED' } };
  }
  const result = await client.rest('products', `id=eq.${encode(id)}&select=*`, {
    method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: 'active' })
  });
  if (!result.error) await audit(env, actor, 'product.publish', id, { status: 'active' });
  return result;
}

export async function restoreProduct(env, id, actor) {
  const result = await db(env).rest('products', `id=eq.${encode(id)}&select=*`, {
    method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ status: 'draft' })
  });
  if (!result.error) await audit(env, actor, 'product.restore', id, { status: 'draft' });
  return result;
}

export async function productRemovalPlan(env, id) {
  const client = db(env);
  const [orderItems, stockMovements] = await Promise.all([
    client.rest('order_items', `select=id&product_id=eq.${encode(id)}&limit=1`),
    client.rest('stock_movements', `select=id&product_id=eq.${encode(id)}&limit=1`)
  ]);
  if (orderItems.error) return orderItems;
  if (stockMovements.error) return stockMovements;
  const orderHistory = Boolean(orderItems.data?.length);
  const stockHistory = Boolean(stockMovements.data?.length);
  return {
    data: {
      has_history: orderHistory || stockHistory,
      order_history: orderHistory,
      stock_history: stockHistory,
      removal: orderHistory || stockHistory ? 'archived' : 'deleted'
    },
    error: null
  };
}

export async function removeProduct(env, id, actor) {
  const client = db(env);
  const plan = await productRemovalPlan(env, id);
  if (plan.error) return plan;
  if (plan.data.has_history) {
    const archived = await archiveProduct(env, id, actor);
    return archived.error
      ? archived
      : { data: { ...(archived.data?.[0] || {}), removal: 'archived', has_history: true }, error: null };
  }
  const images = await client.rest('product_images', `select=storage_path&product_id=eq.${encode(id)}`);
  if (images.error) return images;
  const result = await client.rest('products', `id=eq.${encode(id)}`, { method: 'DELETE' });
  // A sale or stock movement can land after the preflight checks. The database
  // rejects that raced delete; archive on the same request instead.
  if (result.error?.code === '23503') {
    const archived = await archiveProduct(env, id, actor);
    return archived.error
      ? archived
      : { data: { ...(archived.data?.[0] || {}), removal: 'archived', has_history: true }, error: null };
  }
  if (!result.error) {
    // Product-image rows cascade with the product. Remove their private blobs
    // afterward; a cleanup failure must not resurrect the already-deleted row.
    for (const image of images.data || []) {
      const removed = await client.storage('object/product-images/' + image.storage_path, { method: 'DELETE' });
      if (removed.error) console.error('product delete: image cleanup failed — ' + removed.error.code);
    }
    await audit(env, actor, 'product.delete', id, { images_removed: (images.data || []).length });
  }
  return result.error ? result : { data: { removal: 'deleted', has_history: false }, error: null };
}

function productImagePath(productId, filename) {
  const safe = String(filename || 'image.webp').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  return `products/${productId}/${crypto.randomUUID()}-${safe.replace(/\.[^.]+$/, '')}.webp`;
}

export async function uploadProductImage(env, image, file, actor) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(image.product_id || '')) {
    return { data: null, error: { message: 'Unable to identify the product for this photo', code: 'INVALID_PRODUCT_ID' } };
  }
  if (!image.alt?.trim()) return { data: null, error: { message: 'Alt text is required', code: 'ALT_REQUIRED' } };
  if (!file?.byteLength) return { data: null, error: { message: 'The photo is empty', code: 'EMPTY_IMAGE' } };
  if (file.byteLength > 6 * 1024 * 1024) return { data: null, error: { message: 'The prepared photo is over 6 MB', code: 'IMAGE_TOO_LARGE' } };

  const client = db(env);
  const path = productImagePath(image.product_id, image.filename);
  const uploaded = await client.storage('object/product-images/' + path, {
    method: 'POST',
    headers: { 'content-type': 'image/webp', 'cache-control': 'max-age=3600', 'x-upsert': 'false' },
    body: file,
    timeoutMs: 30000
  });
  if (uploaded.error) return uploaded;

  const saved = await saveImage(env, {
    product_id: image.product_id,
    storage_path: path,
    alt: image.alt,
    position: Number.isInteger(image.position) ? image.position : 0
  }, actor);
  if (saved.error) {
    // Do not leave an untracked private blob if the metadata insert fails.
    await client.storage('object/product-images/' + path, { method: 'DELETE' });
  }
  return saved;
}

export async function saveImage(env, image, actor) {
  if (!image.alt?.trim()) return { data: null, error: { message: 'Alt text is required', code: 'ALT_REQUIRED' } };
  const result = await db(env).rest('product_images', 'select=*', {
    method: 'POST', headers: { prefer: 'return=representation' },
    body: JSON.stringify({ product_id: image.product_id, storage_path: image.storage_path, alt: image.alt.trim(), position: image.position || 0 })
  });
  if (!result.error) await audit(env, actor, 'product.image.add', image.product_id, image);
  return result;
}

export async function deleteImage(env, id, actor) {
  const client = db(env);
  const row = await client.rest('product_images', `select=*&id=eq.${encode(id)}&limit=1`);
  if (row.error || !row.data?.[0]) return row.error ? row : { data: null, error: { message: 'Image not found' } };
  const image = row.data[0];
  const removed = await client.storage('object/product-images/' + image.storage_path, { method: 'DELETE' });
  if (removed.error) return removed;
  const result = await client.rest('product_images', `id=eq.${encode(id)}`, { method: 'DELETE' });
  if (!result.error) await audit(env, actor, 'product.image.delete', image.product_id, { id });
  return result;
}

export async function reorderImages(env, productId, ids, actor) {
  for (const [position, id] of (ids || []).entries()) {
    const result = await db(env).rest('product_images', `id=eq.${encode(id)}&product_id=eq.${encode(productId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ position })
    });
    if (result.error) return result;
  }
  await audit(env, actor, 'product.image.reorder', productId, { ids });
  return { data: { ids }, error: null };
}

async function signedUrl(env, path) {
  const result = await db(env).storage('object/sign/product-images/' + path, { method: 'POST', body: JSON.stringify({ expiresIn: 3600 }) });
  if (result.error) return null;
  const value = result.data.signedURL || result.data.signedUrl || result.data.url;
  return value ? (value.startsWith('http') ? value : String(env.SUPABASE_URL).replace(/\/$/, '') + '/storage/v1' + value) : null;
}

async function attachSignedImages(env, products) {
  return Promise.all((products || []).map(async (product) => {
    const rows = (product.product_images || product.images || []).sort((a,b) => a.position - b.position);
    const images = await Promise.all(rows.map(async (image) => ({ ...image, url: await signedUrl(env, image.storage_path) })));
    return { ...product, images, atlas: product.sort_order, gallery: [product.sort_order, product.category === 'glass' ? 8 : product.category === 'charms' ? 9 : 10] };
  }));
}

async function audit(env, actor, action, entityId, diff) {
  await db(env).rest('admin_audit_log', '', {
    method: 'POST', body: JSON.stringify({ actor, action, entity: 'product', entity_id: entityId || null, diff })
  });
}
