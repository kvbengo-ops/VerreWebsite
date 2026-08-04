import { themedPage } from './theme.js';
import { listPublicProducts } from '../db/products.js';
import { robotsText, sitemapXml } from '../seo.js';

const text = (body, type, cache = 'public, max-age=300') => new Response(body, {
  headers: {
    'content-type': type,
    'cache-control': cache,
    'x-content-type-options': 'nosniff'
  }
});

export const robots = (request, env) =>
  text(robotsText(request, env), 'text/plain; charset=utf-8', 'public, max-age=3600');

export async function sitemap(request, env) {
  const catalog = await listPublicProducts(env);
  if (catalog.error) {
    return new Response('Catalog temporarily unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '300', 'cache-control': 'no-store' }
    });
  }
  return text(sitemapXml(request, env, catalog.data), 'application/xml; charset=utf-8');
}

export async function productPage(request, env, slug) {
  const catalog = await listPublicProducts(env, slug);
  if (catalog.error) {
    return new Response('The shop is temporarily unavailable. Please try again shortly.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' }
    });
  }
  const product = (catalog.data || []).find((entry) => entry.slug === slug);
  return themedPage(request, env, product
    ? { product, assetPath: '/' }
    : { noindex: true, assetPath: '/', status: 404 });
}

export async function productImage(_request, env, imageId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(imageId)) {
    return new Response('Not found', { status: 404 });
  }
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return new Response('Not found', { status: 404 });

  const rowResponse = await fetch(
    base + '/rest/v1/product_images?select=storage_path&id=eq.' + encodeURIComponent(imageId) + '&limit=1',
    { headers: { apikey: key, authorization: 'Bearer ' + key } }
  );
  if (!rowResponse.ok) return new Response('Image temporarily unavailable', { status: 503 });
  const rows = await rowResponse.json();
  if (!rows[0]?.storage_path) return new Response('Not found', { status: 404 });

  const storageResponse = await fetch(
    base + '/storage/v1/object/product-images/' + rows[0].storage_path,
    { headers: { apikey: key, authorization: 'Bearer ' + key } }
  );
  if (!storageResponse.ok) return new Response('Not found', { status: storageResponse.status === 404 ? 404 : 503 });
  const headers = new Headers();
  headers.set('content-type', storageResponse.headers.get('content-type') || 'image/webp');
  headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
  headers.set('x-content-type-options', 'nosniff');
  const etag = storageResponse.headers.get('etag');
  if (etag) headers.set('etag', etag);
  return new Response(storageResponse.body, { status: 200, headers });
}
