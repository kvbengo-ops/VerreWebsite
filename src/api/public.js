import { listPublicProducts } from '../db/products.js';
import { getOrder } from '../db/orders.js';
import { json } from './http.js';

export async function publicProducts(request, env) {
  const rawSlug = new URL(request.url).searchParams.get('slug') || '';
  const requestedSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawSlug) ? rawSlug : '';
  const cacheKey = requestedSlug ? 'catalog:slug:' + requestedSlug : 'catalog:active';
  if (env.CATALOG_CACHE) {
    try {
      const cached = await env.CATALOG_CACHE.get(cacheKey, 'json');
      if (cached) return json(200, { ok:true, products:cached, stale:false }, { 'cache-control':'public,max-age=60', 'x-verre-cache':'hit' });
    } catch {}
  }
  const response = await listPublicProducts(env, requestedSlug || null);
  if (response.stale && env.CATALOG_CACHE) {
    try {
      const snapshot = await env.CATALOG_CACHE.get('catalog:snapshot', 'json');
      if (snapshot) response.data = snapshot;
    } catch {}
  }
  if (!response.stale && env.CATALOG_CACHE) {
    try {
      await env.CATALOG_CACHE.put(cacheKey, JSON.stringify(response.data), { expirationTtl:60 });
      if (!requestedSlug) await env.CATALOG_CACHE.put('catalog:snapshot', JSON.stringify(response.data));
    } catch {}
  }
  return json(200, { ok:true, products:response.data, stale:Boolean(response.stale) }, {
    'cache-control':'public,max-age=60', 'x-verre-catalog':response.stale ? 'last-known-good' : 'live'
  });
}

export async function receiptPage(env, ref) {
  const order = await getOrder(env, ref);
  if (order.error || !order.data) return new Response(receiptShell('Receipt unavailable', '<p>This receipt could not be found.</p>'), { status:404, headers:{'content-type':'text/html; charset=utf-8'} });
  const data = order.data;
  const lines = (data.order_items || []).map((item) =>
    `<tr><td>${escapeHtml(item.product_name)}</td><td>${item.qty}</td><td>${peso(item.line_total_cents)}</td></tr>`
  ).join('');
  const html = `<p class="tag">Digital receipt</p><h1>${escapeHtml(data.ref)}</h1>
    <p>${new Intl.DateTimeFormat('en-PH',{dateStyle:'long',timeStyle:'short',timeZone:'Asia/Manila'}).format(new Date(data.sold_at))}</p>
    <table><thead><tr><th>Piece</th><th>Qty</th><th>Total</th></tr></thead><tbody>${lines}</tbody></table>
    <div class="total"><span>Total</span><strong>${peso(data.total_cents)}</strong></div>
    <p>Paid by ${escapeHtml(data.payment_method)} · Made by hand in Cebu 💗</p>`;
  return new Response(receiptShell('Receipt ' + data.ref, html), { headers:{'content-type':'text/html; charset=utf-8','cache-control':'private,max-age=60'} });
}

const peso = (cents) => '₱' + (Number(cents || 0) / 100).toLocaleString('en-PH',{minimumFractionDigits:2});
const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const receiptShell = (title, content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} · Verre</title><style>body{margin:0;padding:32px 18px;background:#FFF6F0;color:#3A2430;font-family:system-ui,sans-serif}.card{max-width:560px;margin:auto;background:#fff;border-radius:28px;padding:28px;box-shadow:0 10px 0 rgba(239,64,86,.12)}h1{color:#EF4056}.tag{text-transform:uppercase;letter-spacing:.2em;color:#F157A8;font-size:11px;font-weight:700}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{text-align:left;padding:10px 4px;border-bottom:2px solid #FFE0EE}th:last-child,td:last-child{text-align:right}.total{display:flex;justify-content:space-between;font-size:22px}</style></head><body><main class="card">${content}</main></body></html>`;
