import { db } from './client.js';

export const adjustStock = (env, body, actor) => db(env).rpc('adjust_stock', {
  p_product_id: body.product_id, p_delta: body.delta, p_reason: body.reason,
  p_note: body.note || null, p_actor: actor
});

export const listMovements = (env, params = {}) => {
  const query = ['select=*,products(name,slug)', 'order=created_at.desc', 'limit=500'];
  if (params.product_id) query.push('product_id=eq.' + encodeURIComponent(params.product_id));
  if (params.reason) query.push('reason=eq.' + encodeURIComponent(params.reason));
  if (params.from) query.push('created_at=gte.' + encodeURIComponent(params.from));
  if (params.to) query.push('created_at=lte.' + encodeURIComponent(params.to));
  return db(env).rest('stock_movements', query.join('&'));
};

export async function stocktake(env, counts, actor) {
  const products = await db(env).rest('products', 'select=id,name,stock_on_hand');
  if (products.error) return products;
  const byId = new Map(products.data.map((p) => [p.id, p]));
  const changes = [];
  for (const entry of counts || []) {
    const product = byId.get(entry.product_id);
    const counted = Number(entry.counted);
    if (!product || !Number.isInteger(counted) || counted < 0) {
      return { data: null, error: { message: 'Every physical count must be a non-negative whole number' } };
    }
    const delta = counted - product.stock_on_hand;
    if (delta) {
      const result = await adjustStock(env, { product_id: product.id, delta, reason: 'stocktake', note: entry.note || 'Physical stocktake' }, actor);
      if (result.error) return result;
      changes.push({ product_id: product.id, name: product.name, delta, stock_on_hand: result.data });
    }
  }
  return { data: changes, error: null };
}
