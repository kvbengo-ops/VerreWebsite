import { listProducts, saveProduct, archiveProduct, hardDeleteProduct, signUpload, saveImage, deleteImage, reorderImages } from '../db/products.js';
import { adjustStock, listMovements, stocktake } from '../db/stock.js';
import { listOrders, getOrder, setOrderStatus, listSessions, openSession, closeSession } from '../db/orders.js';
import { dashboard } from '../db/stats.js';
import { body, json, result } from './http.js';
import { purgeReadCaches } from '../db/client.js';
import { listAccounts, saveAccount } from '../db/accounts.js';
import { listSubscribers } from '../db/subscribers.js';
import {
  listOptionGroups, saveOptionGroup, saveOption, retireOption,
  listCustomOrders, getCustomOrder, setCustomQuote, setCustomShipping
} from '../db/custom.js';
import { setThemeOverride } from '../db/settings.js';
import { currentTheme, isKnownTheme } from './theme.js';
import { ALL_THEMES } from '../themes.js';
import { can } from '../roles.js';

async function mutation(env, value, success = 200) {
  if (!value.error) await purgeReadCaches(env);
  return result(value, success);
}

export async function adminApi(request, env, user) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin\/?/, '');
  const parts = path.split('/').filter(Boolean);
  const method = request.method;

  // Under `data`, like every other route here. The client unwraps
  // `body.data ?? body`, so returning {ok,user} hands it the envelope instead
  // of the user: state.me.role comes back undefined, render() bounces the hash
  // to the value it already has, no hashchange fires, and the shell sits on
  // "Loading the studio…" forever with no error anywhere.
  if (path === 'me' && method === 'GET') return json(200,{ok:true,data:user});
  if (parts[0] === 'accounts') {
    if (!can(user,'accounts')) return denied();
    if (parts.length === 1 && method === 'GET') return result(await listAccounts(env));
    if (parts.length === 1 && method === 'POST') {
      const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
      return result(await saveAccount(env,parsed.data,user.email),201);
    }
    if (parts.length === 2 && method === 'PATCH') {
      const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
      return result(await saveAccount(env,{...parsed.data,id:parts[1]},user.email));
    }
  }
  if (path === 'dashboard' && method === 'GET') {
    if (!can(user,'dashboard')) return denied();
    return result(await dashboard(env,{
    from:url.searchParams.get('from'),
    refresh:url.searchParams.get('refresh') === '1'
    }));
  }
  if (parts[0] === 'products' && parts.length === 1 && method === 'GET') {
    if (!can(user,'catalog') && !can(user,'inventory')) return denied();
    return result(await listProducts(env,Object.fromEntries(url.searchParams)));
  }
  if (parts[0] === 'products' && parts.length === 1 && method === 'POST') {
    if (!can(user,'catalog')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await saveProduct(env,parsed.data,user.email),201);
  }
  if (parts[0] === 'products' && parts[1] && method === 'PATCH') {
    if (!can(user,'catalog')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await saveProduct(env,{...parsed.data,id:parts[1]},user.email));
  }
  if (parts[0] === 'products' && parts[2] === 'archive' && method === 'POST') {
    if (!can(user,'catalog')) return denied();
    return mutation(env,await archiveProduct(env,parts[1],user.email));
  }
  if (parts[0] === 'products' && parts[1] && parts.length === 2 && method === 'DELETE') {
    if (!can(user,'catalog')) return denied();
    return mutation(env,await hardDeleteProduct(env,parts[1],user.email));
  }
  if (path === 'images/sign' && method === 'POST') {
    if (!can(user,'catalog')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return result(await signUpload(env,parsed.data.product_id,parsed.data.filename));
  }
  if (path === 'images' && method === 'POST') {
    if (!can(user,'catalog')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await saveImage(env,parsed.data,user.email),201);
  }
  if (path === 'images/reorder' && method === 'POST') {
    if (!can(user,'catalog')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await reorderImages(env,parsed.data.product_id,parsed.data.ids,user.email));
  }
  if (parts[0] === 'images' && parts[1] && method === 'DELETE') {
    if (!can(user,'catalog')) return denied();
    return mutation(env,await deleteImage(env,parts[1],user.email));
  }
  if (path === 'inventory/movements' && method === 'GET') {
    if (!can(user,'inventory')) return denied();
    const value=await listMovements(env,Object.fromEntries(url.searchParams));
    if(url.searchParams.get('format')==='csv'&&!value.error)return csv(value.data);
    return result(value);
  }
  if (path === 'theme' && method === 'GET') {
    if (!can(user,'admin')) return denied();
    const state=await currentTheme(env);
    return json(200,{ok:true,data:{
      ...state,
      // Palettes travel with the state so the admin never keeps its own copy —
      // a swatch that disagreed with the live site would be worse than none.
      themes:ALL_THEMES.map(t=>({id:t.id,label:t.label,blurb:t.blurb,swatch:t.swatch,hero:t.hero,ribbon:t.ribbon,
        window:t.from?{from:t.from,to:t.to}:null}))
    }});
  }
  if (path === 'theme' && method === 'POST') {
    if (!can(user,'catalog')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    const value=String(parsed.data?.theme??'auto');
    if(!isKnownTheme(value))return json(400,{ok:false,error:'That is not a theme we know about',field:'theme'});
    // 'auto' clears the override and hands the storefront back to the calendar.
    const saved=await setThemeOverride(env,value==='auto'?null:value,user.email);
    if(saved.error)return result(saved);
    // The homepage caches the override for a minute; drop it so a change made
    // for a market day is visible immediately rather than eventually.
    if(env.CATALOG_CACHE){try{await env.CATALOG_CACHE.delete('theme:override')}catch{}}
    return json(200,{ok:true,data:await currentTheme(env)});
  }
  if (path === 'subscribers' && method === 'GET') {
    if (!can(user,'admin')) return denied();
    const value=await listSubscribers(env);
    if(url.searchParams.get('format')==='csv'&&!value.error){
      return toCsv(['email','source','created_at','unsubscribed_at'],value.data,'verre-subscribers.csv');
    }
    return result(value);
  }
  if (path === 'inventory/adjust' && method === 'POST') {
    if (!can(user,'inventory')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await adjustStock(env,parsed.data,user.email));
  }
  if (path === 'inventory/stocktake' && method === 'POST') {
    if (!can(user,'inventory')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await stocktake(env,parsed.data.counts,user.email));
  }
  if (parts[0] === 'orders' && parts.length === 1 && method === 'GET') {
    if (!can(user,'sales')) return denied();
    return result(await listOrders(env,Object.fromEntries(url.searchParams)));
  }
  if (parts[0] === 'orders' && parts[1] && parts.length === 2 && method === 'GET') {
    if (!can(user,'sales')) return denied();
    return result(await getOrder(env,parts[1]));
  }
  if (parts[0] === 'orders' && parts[2] === 'status' && method === 'POST') {
    if (!can(user,'sales')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return mutation(env,await setOrderStatus(env,parts[1],parsed.data.status,parsed.data.payment_method,user.email,parsed.data.note));
  }
  if (parts[0] === 'sessions' && parts.length === 1 && method === 'GET') {
    if (!can(user,'sessions')) return denied();
    return result(await listSessions(env));
  }
  if (parts[0] === 'sessions' && parts.length === 1 && method === 'POST') {
    if (!can(user,'sessions')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return result(await openSession(env,parsed.data),201);
  }
  if (parts[0] === 'sessions' && parts[2] === 'close' && method === 'POST') {
    if (!can(user,'sessions')) return denied();
    const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
    return result(await closeSession(env,parts[1],parsed.data));
  }
  /* ---- custom commissions ---------------------------------------- */
  // Reading and quoting is `sales` — the same capability that already covers
  // web orders, so a General Admin can answer a commission without also being
  // handed the product catalog. Editing the wizard's option tables is `catalog`:
  // it changes what the public storefront offers and what it says things cost.
  if (parts[0] === 'custom') {
    if (parts[1] === 'options' && parts.length === 2 && method === 'GET') {
      if (!can(user,'catalog')) return denied();
      return result(await listOptionGroups(env));
    }
    if (parts[1] === 'groups' && parts.length === 2 && method === 'POST') {
      if (!can(user,'catalog')) return denied();
      const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
      return result(await saveOptionGroup(env,parsed.data,user.email),201);
    }
    if (parts[1] === 'groups' && parts[2] && method === 'PATCH') {
      if (!can(user,'catalog')) return denied();
      const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
      return result(await saveOptionGroup(env,{...parsed.data,id:parts[2]},user.email));
    }
    if (parts[1] === 'options' && parts.length === 2 && method === 'POST') {
      if (!can(user,'catalog')) return denied();
      const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
      return result(await saveOption(env,parsed.data,user.email),201);
    }
    if (parts[1] === 'options' && parts[2] && method === 'PATCH') {
      if (!can(user,'catalog')) return denied();
      const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
      return result(await saveOption(env,{...parsed.data,id:parts[2]},user.email));
    }
    if (parts[1] === 'options' && parts[2] && method === 'DELETE') {
      if (!can(user,'catalog')) return denied();
      return result(await retireOption(env,parts[2],user.email));
    }
    if (parts[1] === 'orders' && parts.length === 2 && method === 'GET') {
      if (!can(user,'sales')) return denied();
      return result(await listCustomOrders(env,Object.fromEntries(url.searchParams)));
    }
    if (parts[1] === 'orders' && parts[2] && parts.length === 3 && method === 'GET') {
      if (!can(user,'sales')) return denied();
      return result(await getCustomOrder(env,parts[2]));
    }
    if (parts[1] === 'orders' && parts[3] === 'quote' && method === 'POST') {
      if (!can(user,'sales')) return denied();
      const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
      return result(await setCustomQuote(env,parts[2],parsed.data,user.email));
    }
    if (parts[1] === 'orders' && parts[3] === 'shipping' && method === 'POST') {
      if (!can(user,'sales')) return denied();
      const parsed=await body(request); if(parsed.error)return json(400,{ok:false,error:parsed.error});
      return result(await setCustomShipping(env,parts[2],parsed.data,user.email));
    }
  }

  return json(404,{ok:false,error:'Admin route not found'});
}

const denied = () => json(403,{ok:false,error:'Your role does not allow this action',code:'FORBIDDEN'});

// A leading =, +, - or @ makes Excel and Sheets treat a cell as a formula, so a
// crafted subscriber address or product note can execute on open. Prefixing an
// apostrophe keeps the value visible and inert.
const quoteCell=(value)=>{
  const text=String(value??'');
  return '"'+(/^[=+\-@\t\r]/.test(text)?"'"+text:text).replace(/"/g,'""')+'"';
};
const toCsv=(columns,rows,filename)=>new Response(
  [columns.join(','),...(rows||[]).map(row=>columns.map(key=>quoteCell(row[key])).join(','))].join('\n'),
  {headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="'+filename+'"'}}
);

const csv=(rows)=>toCsv(['created_at','product_id','delta','reason','note','created_by'],rows,'verre-stock-movements.csv');
