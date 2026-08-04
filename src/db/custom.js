import { db } from './client.js';

const encode = encodeURIComponent;

/* ------------------------------------------------------------------ */
/* the wizard                                                          */
/* ------------------------------------------------------------------ */

/**
 * Every active step with its choices nested, in one round trip.
 *
 * Cached for a minute in CATALOG_CACHE when it exists. The wizard is the
 * heaviest thing an anonymous visitor can ask for and its contents change
 * roughly never — Kyle edits an option maybe once a month. Admin writes purge
 * the key, so an edit is visible immediately rather than up to a minute later.
 */
export async function customWizard(env) {
  if (env.CATALOG_CACHE) {
    try {
      const cached = await env.CATALOG_CACHE.get('custom:wizard', 'json');
      if (cached) return { data: cached, error: null, cached: true };
    } catch {}
  }
  const result = await db(env).rpc('custom_wizard', {});
  if (result.error) return result;
  if (env.CATALOG_CACHE) {
    try {
      await env.CATALOG_CACHE.put('custom:wizard', JSON.stringify(result.data), { expirationTtl: 60 });
    } catch {}
  }
  return { data: result.data, error: null, cached: false };
}

export async function purgeWizardCache(env) {
  if (!env.CATALOG_CACHE) return;
  try { await env.CATALOG_CACHE.delete('custom:wizard'); } catch {}
}

/* ------------------------------------------------------------------ */
/* submit                                                              */
/* ------------------------------------------------------------------ */

// The browser sends keys only. Labels and prices are read out of the tables by
// the RPC, so nothing here trusts a number that came over the wire — the same
// rule the catalog order path already follows.
export const createCustomRequest = (env, ref, request) => db(env).rpc('create_custom_request', {
  p_ref: ref,
  p_selections: request.selections,
  p_customer: {
    name: request.name,
    email: request.email,
    phone: request.phone || null,
    fulfillment: request.fulfillment,
    message: request.message || null,
    ship_line1: request.ship_line1 || null,
    ship_line2: request.ship_line2 || null,
    ship_city: request.ship_city || null,
    ship_province: request.ship_province || null,
    ship_postcode: request.ship_postcode || null
  }
});

export const trackOrder = (env, ref, token) =>
  db(env).rpc('public_order_track', { p_ref: ref, p_token: token });

/* ------------------------------------------------------------------ */
/* reference photos                                                    */
/* ------------------------------------------------------------------ */

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

/**
 * A signed upload URL scoped to one path in the private bucket.
 *
 * The browser uploads straight to Supabase rather than through the Worker.
 * Cloudflare's free plan gives roughly 10ms of CPU per request and 128MB of
 * memory; streaming an 8MB phone photo through it would blow both, and the
 * failure would land on the customer as a generic error at the last step of a
 * form they had just spent five minutes filling in.
 */
export async function signReferenceUpload(env, orderId, contentType) {
  const extension = IMAGE_TYPES[String(contentType || '').toLowerCase()];
  if (!extension) {
    return { data: null, error: { message: 'Please upload a JPG, PNG or WebP', code: 'BAD_TYPE', status: 400 } };
  }
  const path = `custom/${orderId}/${crypto.randomUUID()}.${extension}`;
  const result = await db(env).storage('object/upload/sign/custom-references/' + path, {
    method: 'POST', body: '{}'
  });
  if (result.error) return result;
  const value = result.data.url || result.data.signedURL || result.data.signedUrl;
  const signedUrl = value?.startsWith('http')
    ? value
    : String(env.SUPABASE_URL).replace(/\/$/, '') + '/storage/v1' + value;
  return { data: { path, token: result.data.token, signedUrl }, error: null };
}

export const attachReferenceImage = (env, orderId, path, position) =>
  db(env).rpc('attach_custom_image', { p_order_id: orderId, p_path: path, p_position: position ?? null });

export async function signedReferenceUrl(env, path) {
  const result = await db(env).storage('object/sign/custom-references/' + path, {
    method: 'POST', body: JSON.stringify({ expiresIn: 3600 })
  });
  if (result.error) return null;
  const value = result.data.signedURL || result.data.signedUrl || result.data.url;
  if (!value) return null;
  return value.startsWith('http') ? value : String(env.SUPABASE_URL).replace(/\/$/, '') + '/storage/v1' + value;
}

/* ------------------------------------------------------------------ */
/* admin                                                               */
/* ------------------------------------------------------------------ */

const GROUP_SELECT = '*,custom_options(*)';

export const listOptionGroups = (env) =>
  db(env).rest('custom_option_groups', `select=${encode(GROUP_SELECT)}&order=step.asc`);

export async function saveOptionGroup(env, group, actor) {
  const payload = {
    key: group.key,
    label: group.label,
    helper: group.helper || null,
    step: Number(group.step) || 1,
    input_kind: group.input_kind || 'single',
    required: group.required !== false,
    min_choices: Number(group.min_choices ?? 1),
    max_choices: Number(group.max_choices ?? 1),
    is_active: group.is_active !== false
  };
  const result = group.id
    ? await db(env).rest('custom_option_groups', `id=eq.${encode(group.id)}&select=*`, {
        method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(payload) })
    : await db(env).rest('custom_option_groups', 'select=*', {
        method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(payload) });
  if (result.error) return result;
  await purgeWizardCache(env);
  await audit(env, actor, group.id ? 'custom.group.update' : 'custom.group.create', result.data?.[0]?.id, payload);
  return { data: result.data?.[0], error: null };
}

export async function saveOption(env, option, actor) {
  const payload = {
    group_id: option.group_id,
    parent_option_id: option.parent_option_id || null,
    key: option.key,
    label: option.label,
    description: option.description || null,
    price_delta_cents: Math.trunc(Number(option.price_delta_cents) || 0),
    lead_time_days: option.lead_time_days == null || option.lead_time_days === ''
      ? null : Math.max(0, Math.trunc(Number(option.lead_time_days))),
    swatch: option.swatch || null,
    is_active: option.is_active !== false,
    sort_order: Number(option.sort_order) || 0
  };
  const result = option.id
    ? await db(env).rest('custom_options', `id=eq.${encode(option.id)}&select=*`, {
        method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(payload) })
    : await db(env).rest('custom_options', 'select=*', {
        method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(payload) });
  if (result.error) return result;
  await purgeWizardCache(env);
  await audit(env, actor, option.id ? 'custom.option.update' : 'custom.option.create', result.data?.[0]?.id, payload);
  return { data: result.data?.[0], error: null };
}

/**
 * Deactivate, never delete, once a selection points at it.
 *
 * Selections snapshot the label and price, so a hard delete would not corrupt
 * an old quote — but it would drop the option_id that answers "how many people
 * chose metallic leaf last year?", and that question is the only reason the
 * column exists.
 */
export async function retireOption(env, id, actor) {
  const used = await db(env).rest('custom_order_selections', `select=id&option_id=eq.${encode(id)}&limit=1`);
  if (used.error) return used;
  if (used.data?.length) {
    const result = await db(env).rest('custom_options', `id=eq.${encode(id)}&select=*`, {
      method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ is_active: false })
    });
    if (!result.error) {
      await purgeWizardCache(env);
      await audit(env, actor, 'custom.option.retire', id, { is_active: false });
    }
    return result.error ? result : { data: result.data?.[0], error: null };
  }
  const result = await db(env).rest('custom_options', `id=eq.${encode(id)}`, { method: 'DELETE' });
  if (!result.error) {
    await purgeWizardCache(env);
    await audit(env, actor, 'custom.option.delete', id, {});
  }
  return result;
}

const CUSTOM_ORDER_SELECT = '*,custom_order_selections(*),custom_order_images(*)';

export function listCustomOrders(env, params = {}) {
  const query = [`select=${encode(CUSTOM_ORDER_SELECT)}`, 'inquiry_type=eq.custom', 'order=created_at.desc', 'limit=200'];
  if (params.status) query.push('status=eq.' + encode(params.status));
  if (params.search) {
    query.push('or=(ref.ilike.*' + encode(params.search) + '*,customer_name.ilike.*' + encode(params.search) +
      '*,customer_email.ilike.*' + encode(params.search) + '*)');
  }
  return db(env).rest('orders', query.join('&'));
}

export async function getCustomOrder(env, idOrRef) {
  const field = String(idOrRef).startsWith('VR-') ? 'ref' : 'id';
  const result = await db(env).rest('orders',
    `select=${encode(CUSTOM_ORDER_SELECT)}&${field}=eq.${encode(idOrRef)}&limit=1`);
  if (result.error) return result;
  const order = result.data?.[0];
  if (!order) return { data: null, error: null };
  const images = await Promise.all((order.custom_order_images || [])
    .sort((a, b) => a.position - b.position)
    .map(async (image) => ({ ...image, url: await signedReferenceUrl(env, image.storage_path) })));
  const selections = (order.custom_order_selections || [])
    .sort((a, b) => a.step - b.step || a.position - b.position);
  return { data: { ...order, images, selections }, error: null };
}

export const setCustomQuote = (env, id, quote, actor) => db(env).rpc('set_custom_quote', {
  p_order_id: id,
  p_quoted_cents: Math.max(0, Math.trunc(Number(quote.quoted_cents) || 0)),
  p_deposit_cents: Math.max(0, Math.trunc(Number(quote.deposit_cents) || 0)),
  p_note: quote.note || null,
  p_actor: actor
});

export const setCustomShipping = (env, id, shipping, actor) => db(env).rpc('set_custom_shipping', {
  p_order_id: id,
  p_carrier: shipping.carrier || null,
  p_tracking: shipping.tracking || null,
  p_actor: actor
});

async function audit(env, actor, action, entityId, diff) {
  await db(env).rest('admin_audit_log', '', {
    method: 'POST',
    body: JSON.stringify({ actor, action, entity: 'custom', entity_id: entityId || null, diff })
  });
}
