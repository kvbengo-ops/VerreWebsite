const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const money=(cents=0)=>'₱'+(Number(cents)/100).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const state={products:[],cart:new Map(),category:'all',payment:'cash',session:null,queue:[],review:[],lastSale:null,syncing:false,resetTimer:null};
function signIn(){
  const returnTo=location.pathname+location.search+location.hash;
  location.replace('/login?return_to='+encodeURIComponent(returnTo));
}

const openDb=()=>new Promise((resolve,reject)=>{
  const request=indexedDB.open('verre-pos',1);
  request.onupgradeneeded=()=>{
    const database=request.result;
    database.createObjectStore('kv');
    database.createObjectStore('queue',{keyPath:'client_uuid'});
    database.createObjectStore('review',{keyPath:'client_uuid'});
  };
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
});
async function store(name,mode='readonly'){const database=await openDb();return database.transaction(name,mode).objectStore(name)}
const requestResult=(request)=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
async function get(name,key){return requestResult((await store(name)).get(key))}
async function put(name,value,key){return requestResult((await store(name,'readwrite')).put(value,key))}
async function remove(name,key){return requestResult((await store(name,'readwrite')).delete(key))}
async function all(name){return requestResult((await store(name)).getAll())}

async function api(path,options={}){
  const response=await fetch('/api/pos/'+path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  const type=response.headers.get('content-type')||'';
  if(!type.includes('application/json')){
    const error=new Error('Session expired — reconnect to keep syncing.');
    error.auth=true;throw error;
  }
  const body=await response.json();
  if(response.status===401){const error=new Error('Session expired — reconnect to keep syncing.');error.auth=true;throw error}
  if(!response.ok||!body.ok)throw new Error(body.error||'Request failed');
  return body.data??body;
}
function toast(message,error=false){const node=$('#toast');node.textContent=message;node.style.background=error?'#9C293B':'#3A2430';node.classList.add('show');setTimeout(()=>node.classList.remove('show'),3500)}
function parsePeso(value){const clean=String(value||'').replace(/[₱,\s]/g,'');return /^\d+(?:\.\d{1,2})?$/.test(clean)?Math.round(Number(clean)*100):null}
function uuid(){return crypto.randomUUID()}

async function init(){
  try{
    if('serviceWorker'in navigator)await navigator.serviceWorker.register('/pos/sw.js',{scope:'/pos/'});
    try{
      const {user}=await api('me');
      const role={super_admin:'Super Admin',general_admin:'General Admin',cashier:'Cashier'}[user.role]||user.role;
      $('#operator').textContent=(user.display_name||user.email)+' · '+role;
      $('#operator').title=user.email;
    }catch(error){
      if(error.auth&&navigator.onLine){signIn();return}
      $('#operator').textContent='Offline operator';
    }
    state.queue=await all('queue');state.review=await all('review');
    state.session=await get('kv','session')||null;
    state.products=await get('kv','catalog')||[];
    renderAll();
    await refreshCatalog();
    if(navigator.onLine)syncQueue();
  }catch(error){toast(error.name==='QuotaExceededError'?'Device storage is full — do not close this screen until space is freed.':error.message,true)}
  updateNetwork();
}
async function refreshCatalog(){
  try{
    const result=await api('products');
    const products=Array.isArray(result)?result:Array.isArray(result?.data)?result.data:null;
    if(products){
      const local=new Map(state.products.map(p=>[p.id,p.stock_on_hand]));
      state.products=products.map(p=>({...p,stock_on_hand:local.has(p.id)&&state.queue.length?Math.min(p.stock_on_hand,local.get(p.id)):p.stock_on_hand}));
      await put('kv',state.products,'catalog');renderProducts();
      cacheImages(products);
    }
  }catch(error){
    if(!state.products.length)toast(error.message,true);
  }
}
function cacheImages(products){
  if(!('caches'in window))return;
  caches.open('verre-pos-images-v1').then(cache=>(products||[]).flatMap(p=>p.images||[]).forEach(image=>image.url&&cache.add(image.url).catch(()=>{})));
}

function renderAll(){renderCategories();renderProducts();renderCart();renderSession();renderQueue();updateNetwork()}
function renderCategories(){
  const values=['all',...new Set(state.products.map(p=>p.category))];
  $('#categories').innerHTML=values.map(value=>`<button role="tab" data-category="${esc(value)}" class="${state.category===value?'active':''}">${value==='all'?'All':esc(value)}</button>`).join('');
  $$('[data-category]').forEach(button=>button.onclick=()=>{state.category=button.dataset.category;renderCategories();renderProducts()});
}
function renderProducts(){
  const query=$('#search').value.trim().toLowerCase();
  const products=state.products.filter(p=>(state.category==='all'||p.category===state.category)&&(!query||(p.name+' '+p.slug).toLowerCase().includes(query)));
  $('#products').innerHTML=products.length?products.map(p=>{
    const image=p.images?.[0]?.url;
    const out=p.stock_on_hand<=0, low=!out&&p.stock_on_hand<=2;
    return `<button class="product ${out?'out':''} ${low?'low':''}" data-product="${esc(p.id||'')}">
      <span class="product-art" style="--product-bg:${esc(p.bg_color||'#FFE0EE')}">${image?`<img src="${esc(image)}" alt="">`:`<span aria-hidden="true">${p.category==='glass'?'✦':p.category==='charms'?'♡':'☁'}</span>`}</span>
      <span class="product-copy"><strong>${esc(p.name)}</strong><small>${money(p.price_cents)}</small><span class="stock">${out?'Sold out':p.stock_on_hand+' left'}</span></span>
    </button>`;
  }).join(''):'<div class="empty">No pieces match.</div>';
  $$('[data-product]').forEach(button=>button.onclick=()=>addProduct(button.dataset.product));
}
function addProduct(id){
  const product=state.products.find(p=>p.id===id);
  if(!product?.id){toast('This fallback catalog cannot take sales. Reconnect after Supabase is configured.',true);return}
  if(product.stock_on_hand<=0&&!confirm(`${product.name} is marked sold out. Add it anyway? The sale will be flagged if it oversells.`))return;
  state.cart.set(id,(state.cart.get(id)||0)+1);renderCart();
}
function totals(){
  const subtotal=[...state.cart].reduce((sum,[id,qty])=>sum+(state.products.find(p=>p.id===id)?.price_cents||0)*qty,0);
  const entered=parsePeso($('#discount').value)||0;
  const discount=$('#discount-type').value==='percent'?Math.round(subtotal*Math.min(entered/10000,1)):Math.min(entered,subtotal);
  return{subtotal,discount,total:Math.max(0,subtotal-discount)};
}
function renderCart(){
  const lines=[...state.cart].map(([id,qty])=>({product:state.products.find(p=>p.id===id),qty})).filter(x=>x.product);
  $('#cart-lines').innerHTML=lines.length?lines.map(({product,qty})=>`<div class="line"><div><strong>${esc(product.name)}</strong><small>${money(product.price_cents*qty)}</small></div><div class="stepper"><button data-step="${product.id}" data-delta="-1" aria-label="Remove one">−</button><b>${qty}</b><button data-step="${product.id}" data-delta="1" aria-label="Add one">+</button></div></div>`).join(''):'<div class="empty">Tap a piece to begin.</div>';
  $$('[data-step]').forEach(button=>button.onclick=()=>{const id=button.dataset.step,next=(state.cart.get(id)||0)+Number(button.dataset.delta);if(next<=0)state.cart.delete(id);else state.cart.set(id,next);renderCart()});
  const value=totals();$('#subtotal').textContent=money(value.subtotal);$('#discount-total').textContent='−'+money(value.discount);$('#total').textContent=money(value.total);updateChange(value.total);
  // The amount lives on the button itself. At a stall the question is always
  // "how much?", and the answer should be on the thing you are about to press.
  $('#to-payment').textContent='Charge '+money(value.total);
  $('#to-payment').disabled=!lines.length;
  $('#complete').disabled=!lines.length;
  // Emptying the basket while on the payment step would leave you paying for
  // nothing, so fall back to step one.
  if(!lines.length&&cartView()==='pay')setCartView('cart');
}

const cartView=()=>document.querySelector('.cart').dataset.view;
function setCartView(view){
  const cart=document.querySelector('.cart');
  cart.dataset.view=view;
  const paying=view==='pay';
  $('#back-to-cart').hidden=!paying;
  $('#cart-title').textContent=paying?'Payment':'Cart';
  // Focus follows the step so a keyboard or screen-reader user is not left
  // behind at the top of a panel whose contents just changed underneath them.
  const target=paying?$('#tendered'):$('#to-payment');
  if(target&&!target.hidden&&!target.disabled)target.focus({preventScroll:true});
  if(paying)cart.querySelector('.pay-pane').scrollTop=0;
}
function updateChange(total=totals().total){const tender=parsePeso($('#tendered').value)||0;$('#change').textContent=money(Math.max(0,tender-total))}
function renderSession(){
  $('#session-button').textContent=state.session?.label||'No open session';
  $('#session-button').classList.toggle('none',!state.session);
  $('#session-warning').hidden=Boolean(state.session);
}
function updateNetwork(){
  const online=navigator.onLine,node=$('#network');node.textContent=online?'Online':'Offline — sales stay here';node.className='signal '+(online?'online':'offline');
}
function renderQueue(){
  $('#pending-count').textContent=state.queue.length;
  $('#queue-button').classList.toggle('pending',state.queue.length>0||state.review.length>0);
  const rows=[...state.queue.map(s=>({...s,state:'Pending'})),...state.review.map(s=>({...s,state:'Needs review'}))];
  $('#queue-list').innerHTML=rows.length?rows.map(s=>`<div class="queue-item"><strong>${esc(s.state)}</strong> · ${money(s.total_cents)}<br><small>${new Date(s.sold_at).toLocaleString('en-PH')} · ${esc(s.client_uuid)}</small>${s.sync_error?`<br><small>${esc(s.sync_error)}</small>`:''}</div>`).join(''):'<div class="empty">Everything is synced.</div>';
  $('#queue-message').textContent=state.review.length?'A rejected sale needs review. Nothing has been silently dropped.':state.queue.length?'Sales sync oldest first when the connection returns.':'No pending sales.';
}

async function completeSale(){
  const value=totals();
  if(!state.session&&!confirm('There is no open session. Complete this sale anyway?'))return;
  const tender=state.payment==='cash'?parsePeso($('#tendered').value):null;
  if(state.payment==='cash'&&(tender==null||tender<value.total)){toast('Tendered cash must cover the total.',true);return}
  const sale={
    client_uuid:uuid(),sold_at:new Date().toISOString(),session_id:state.session?.remote_id||null,
    items:[...state.cart].map(([product_id,qty])=>({product_id,qty})),
    subtotal_cents:value.subtotal,discount_cents:value.discount,total_cents:value.total,
    discount_reason:$('#discount-reason').value.trim()||null,payment_method:state.payment,
    tendered_cents:tender,gcash_reference:$('#gcash-reference').value.trim()||null
  };
  try{
    await put('queue',sale);state.queue.push(sale);state.lastSale=sale;
    for(const item of sale.items){const product=state.products.find(p=>p.id===item.product_id);if(product)product.stock_on_hand=Math.max(0,product.stock_on_hand-item.qty)}
    await put('kv',state.products,'catalog');renderProducts();renderQueue();showSuccess(sale);
    if(navigator.onLine)syncQueue();
  }catch(error){
    toast(error.name==='QuotaExceededError'?'Storage is full. Sale was not saved — free space before continuing.':'Sale could not be saved locally: '+error.message,true);
  }
}
function showSuccess(sale){
  const ref=sale.server_ref||'Pending sync';
  $('#success-ref').textContent=ref;$('#sync-note').textContent=sale.server_ref?'Synced safely.':'Saved on this device. It will sync when online.';
  const receipt=sale.server_ref?`${location.origin}/r/${sale.server_ref}`:'';
  $('#receipt-link').hidden=!receipt;$('#receipt-link').href=receipt||'#';
  $('#qr').innerHTML=receipt?`<img alt="QR code for receipt ${esc(ref)}" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(receipt)}">`:'<strong>QR appears after sync</strong>';
  $('#undo').disabled=false;$('#success').showModal();
  clearTimeout(state.resetTimer);state.resetTimer=setTimeout(nextSale,4000);
}
function nextSale(){clearTimeout(state.resetTimer);if($('#success').open)$('#success').close();state.cart.clear();$('#discount').value='';$('#discount-reason').value='';$('#tendered').value='';$('#gcash-reference').value='';setCartView('cart');renderCart()}

async function syncQueue(){
  if(state.syncing||!navigator.onLine||!state.queue.length)return;
  state.syncing=true;let delay=600;
  try{
    const ordered=[...state.queue].sort((a,b)=>new Date(a.sold_at)-new Date(b.sold_at));
    for(let index=0;index<ordered.length;index+=20){
      let results;
      try{results=await api('sync',{method:'POST',body:JSON.stringify({sales:ordered.slice(index,index+20)})})}
      catch(error){if(error.auth){toast(error.message,true);break}throw error}
      for(const result of results||[]){
        const sale=state.queue.find(s=>s.client_uuid===result.client_uuid);
        if(!sale)continue;
        if(result.ok){
          await remove('queue',sale.client_uuid);state.queue=state.queue.filter(s=>s.client_uuid!==sale.client_uuid);
          sale.server_ref=result.order?.ref;
          if(state.lastSale?.client_uuid===sale.client_uuid){state.lastSale=sale;if($('#success').open)showSuccess(sale)}
          if(result.oversell)toast(`${result.order?.ref||'Sale'} synced with an oversell — check the dashboard.`,true);
        }else if(result.permanent){
          sale.sync_error=result.error;await remove('queue',sale.client_uuid);await put('review',sale);state.queue=state.queue.filter(s=>s.client_uuid!==sale.client_uuid);state.review.push(sale);
        }else{sale.sync_error=result.error}
      }
      renderQueue();
    }
    await refreshCatalog();
  }catch(error){
    toast('Sync paused: '+error.message,true);
    setTimeout(()=>{state.syncing=false;syncQueue()},delay+Math.random()*500);delay=Math.min(delay*2,30000);return;
  }
  state.syncing=false;
}
async function undoLast(){
  clearTimeout(state.resetTimer);const sale=state.lastSale;if(!sale)return;
  try{
    const pending=state.queue.some(s=>s.client_uuid===sale.client_uuid);
    if(pending){await remove('queue',sale.client_uuid);state.queue=state.queue.filter(s=>s.client_uuid!==sale.client_uuid)}
    else await api('undo',{method:'POST',body:JSON.stringify({client_uuid:sale.client_uuid})});
    for(const item of sale.items){const product=state.products.find(p=>p.id===item.product_id);if(product)product.stock_on_hand+=item.qty}
    await put('kv',state.products,'catalog');state.lastSale=null;$('#success').close();renderAll();toast('Sale undone and stock restored');
  }catch(error){toast(error.message,true)}
}

function openSessionDialog(){
  const body=$('#session-body');
  if(state.session){
    body.innerHTML=`<p><strong>${esc(state.session.label)}</strong></p><p>Opened ${new Date(state.session.opened_at).toLocaleString('en-PH')}</p><label>Counted cash <input id="closing-cash" inputmode="decimal" placeholder="0.00"></label><button id="close-session" class="primary">Close session</button>`;
    $('#session-dialog').showModal();$('#close-session').onclick=closeSession;
  }else{
    body.innerHTML=`<label>Session label <input id="session-label" placeholder="Market name and date"></label><label>Opening float <input id="opening-float" inputmode="decimal" value="0.00"></label><button id="open-session" class="primary">Start session</button>`;
    $('#session-dialog').showModal();$('#open-session').onclick=startSession;
  }
}
async function startSession(){
  const label=$('#session-label').value.trim(),opening=parsePeso($('#opening-float').value);
  if(!label||opening==null){toast('Add a label and valid opening float.',true);return}
  let remote=null;
  try{if(navigator.onLine)remote=await api('sessions',{method:'POST',body:JSON.stringify({label,device_label:navigator.platform,opening_float_cents:opening})})}catch(error){toast('Session is local until reconnection: '+error.message,true)}
  state.session={local_id:uuid(),remote_id:remote?.[0]?.id||remote?.id||null,label,opening_float_cents:opening,opened_at:new Date().toISOString()};
  await put('kv',state.session,'session');$('#session-dialog').close();renderSession();
}
async function closeSession(){
  const counted=parsePeso($('#closing-cash').value);if(counted==null){toast('Enter valid counted cash.',true);return}
  try{if(state.session.remote_id&&navigator.onLine)await api(`sessions/${state.session.remote_id}/close`,{method:'POST',body:JSON.stringify({closing_cash_cents:counted})})}catch(error){toast('The session will need reconciliation online: '+error.message,true)}
  state.session=null;await remove('kv','session');$('#session-dialog').close();renderSession();toast('Session closed');
}

$('#search').oninput=renderProducts;
$('#discount').oninput=$('#discount-type').onchange=renderCart;
$('#tendered').oninput=()=>updateChange();
$$('[data-payment]').forEach(button=>button.onclick=()=>{state.payment=button.dataset.payment;$$('[data-payment]').forEach(x=>x.classList.toggle('active',x===button));$('#cash-fields').hidden=state.payment!=='cash';$('#gcash-fields').hidden=state.payment!=='gcash';renderCart()});
$$('[data-tender]').forEach(button=>button.onclick=()=>{$('#tendered').value=button.dataset.tender==='exact'?(totals().total/100).toFixed(2):button.dataset.tender;updateChange()});
$('#to-payment').onclick=()=>setCartView('pay');
$('#back-to-cart').onclick=()=>setCartView('cart');
// Escape backs out of payment. Nothing has been recorded yet at this point, so
// there is no confirmation to ask for.
document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&cartView()==='pay'&&!document.querySelector('dialog[open]'))setCartView('cart')});
$('#complete').onclick=completeSale;$('#next-sale').onclick=nextSale;$('#undo').onclick=undoLast;
$('#queue-button').onclick=()=>$('#queue-dialog').showModal();$('#sync-now').onclick=syncQueue;
$('#session-button').onclick=openSessionDialog;
$$('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
window.addEventListener('online',()=>{updateNetwork();syncQueue()});window.addEventListener('offline',updateNetwork);
setInterval(syncQueue,30000);
init();
