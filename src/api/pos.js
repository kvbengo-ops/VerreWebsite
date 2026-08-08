import { listPublicProducts } from '../db/products.js';
import { syncSales, listSessions, openSession, closeSession, closeOfflineSession, voidSale } from '../db/orders.js';
import { body, json, result } from './http.js';
import { purgeReadCaches } from '../db/client.js';

export async function posApi(request, env, user) {
  const url=new URL(request.url);
  const path=url.pathname.replace(/^\/api\/pos\/?/,'');
  const parts=path.split('/').filter(Boolean);
  // Under `data` — see the note in api/admin.js. pos/app.js unwraps identically.
  if(path==='me'&&request.method==='GET')return json(200,{ok:true,data:user});
  if(path==='products'&&request.method==='GET') {
    const value=await listPublicProducts(env);
    return json(200,{ok:true,data:{products:value.data,stale:Boolean(value.stale)}});
  }
  if(path==='sync'&&request.method==='POST') {
    const parsed=await body(request,256*1024); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    if(!Array.isArray(parsed.data.sales)||parsed.data.sales.length>100)return json(400,{ok:false,error:'Send 1–100 sales per batch'});
    const value=await syncSales(env,parsed.data.sales,user.email);
    if(!value.error)await purgeReadCaches(env);
    return result(value);
  }
  if(path==='undo'&&request.method==='POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    if(!/^[0-9a-f-]{36}$/i.test(parsed.data.client_uuid||''))return json(400,{ok:false,error:'A valid sale id is required'});
    const value=await voidSale(env,parsed.data.client_uuid,user.email);
    if(!value.error)await purgeReadCaches(env);
    return result(value);
  }
  if(parts[0]==='sessions'&&parts.length===1&&request.method==='GET')return result(await listSessions(env));
  if(parts[0]==='sessions'&&parts.length===1&&request.method==='POST'){
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    if(parsed.data.client_uuid&&!/^[0-9a-f-]{36}$/i.test(parsed.data.client_uuid))return json(400,{ok:false,error:'A valid local session id is required'});
    return result(await openSession(env,parsed.data,user.email),201);
  }
  if(path==='sessions/close-offline'&&request.method==='POST'){
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    if(!/^[0-9a-f-]{36}$/i.test(parsed.data.client_uuid||''))return json(400,{ok:false,error:'A valid local session id is required'});
    return result(await closeOfflineSession(env,parsed.data,user.email));
  }
  if(parts[0]==='sessions'&&parts[2]==='close'&&request.method==='POST'){
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return result(await closeSession(env,parts[1],parsed.data));
  }
  return json(404,{ok:false,error:'POS route not found'});
}
