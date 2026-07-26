export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers:{'content-type':'application/json; charset=utf-8', ...headers}
});

export async function body(request, limit = 64 * 1024) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) return { error:'Request is too large' };
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > limit) return { error:'Request is too large' };
    return { data: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error:'Expected valid JSON' };
  }
}

export const result = (value, success = 200) => value.error
  ? json(value.error.status || 400, { ok:false, error:value.error.message, code:value.error.code })
  : json(success, { ok:true, data:value.data });
