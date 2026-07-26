import { listProducts, saveProduct, archiveProduct, hardDeleteProduct, signUpload, saveImage, deleteImage, reorderImages } from '../db/products.js';
import { adjustStock, listMovements, stocktake } from '../db/stock.js';
import { listOrders, getOrder, setOrderStatus, listSessions, openSession, closeSession } from '../db/orders.js';
import { dashboard } from '../db/stats.js';
import { body, json, result } from './http.js';
import { purgeReadCaches } from '../db/client.js';

async function mutation(env, value, success = 200) {
  if (!value.error) await purgeReadCaches(env);
  return result(value, success);
}

export async function adminApi(request, env, user) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin\/?/, '');
  const parts = path.split('/').filter(Boolean);
  const method = request.method;

  if (path === 'me' && method === 'GET') return json(200,{ok:true,user});
  if (path === 'dashboard' && method === 'GET') return result(await dashboard(env,{
    from:url.searchParams.get('from'),
    refresh:url.searchParams.get('refresh') === '1'
  }));
  if (parts[0] === 'products' && parts.length === 1 && method === 'GET') {
    return result(await listProducts(env,Object.fromEntries(url.searchParams)));
  }
  if (parts[0] === 'products' && parts.length === 1 && method === 'POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await saveProduct(env,parsed.data,user.email),201);
  }
  if (parts[0] === 'products' && parts[1] && method === 'PATCH') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await saveProduct(env,{...parsed.data,id:parts[1]},user.email));
  }
  if (parts[0] === 'products' && parts[2] === 'archive' && method === 'POST') return mutation(env,await archiveProduct(env,parts[1],user.email));
  if (parts[0] === 'products' && parts[1] && parts.length === 2 && method === 'DELETE') return mutation(env,await hardDeleteProduct(env,parts[1],user.email));
  if (path === 'images/sign' && method === 'POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return result(await signUpload(env,parsed.data.product_id,parsed.data.filename));
  }
  if (path === 'images' && method === 'POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await saveImage(env,parsed.data,user.email),201);
  }
  if (path === 'images/reorder' && method === 'POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await reorderImages(env,parsed.data.product_id,parsed.data.ids,user.email));
  }
  if (parts[0] === 'images' && parts[1] && method === 'DELETE') return mutation(env,await deleteImage(env,parts[1],user.email));
  if (path === 'inventory/movements' && method === 'GET') {
    const value=await listMovements(env,Object.fromEntries(url.searchParams));
    if(url.searchParams.get('format')==='csv'&&!value.error)return csv(value.data);
    return result(value);
  }
  if (path === 'inventory/adjust' && method === 'POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await adjustStock(env,parsed.data,user.email));
  }
  if (path === 'inventory/stocktake' && method === 'POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await stocktake(env,parsed.data.counts,user.email));
  }
  if (parts[0] === 'orders' && parts.length === 1 && method === 'GET') return result(await listOrders(env,Object.fromEntries(url.searchParams)));
  if (parts[0] === 'orders' && parts[1] && parts.length === 2 && method === 'GET') return result(await getOrder(env,parts[1]));
  if (parts[0] === 'orders' && parts[2] === 'status' && method === 'POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await setOrderStatus(env,parts[1],parsed.data.status,parsed.data.payment_method,user.email,parsed.data.note));
  }
  if (parts[0] === 'sessions' && parts.length === 1 && method === 'GET') return result(await listSessions(env));
  if (parts[0] === 'sessions' && parts.length === 1 && method === 'POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return result(await openSession(env,parsed.data),201);
  }
  if (parts[0] === 'sessions' && parts[2] === 'close' && method === 'POST') {
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return result(await closeSession(env,parts[1],parsed.data));
  }
  return json(404,{ok:false,error:'Admin route not found'});
}

function csv(rows) {
  const columns=['created_at','product_id','delta','reason','note','created_by'];
  const quote=(value)=>'"'+String(value??'').replace(/"/g,'""')+'"';
  const text=[columns.join(','),...(rows||[]).map(row=>columns.map(key=>quote(row[key])).join(','))].join('\n');
  return new Response(text,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="verre-stock-movements.csv"'}});
}
