import { db } from './client.js';
import { FALLBACK_PRODUCTS } from './fallback.js';

const PRODUCT_SELECT = '*,product_images(id,storage_path,alt,position)';
const encode = encodeURIComponent;

export async function listPublicProducts(env, includeArchivedSlug) {
  const client = db(env);
  if (!client.configured) return { data: FALLBACK_PRODUCTS, error: null, stale: true };
  const filter = includeArchivedSlug
    ? `or=(status.eq.active,slug.eq.${encode(includeArchivedSlug)})`
    : 'status=eq.active';
  const result = await client.rest('products', `select=${encode(PRODUCT_SELECT)}&${filter}&order=sort_order.asc`);
  if (result.error) return { data: FALLBACK_PRODUCTS, error: result.error, stale: true };
  return { data: await attachSignedImages(env, result.data), error: null, stale: false };
}

export async function listProducts(env, params = {}) {
  const query = [`select=${encode(PRODUCT_SELECT)}`];
  if (params.search) query.push(`or=(name.ilike.*${encode(params.search)}*,slug.ilike.*${encode(params.search)}*)`);
  if (params.category) query.push('category=eq.' + encode(params.category));
  if (params.status) query.push('status=eq.' + encode(params.status));
  query.push('order=' + (params.sort === 'stock' ? 'stock_on_hand.asc' : 'name.asc'));
  const result = await db(env).rest('products', query.join('&'));
  if (result.error) return result;
  return { data: await attachSignedImages(env, result.data), error: null };
}

export async function getProduct(env, id) {
  const result = await db(env).rest('products', `select=${encode(PRODUCT_SELECT)}&id=eq.${encode(id)}&limit=1`);
  return result.error ? result : { data: result.data?.[0] || null, error: null };
}

export async function saveProduct(env, product, actor) {
  const client = db(env);
  const id = product.id;
  const body = {
    slug: product.slug, name: product.name, category: product.category, tag: product.tag,
    price_cents: product.price_cents, status: product.status, low_stock_at: product.one_of_a_kind ? 0 : product.low_stock_at,
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

export async function hardDeleteProduct(env, id, actor) {
  const history = await db(env).rest('order_items', `select=id&product_id=eq.${encode(id)}&limit=1`);
  if (history.error) return history;
  if (history.data.length) return { data: null, error: { message: 'Archive products that have order history', code: 'HAS_HISTORY' } };
  const result = await db(env).rest('products', `id=eq.${encode(id)}`, { method: 'DELETE' });
  if (!result.error) await audit(env, actor, 'product.delete', id, {});
  return result;
}

export async function signUpload(env, productId, filename) {
  const safe = String(filename || 'image.webp').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  const path = `products/${productId}/${crypto.randomUUID()}-${safe.replace(/\.[^.]+$/, '')}.webp`;
  const result = await db(env).storage('object/upload/sign/product-images/' + path, { method: 'POST', body: '{}' });
  if (result.error) return result;
  const value = result.data.url || result.data.signedURL || result.data.signedUrl;
  const signedUrl = value?.startsWith('http')
    ? value
    : String(env.SUPABASE_URL).replace(/\/$/, '') + '/storage/v1' + value;
  return { data: { path, token: result.data.token, signedUrl }, error: null };
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
