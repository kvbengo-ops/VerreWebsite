import { db } from './client.js';

export const createInquiry = (env, ref, payload) => db(env).rpc('create_inquiry', {
  p_ref: ref, p_type: payload.type, p_items: payload.items || [],
  p_customer: { name: payload.name, email: payload.email, phone: payload.phone, fulfillment: payload.fulfillment, message: payload.message }
});

export function listOrders(env, params = {}) {
  const query = ['select=*,order_items(*)', 'order=created_at.desc', 'limit=300'];
  if (params.status) query.push('status=eq.' + encodeURIComponent(params.status));
  if (params.channel) query.push('channel=eq.' + encodeURIComponent(params.channel));
  if (params.from) query.push('created_at=gte.' + encodeURIComponent(params.from));
  if (params.to) query.push('created_at=lte.' + encodeURIComponent(params.to));
  if (params.search) query.push('or=(ref.ilike.*' + encodeURIComponent(params.search) + '*,customer_name.ilike.*' + encodeURIComponent(params.search) + '*,customer_email.ilike.*' + encodeURIComponent(params.search) + '*)');
  return db(env).rest('orders', query.join('&'));
}

export async function getOrder(env, idOrRef) {
  const field = String(idOrRef).startsWith('VR-') ? 'ref' : 'id';
  const result = await db(env).rest('orders', `select=*,order_items(*)&${field}=eq.${encodeURIComponent(idOrRef)}&limit=1`);
  return result.error ? result : { data: result.data?.[0] || null, error: null };
}

export const setOrderStatus = (env, id, status, payment, actor, note) => db(env).rpc('set_order_status', {
  p_order_id: id, p_status: status, p_payment: payment || null, p_actor: actor, p_note: note || null
});

export const recordSale = (env, sale, actor) => db(env).rpc('record_sale', {
  p_client_uuid: sale.client_uuid, p_channel: 'pos',
  p_items: sale.items.map((item) => ({ product_id: item.product_id, qty: item.qty })),
  p_sold_at: sale.sold_at, p_payment: sale.payment_method,
  p_tendered_cents: sale.tendered_cents ?? null, p_session_id: sale.session_id || null,
  p_customer: {
    name: sale.customer_name || null, email: sale.customer_email || null,
    fulfillment: 'in_person', note: sale.note || null,
    discount_cents: sale.discount_cents || 0,
    discount_reason: sale.discount_reason || null,
    gcash_reference: sale.gcash_reference || null
  },
  p_actor: actor
});

export const voidSale = (env, clientUuid, actor) => db(env).rpc('void_pos_sale', {
  p_client_uuid: clientUuid,
  p_actor: actor
});

export async function syncSales(env, sales, actor) {
  const results = [];
  for (const sale of sales || []) {
    const result = await recordSale(env, sale, actor);
    results.push(result.error
      ? { client_uuid: sale.client_uuid, ok: false, error: result.error.message, permanent: ['22023','23503'].includes(result.error.code) }
      : { client_uuid: sale.client_uuid, ok: true, order: result.data, oversell: Boolean(result.data?.is_oversell) });
  }
  return { data: results, error: null };
}

export async function listSessions(env) {
  const client=db(env);
  const sessions=await client.rest('pos_sessions','select=*&order=opened_at.desc&limit=100');
  if(sessions.error)return sessions;
  const sales=await client.rest('orders','select=session_id,total_cents,payment_method,status&session_id=not.is.null&channel=eq.pos');
  if(sales.error)return sales;
  const cash=new Map();
  for(const sale of sales.data||[]){
    if(sale.payment_method==='cash'&&sale.status!=='cancelled')cash.set(sale.session_id,(cash.get(sale.session_id)||0)+Number(sale.total_cents||0));
  }
  return {data:(sessions.data||[]).map(session=>{
    const expected_cash_cents=Number(session.opening_float_cents||0)+(cash.get(session.id)||0);
    return {...session,expected_cash_cents,variance_cents:session.closing_cash_cents==null?null:Number(session.closing_cash_cents)-expected_cash_cents};
  }),error:null};
}
export const openSession = (env, body, actor) => body.client_uuid
  ? db(env).rpc('open_pos_session', {
      p_client_uuid: body.client_uuid,
      p_label: body.label,
      p_device_label: body.device_label || null,
      p_opening_float_cents: body.opening_float_cents || 0,
      p_opened_at: body.opened_at || null,
      p_operator_email: actor
    })
  : db(env).rest('pos_sessions', 'select=*', {
      method: 'POST', headers: { prefer: 'return=representation' },
      body: JSON.stringify({
        label: body.label,
        device_label: body.device_label || null,
        opening_float_cents: body.opening_float_cents || 0,
        operator_email: actor || null
      })
    });
export const closeSession = (env, id, body) => db(env).rest('pos_sessions', `id=eq.${encodeURIComponent(id)}&select=*`, {
  method: 'PATCH', headers: { prefer: 'return=representation' },
  body: JSON.stringify({ closing_cash_cents: body.closing_cash_cents, closed_at: new Date().toISOString() })
});

export const closeOfflineSession = (env, body, actor) => db(env).rpc('close_pos_session', {
  p_client_uuid: body.client_uuid,
  p_closing_cash_cents: body.closing_cash_cents,
  p_closed_at: body.closed_at || null,
  p_operator_email: actor
});
