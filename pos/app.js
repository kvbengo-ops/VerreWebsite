const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const money=(cents=0)=>'₱'+(Number(cents)/100).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const state={products:[],cart:new Map(),category:'all',payment:'cash',session:null,queue:[],review:[],commands:[],operator:null,lastSale:null,syncing:false,locked:true,syncDelay:600,syncTimer:null};
function signIn(){
  const returnTo=location.pathname+location.search+location.hash;
  location.replace('/login?return_to='+encodeURIComponent(returnTo));
}

const openDb=()=>new Promise((resolve,reject)=>{
  const request=indexedDB.open('verre-pos',2);
  request.onupgradeneeded=()=>{
    const database=request.result;
    if(!database.objectStoreNames.contains('kv'))database.createObjectStore('kv');
    if(!database.objectStoreNames.contains('queue'))database.createObjectStore('queue',{keyPath:'client_uuid'});
    if(!database.objectStoreNames.contains('review'))database.createObjectStore('review',{keyPath:'client_uuid'});
    if(!database.objectStoreNames.contains('commands'))database.createObjectStore('commands',{keyPath:'id'});
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

async function pinHash(email,pin,salt){
  const bytes=new TextEncoder().encode([email,salt,pin].join(':'));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
function pendingForAnother(email){
  return [...state.queue,...state.review,...state.commands].some(item=>item.operator_email&&item.operator_email!==email);
}
function showLock(message){
  state.locked=true;document.body.classList.add('pos-locked');
  $('#lock-message').textContent=message;
  $('#offline-pin-wrap').hidden=!state.operator?.pin_hash;
  $('#secure-reset').hidden=Boolean(state.queue.length||state.review.length||state.commands.length||state.session);
  if(!$('#lock-dialog').open)$('#lock-dialog').showModal();
}
function unlock(){
  state.locked=false;document.body.classList.remove('pos-locked');
  if($('#lock-dialog').open)$('#lock-dialog').close();
}

async function init(){
  try{
    if('serviceWorker'in navigator)await navigator.serviceWorker.register('/pos/sw.js',{scope:'/pos/'});
    state.queue=await all('queue');
    state.review=await all('review');
    state.commands=await all('commands');
    state.session=await get('kv','session')||null;
    state.products=await get('kv','catalog')||[];
    state.operator=await get('kv','operator')||null;
    renderAll();

    try{
      const {user}=await api('me');
      if(pendingForAnother(user.email)){
        showLock('This device has pending records for another operator. That operator must sign in and finish syncing before a handoff.');
        return;
      }
      const role={super_admin:'Super Admin',general_admin:'General Admin',cashier:'Cashier'}[user.role]||user.role;
      $('#operator').textContent=(user.display_name||user.email)+' - '+role;
      $('#operator').title=user.email;
      state.operator={...state.operator,email:user.email,display_name:user.display_name||user.email,role};
      await put('kv',state.operator,'operator');
      await put('kv',false,'locked');
      localStorage.removeItem('verre.pos.locked');
      unlock();
    }catch(error){
      if(error.auth&&navigator.onLine){signIn();return}
      if(!state.operator){showLock('Reconnect and sign in once before this device can be used offline.');return}
      $('#operator').textContent=(state.operator.display_name||state.operator.email)+' - Offline';
      const wasLocked=Boolean(await get('kv','locked'))||localStorage.getItem('verre.pos.locked')==='1';
      if(wasLocked||!state.operator.pin_hash){
        showLock(wasLocked?'This POS was signed out. Reconnect and sign in to unlock it.':'Offline access needs a device PIN set while signed in.');
        return;
      }
      showLock('Enter the offline device PIN for '+state.operator.email+'.');
      return;
    }

    await refreshCatalog();
    if(navigator.onLine)syncQueue();
  }catch(error){toast(error.name==='QuotaExceededError'?'Device storage is full. Free space before continuing.':error.message,true)}
  updateNetwork();
}

async function refreshCatalog(){
  try{
    const result=await api('products');
    const products=Array.isArray(result)?result:Array.isArray(result?.products)?result.products:null;
    if(products&&!result?.stale){
      const local=new Map(state.products.map(p=>[p.id,p.stock_on_hand]));
      state.products=products.map(p=>({...p,stock_on_hand:local.has(p.id)&&state.queue.length?Math.min(p.stock_on_hand,local.get(p.id)):p.stock_on_hand}));
      await put('kv',state.products,'catalog');renderProducts();
      cacheImages(products);
    }else if(result?.stale&&state.products.length){
      toast('Using the last verified catalog. Reconnect before taking a sale.',true);
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
  $('#categories').innerHTML=values.map(value=>`<button type="button" aria-pressed="${state.category===value}" data-category="${esc(value)}" class="${state.category===value?'active':''}">${value==='all'?'All':esc(value)}</button>`).join('');
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
  $('#pending-count').textContent=state.queue.length+state.commands.length;
  $('#queue-button').classList.toggle('pending',state.queue.length>0||state.review.length>0||state.commands.length>0);
  const saleRows=state.queue.map(sale=>`<div class="queue-item"><strong>Pending sale</strong> - ${money(sale.total_cents)}<br><small>${new Date(sale.sold_at).toLocaleString('en-PH')} - ${esc(sale.client_uuid)}</small>${sale.sync_error?`<br><small>${esc(sale.sync_error)}</small>`:''}</div>`);
  const commandRows=state.commands.map(command=>`<div class="queue-item"><strong>${command.type.includes('open')?'Session open':'Session close'}</strong><br><small>${new Date(command.created_at).toLocaleString('en-PH')} - ${esc(command.local_id)}</small></div>`);
  const reviewRows=state.review.map(sale=>`<div class="queue-item"><strong>Sale needs review</strong> - ${money(sale.total_cents)}<br><small>${new Date(sale.sold_at).toLocaleString('en-PH')} - ${esc(sale.client_uuid)}</small><br><small>${esc(sale.sync_error||'Rejected by the server')}</small><div class="review-actions"><button data-review-retry="${esc(sale.client_uuid)}">Retry</button><button data-review-export="${esc(sale.client_uuid)}">Export record</button><a href="/admin/#orders">Open reconciliation</a></div></div>`);
  const rows=[...saleRows,...commandRows,...reviewRows];
  $('#queue-list').innerHTML=rows.length?rows.join(''):'<div class="empty">Everything is synced.</div>';
  $('#queue-message').textContent=state.review.length?'A rejected sale is preserved below. Retry it or export it for supervised reconciliation.':state.queue.length||state.commands.length?'Sessions sync before their sales, then close after every sale is recorded.':'No pending records.';
  $$('[data-review-retry]').forEach(button=>button.onclick=()=>retryReview(button.dataset.reviewRetry));
  $$('[data-review-export]').forEach(button=>button.onclick=()=>exportReview(button.dataset.reviewExport));
}

async function retryReview(id){
  const sale=state.review.find(item=>item.client_uuid===id);if(!sale)return;
  if(sale.operator_email&&sale.operator_email!==state.operator?.email){showLock('Only the recorded operator can retry this sale.');return}
  delete sale.sync_error;await remove('review',id);await put('queue',sale);
  state.review=state.review.filter(item=>item.client_uuid!==id);state.queue.push(sale);renderQueue();syncQueue();
}
function exportReview(id){
  const sale=state.review.find(item=>item.client_uuid===id);if(!sale)return;
  const blob=new Blob([JSON.stringify({exported_at:new Date().toISOString(),sale},null,2)],{type:'application/json'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='verre-pos-review-'+id+'.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}

async function completeSale(){
  const value=totals();
  if(!state.session&&!confirm('There is no open session. Complete this sale anyway?'))return;
  const tender=state.payment==='cash'?parsePeso($('#tendered').value):null;
  if(state.payment==='cash'&&(tender==null||tender<value.total)){toast('Tendered cash must cover the total.',true);return}
  const sale={
    client_uuid:uuid(),sold_at:new Date().toISOString(),session_id:state.session?.remote_id||null,
    session_local_id:state.session?.local_id||null,operator_email:state.operator?.email||null,
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
}
function nextSale(){if($('#success').open)$('#success').close();state.cart.clear();$('#discount').value='';$('#discount-reason').value='';$('#tendered').value='';$('#gcash-reference').value='';setCartView('cart');renderCart()}

function scheduleSync(){
  clearTimeout(state.syncTimer);
  const wait=state.syncDelay+Math.random()*500;
  state.syncTimer=setTimeout(syncQueue,wait);
  state.syncDelay=Math.min(state.syncDelay*2,30000);
}

async function saveCommand(command){await put('commands',command);state.commands=state.commands.filter(item=>item.id!==command.id).concat(command);renderQueue()}
async function dropCommand(id){await remove('commands',id);state.commands=state.commands.filter(item=>item.id!==id);renderQueue()}
async function sessionRecord(localId){return get('kv','session-record:'+localId)}
async function saveSessionRecord(session){
  await put('kv',session,'session-record:'+session.local_id);
  if(state.session?.local_id===session.local_id){state.session=session;await put('kv',session,'session');renderSession()}
}

async function syncSessionOpens(){
  const opens=state.commands.filter(command=>command.type==='session_open').sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  for(const command of opens){
    if(command.operator_email!==state.operator?.email)throw new Error('Pending session belongs to another operator.');
    const remote=await api('sessions',{method:'POST',body:JSON.stringify({
      client_uuid:command.local_id,label:command.label,device_label:command.device_label,
      opening_float_cents:command.opening_float_cents,opened_at:command.opened_at
    })});
    const record=await sessionRecord(command.local_id)||command;
    record.remote_id=remote?.id||remote?.[0]?.id;
    record.synced_by_client=true;
    if(!record.remote_id)throw new Error('Session opened without an id.');
    await saveSessionRecord(record);
    for(const sale of state.queue.filter(item=>item.session_local_id===command.local_id)){
      sale.session_id=record.remote_id;await put('queue',sale);
    }
    await dropCommand(command.id);
  }
}

async function syncSalesQueue(){
  const ordered=[...state.queue].sort((a,b)=>new Date(a.sold_at)-new Date(b.sold_at));
  for(let index=0;index<ordered.length;index+=20){
    const batch=ordered.slice(index,index+20);
    if(batch.some(sale=>sale.operator_email&&sale.operator_email!==state.operator?.email))throw new Error('Pending sale belongs to another operator.');
    if(batch.some(sale=>sale.session_local_id&&!sale.session_id))throw new Error('Waiting for the market session to sync first.');
    const results=await api('sync',{method:'POST',body:JSON.stringify({sales:batch})});
    for(const result of results||[]){
      const sale=state.queue.find(item=>item.client_uuid===result.client_uuid);
      if(!sale)continue;
      if(result.ok){
        await remove('queue',sale.client_uuid);state.queue=state.queue.filter(item=>item.client_uuid!==sale.client_uuid);
        sale.server_ref=result.order?.ref;
        if(state.lastSale?.client_uuid===sale.client_uuid){state.lastSale=sale;if($('#success').open)showSuccess(sale)}
        if(result.oversell)toast((result.order?.ref||'Sale')+' synced with an oversell - check the dashboard.',true);
      }else if(result.permanent){
        sale.sync_error=result.error;await remove('queue',sale.client_uuid);await put('review',sale);
        state.queue=state.queue.filter(item=>item.client_uuid!==sale.client_uuid);state.review.push(sale);
      }else{
        sale.sync_error=result.error;await put('queue',sale);
      }
    }
    renderQueue();
  }
}

async function syncSessionCloses(){
  const closes=state.commands.filter(command=>command.type==='session_close'||command.type==='session_close_legacy').sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  for(const command of closes){
    if(state.queue.some(sale=>sale.session_local_id===command.local_id))continue;
    if(command.operator_email!==state.operator?.email)throw new Error('Pending session close belongs to another operator.');
    if(command.type==='session_close_legacy'){
      await api('sessions/'+command.remote_id+'/close',{method:'POST',body:JSON.stringify({closing_cash_cents:command.closing_cash_cents})});
    }else{
      await api('sessions/close-offline',{method:'POST',body:JSON.stringify({
        client_uuid:command.local_id,closing_cash_cents:command.closing_cash_cents,closed_at:command.closed_at
      })});
    }
    await dropCommand(command.id);await remove('kv','session-record:'+command.local_id);
  }
}

async function syncQueue(){
  if(state.syncing||state.locked||!navigator.onLine)return;
  if(!state.queue.length&&!state.commands.length)return;
  state.syncing=true;clearTimeout(state.syncTimer);
  try{
    await syncSessionOpens();
    await syncSalesQueue();
    await syncSessionCloses();
    await refreshCatalog();
    state.syncDelay=600;
  }catch(error){
    toast('Sync paused: '+error.message,true);
    if(error.auth)showLock('Your session expired. Reconnect and sign in as '+(state.operator?.email||'the recorded operator')+'.');
    else scheduleSync();
  }finally{state.syncing=false;renderQueue()}
}

async function undoLast(){
  const sale=state.lastSale;if(!sale)return;
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
  if(!state.operator?.email){showLock('Sign in before starting a market session.');return}
  const now=new Date().toISOString(),localId=uuid();
  const session={
    local_id:localId,remote_id:null,synced_by_client:false,label,opening_float_cents:opening,
    opened_at:now,operator_email:state.operator.email,device_label:navigator.platform
  };
  const command={
    id:localId+':open',type:'session_open',local_id:localId,label,
    opening_float_cents:opening,opened_at:now,operator_email:state.operator.email,
    device_label:navigator.platform,created_at:now
  };
  state.session=session;await put('kv',session,'session');await saveSessionRecord(session);await saveCommand(command);
  $('#session-dialog').close();renderSession();toast(navigator.onLine?'Session is syncing.':'Session saved on this device.');
  if(navigator.onLine)syncQueue();
}

async function closeSession(){
  const counted=parsePeso($('#closing-cash').value);if(counted==null){toast('Enter valid counted cash.',true);return}
  if(!state.session)return;
  const session=state.session,now=new Date().toISOString();
  const command={
    id:session.local_id+':close',type:session.synced_by_client||!session.remote_id?'session_close':'session_close_legacy',
    local_id:session.local_id,remote_id:session.remote_id||null,closing_cash_cents:counted,
    closed_at:now,operator_email:session.operator_email||state.operator?.email,created_at:now
  };
  await saveCommand(command);
  session.closing_cash_cents=counted;session.closed_at=now;await saveSessionRecord(session);
  state.session=null;await remove('kv','session');$('#session-dialog').close();renderSession();
  toast(navigator.onLine?'Session close is syncing.':'Session close saved and will sync before reconciliation.');
  if(navigator.onLine)syncQueue();
}

async function saveOfflinePin(event){
  event.preventDefault();
  const pin=$('#new-pin').value;
  if(!/^\d{6}$/.test(pin)){toast('Use exactly six digits.',true);return}
  if(!state.operator?.email){showLock('Sign in before setting an offline PIN.');return}
  const salt=state.operator.pin_salt||uuid();
  state.operator.pin_salt=salt;state.operator.pin_hash=await pinHash(state.operator.email,pin,salt);
  await put('kv',state.operator,'operator');$('#new-pin').value='';$('#pin-dialog').close();toast('Offline PIN saved.');
}
async function unlockOffline(){
  const pin=$('#offline-pin').value;
  if(!state.operator?.pin_hash||!/^\d{6}$/.test(pin)){toast('Enter the six-digit offline PIN.',true);return}
  const candidate=await pinHash(state.operator.email,pin,state.operator.pin_salt);
  if(candidate!==state.operator.pin_hash){toast('That PIN is not right.',true);return}
  await put('kv',false,'locked');localStorage.removeItem('verre.pos.locked');$('#offline-pin').value='';unlock();toast('Offline POS unlocked.');
}
async function lockDevice(){
  await put('kv',true,'locked');localStorage.setItem('verre.pos.locked','1');
  try{await fetch('/api/auth/logout',{method:'POST'})}catch{}
  showLock('This POS is locked. Reconnect and sign in as the recorded operator to continue.');
}
async function secureReset(){
  if(state.queue.length||state.review.length||state.commands.length||state.session){toast('Sync or reconcile every pending record before resetting this device.',true);return}
  if(!confirm('Remove the enrolled operator and cached catalog from this device?'))return;
  const database=await openDb();database.close();
  await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase('verre-pos');request.onsuccess=resolve;request.onerror=()=>reject(request.error)});
  if('caches'in window)for(const key of await caches.keys())if(key.startsWith('verre-pos'))await caches.delete(key);
  localStorage.setItem('verre.pos.locked','1');location.replace('/login?return_to=/pos/');
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
$('#set-pin').onclick=()=>$('#pin-dialog').showModal();
$('#pin-form').addEventListener('submit',saveOfflinePin);
$('#lock-pos').onclick=lockDevice;
$('#unlock-offline').onclick=unlockOffline;
$('#reconnect-signin').onclick=signIn;
$('#secure-reset').onclick=secureReset;
$$('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
window.addEventListener('online',()=>{updateNetwork();syncQueue()});window.addEventListener('offline',updateNetwork);
window.addEventListener('storage',event=>{if(event.key==='verre.pos.locked'&&event.newValue==='1')showLock('This POS was locked from another Verre screen. Reconnect and sign in to continue.')});
setInterval(syncQueue,30000);
init();
