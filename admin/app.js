const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const main=$('#main'), modal=$('#modal'), modalBody=$('#modal-body');
const money=(c=0)=>'₱'+(Number(c)/100).toLocaleString('en-PH',{minimumFractionDigits:2});
const date=(v)=>new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Manila'}).format(new Date(v));
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={products:[],orders:[],movements:[],sessions:[],dirty:false};

async function api(path,options={}){
  const response=await fetch('/api/admin/'+path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  const type=response.headers.get('content-type')||'';
  if(!type.includes('application/json'))throw new Error(response.redirected?'Session expired — sign in again.':'The server returned an unreadable response.');
  const body=await response.json();
  if(!response.ok||!body.ok)throw new Error(body.error||'Request failed');
  return body.data??body;
}
function toast(message,error=false){const el=$('#toast');el.textContent=message;el.style.background=error?'#EF4056':'#3A2430';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3200)}
function heading(eyebrow,title,copy=''){return `<p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${copy?`<p class="sub">${copy}</p>`:''}`}
function openModal(html){modalBody.innerHTML=html;modal.showModal();setTimeout(()=>modalBody.querySelector('input,button,select,textarea')?.focus())}
function closeModal(){modal.close();modalBody.innerHTML='';state.dirty=false}
$('.modal-close').onclick=()=>{if(!state.dirty||confirm('Discard unsaved changes?'))closeModal()};
modal.addEventListener('cancel',e=>{if(state.dirty&&!confirm('Discard unsaved changes?'))e.preventDefault()});
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue=''}});

function route(){return location.hash.slice(1)||'dashboard'}
async function render(){
  const current=route();$$('[data-route]').forEach(a=>a.classList.toggle('active',a.dataset.route===current));
  main.innerHTML='<div class="loading">Loading…</div>';
  try{
    if(current==='dashboard')await dashboard();
    else if(current==='products')await products();
    else if(current==='inventory')await inventory();
    else if(current==='orders')await orders();
    else if(current==='sessions')await sessions();
    else location.hash='dashboard';
    main.focus();
  }catch(error){main.innerHTML=setupError(error)}
}
function setupError(error){return `${heading('Needs setup','The studio could not load')}<div class="card attention"><h2>${esc(error.message)}</h2><p>Check the Worker’s private Supabase and authentication configuration. Your storefront remains available while admin is offline.</p><button onclick="location.reload()">Try again</button></div>`}

async function dashboard(refresh=false){
  const data=await api('dashboard'+(refresh?'?refresh=1':''));
  const a=data.attention;
  const alerts=[
    ...a.unanswered.map(o=>`Unanswered ${o.ref} is older than 48 hours`),
    ...a.oversells.map(o=>`${o.ref} needs attention — sold twice`),
    ...a.out_of_stock.map(p=>`${p.name} is active but sold out`),
    ...a.low_stock.map(p=>`${p.name} is low (${p.stock_on_hand} left)`),
    ...a.open_sessions.map(s=>`Session “${s.label}” has been open over 24 hours`),
    ...a.ledger_drift.map(p=>`Ledger drift on ${p.name}`)
  ];
  const max=Math.max(1,...data.daily.map(d=>d.revenue_cents));
  main.innerHTML=heading('Today at a glance','Studio dashboard','Manila time · the things needing action come first.')+
    `<div class="toolbar"><button id="refresh-dashboard" class="secondary">Refresh metrics</button></div>`+
    `<section class="card attention"><h2>Needs attention</h2><div class="attention-list">${alerts.length?alerts.map(x=>`<div class="alert">${esc(x)}</div>`).join(''):'<p>Nothing urgent. Lovely.</p>'}</div></section>
    <section class="grid metrics">
      ${metric('Revenue',money(data.revenue_cents))}${metric('Orders',data.order_count)}${metric('Average order',money(data.average_order_cents))}${metric('Units sold',data.units)}
    </section>
    <section class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
      <div class="card"><h2>Revenue by day</h2><div class="spark" aria-label="Revenue chart">${data.daily.length?data.daily.map(d=>`<i title="${esc(d.date)}: ${money(d.revenue_cents)}" style="height:${Math.max(5,d.revenue_cents/max*100)}%"></i>`).join(''):'<p>No paid orders yet.</p>'}</div></div>
      <div class="card"><h2>Top products</h2>${data.top_products.length?data.top_products.map((p,i)=>`<p><strong>${i+1}. ${esc(p.name)}</strong><br><small>${p.units} units · ${money(p.revenue_cents)}</small></p>`).join(''):'<p>No sales yet.</p>'}</div>
    </section>`;
  $('#refresh-dashboard').onclick=()=>dashboard(true);
}
const metric=(label,value)=>`<div class="card metric"><span>${label}</span><strong>${value}</strong></div>`;

async function products(){
  state.products=await api('products');
  main.innerHTML=heading('Catalog','Products','Search, publish, archive, and keep every public slug stable.')+
    `<div class="toolbar"><input id="search" type="search" placeholder="Search name or slug"><select id="category"><option value="">All categories</option><option>glass</option><option>charms</option><option>stickers</option></select><select id="status"><option value="">All statuses</option><option>active</option><option>draft</option><option>archived</option></select><select id="sort"><option value="name">Name</option><option value="stock">Lowest stock</option></select><button class="primary" id="new-product">Add product</button></div><div id="products-table"></div>`;
  const update=()=>drawProducts();
  $$('#search,#category,#status,#sort').forEach(el=>el.addEventListener('input',update));
  $('#new-product').onclick=()=>productForm();
  drawProducts();
}
function drawProducts(){
  const q=$('#search').value.toLowerCase(),cat=$('#category').value,status=$('#status').value,sort=$('#sort').value;
  const rows=state.products.filter(p=>(!q||(p.name+' '+p.slug).toLowerCase().includes(q))&&(!cat||p.category===cat)&&(!status||p.status===status))
    .sort((a,b)=>sort==='stock'?a.stock_on_hand-b.stock_on_hand:a.name.localeCompare(b.name));
  $('#products-table').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>Piece</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(p=>`<tr class="${p.stock_on_hand===0?'out':p.stock_on_hand<=p.low_stock_at?'low':''}"><td><strong>${esc(p.name)}</strong><br><small>${esc(p.slug)}</small></td><td>${esc(p.category)}</td><td>${money(p.price_cents)}</td><td>${p.stock_on_hand}</td><td><span class="status ${p.status}">${p.status}</span></td><td><div class="row-actions"><button data-edit="${p.id}">Edit</button><button class="secondary" data-archive="${p.id}">Archive</button></div></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No products match those filters.</div>';
  $$('[data-edit]').forEach(b=>b.onclick=()=>productForm(state.products.find(p=>p.id===b.dataset.edit)));
  $$('[data-archive]').forEach(b=>b.onclick=()=>archive(b.dataset.archive));
}
const slugify=v=>v.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function parsePeso(v){const cleaned=String(v).replace(/[₱,\s]/g,'');if(!/^\d+(?:\.\d{1,2})?$/.test(cleaned))return null;return Math.round(Number(cleaned)*100)}
function productForm(p={}){
  const locked=Boolean(p.was_ever_active);
  openModal(`<p class="eyebrow">${p.id?'Edit product':'New product'}</p><h2>${esc(p.name||'A new handmade piece')}</h2>
  <form id="product-form" class="form-grid" novalidate>
    ${field('name','Name',p.name,true)}${field('slug','Slug',p.slug,true,locked)}
    <label>Category<select name="category"><option>glass</option><option>charms</option><option>stickers</option></select></label>
    ${field('tag','Card tag',p.tag,true)}${field('price','Price in pesos',p.price_cents!=null?(p.price_cents/100).toFixed(2):'',true)}
    <label>Status<select name="status"><option>draft</option><option>active</option><option>archived</option></select></label>
    <label><span>One of a kind</span><input name="one_of_a_kind" type="checkbox" ${p.one_of_a_kind?'checked':''}></label>
    ${field('low_stock_at','Low-stock warning',p.low_stock_at??2,true,'', 'number')}
    ${field('sort_order','Sort order',p.sort_order??0,true,'','number')}
    ${area('blurb','Card hook',p.blurb)}${area('description','Description',p.description)}
    ${field('dimensions','Dimensions',p.dimensions)}${field('materials','Materials',p.materials)}
    ${area('care','Care',p.care)}${field('lead_time','Lead time',p.lead_time)}
    ${field('bg_color','Card color',p.bg_color||'#FFE1EF')}${field('tape_color','Tape color',p.tape_color||'#FFD166')}
    <div class="span-2 preview"><h3>Card preview</h3><div class="preview-card" id="preview"></div></div>
    ${p.id?`<section class="span-2 card" id="image-panel"><h3>Product photos</h3><p>Drag photos to reorder them; the first is primary.</p><div class="image-list">${(p.images||[]).map(image=>`<figure draggable="true" data-image-id="${image.id}"><img class="thumb" src="${esc(image.url||'')}" alt="${esc(image.alt)}"><figcaption>${esc(image.alt)}</figcaption><button type="button" data-delete-image="${image.id}">Delete</button></figure>`).join('')||'<p>No product photos yet. The atlas remains as a fallback.</p>'}</div><div id="image-drop" class="drop-zone"><label>Required alt text<input id="image-alt" placeholder="Describe what is visible"></label><label>Choose photos<input id="image-files" type="file" accept="image/*" multiple></label><p>Drop photos here or choose files. Originals over 10 MB are rejected; uploads become WebP at max 1600 px.</p></div></section>`:''}
    <p class="error span-2" id="product-error" role="status"></p>
    <div class="span-2 form-actions">${p.id?'<button type="button" class="danger" id="delete-product">Hard delete</button>':''}<button type="button" class="secondary" id="cancel-product">Cancel</button><button class="primary">Save product</button></div>
  </form>`);
  const form=$('#product-form');form.category.value=p.category||'glass';form.status.value=p.status||'draft';
  if(locked)form.slug.title='This slug has been public and cannot change.';
  const sync=()=>{if(!p.id&&!form.slug.dataset.edited)form.slug.value=slugify(form.name.value);form.low_stock_at.closest('label').hidden=form.one_of_a_kind.checked;$('#preview').innerHTML=`<div style="height:120px;border-radius:8px;background:${esc(form.bg_color.value)}"></div><h3>${esc(form.name.value||'Product name')}</h3><small>${esc(form.tag.value||'Tag')}</small><p><strong>${money(parsePeso(form.price.value)||0)}</strong></p>`;state.dirty=true};
  form.slug.addEventListener('input',()=>form.slug.dataset.edited='1');form.addEventListener('input',sync);sync();state.dirty=false;
  $('#cancel-product').onclick=()=>{if(!state.dirty||confirm('Discard unsaved changes?'))closeModal()};
  if(p.id){
    const drop=$('#image-drop'),input=$('#image-files');
    const upload=(files)=>uploadImages(p,[...files]);
    input.onchange=()=>upload(input.files);
    drop.ondragover=e=>{e.preventDefault();drop.classList.add('dragging')};
    drop.ondragleave=()=>drop.classList.remove('dragging');
    drop.ondrop=e=>{e.preventDefault();drop.classList.remove('dragging');upload(e.dataTransfer.files)};
    $$('[data-delete-image]').forEach(button=>button.onclick=async()=>{if(!confirm('Delete this photo from storage?'))return;try{await api('images/'+button.dataset.deleteImage,{method:'DELETE'});button.closest('figure').remove();toast('Photo deleted')}catch(error){toast(error.message,true)}});
    let dragging=null;
    $$('[data-image-id]').forEach(figure=>{
      figure.ondragstart=()=>dragging=figure;
      figure.ondragover=e=>e.preventDefault();
      figure.ondrop=async e=>{e.preventDefault();if(!dragging||dragging===figure)return;figure.before(dragging);const ids=$$('[data-image-id]').map(node=>node.dataset.imageId);try{await api('images/reorder',{method:'POST',body:JSON.stringify({product_id:p.id,ids})});toast('Photo order saved')}catch(error){toast(error.message,true)}};
    });
    $('#delete-product').onclick=async()=>{if(prompt(`Type ${p.slug} to permanently delete this draft with no order history:`)!==p.slug)return;try{await api('products/'+p.id,{method:'DELETE'});state.dirty=false;closeModal();toast('Product permanently deleted');products()}catch(error){toast(error.message,true)}};
  }
  form.onsubmit=async e=>{e.preventDefault();const fd=new FormData(form),price=parsePeso(fd.get('price'));let error='';
    const slug=locked?p.slug:fd.get('slug');
    if(!fd.get('name').trim())error='Name is required.';else if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))error='Slug must be lowercase kebab-case.';else if(price==null)error='Enter a valid peso amount such as 850, 850.50, ₱850, or 1,250.';
    if(error){$('#product-error').textContent=error;return}
    const body=Object.fromEntries(fd);body.slug=slug;body.price_cents=price;body.one_of_a_kind=form.one_of_a_kind.checked;body.low_stock_at=body.one_of_a_kind?0:Number(body.low_stock_at);body.sort_order=Number(body.sort_order);delete body.price;
    try{await api('products'+(p.id?'/'+p.id:''),{method:p.id?'PATCH':'POST',body:JSON.stringify(body)});state.dirty=false;closeModal();toast('Product saved');products()}catch(err){$('#product-error').textContent=err.message}
  };
}
async function uploadImages(product,files){
  const alt=$('#image-alt').value.trim();
  if(!alt)return toast('Alt text is required before uploading.',true);
  for(const file of files){
    if(!file.type.startsWith('image/')){toast(file.name+' is not an image.',true);continue}
    if(file.size>10*1024*1024){toast(file.name+' is over 10 MB.',true);continue}
    try{
      const blob=await resizeWebp(file);
      const signed=await api('images/sign',{method:'POST',body:JSON.stringify({product_id:product.id,filename:file.name})});
      const upload=await fetch(signed.signedUrl,{method:'PUT',headers:{'content-type':'image/webp'},body:blob});
      if(!upload.ok)throw new Error('Storage upload failed ('+upload.status+')');
      await api('images',{method:'POST',body:JSON.stringify({product_id:product.id,storage_path:signed.path,alt,position:(product.images||[]).length})});
      toast(file.name+' uploaded');
    }catch(error){toast(error.message,true)}
  }
  state.dirty=false;closeModal();products();
}
async function resizeWebp(file){
  const bitmap=await createImageBitmap(file),scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not convert photo to WebP')),'image/webp',.86));
}
const field=(name,label,value='',required=false,disabled=false,type='text')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${disabled?'disabled':''}></label>`;
const area=(name,label,value='')=>`<label class="span-2">${label}<textarea name="${name}" rows="3">${esc(value||'')}</textarea></label>`;
async function archive(id){if(!confirm('Archive this product? It will leave the public shop but keep its order history.'))return;try{await api(`products/${id}/archive`,{method:'POST'});toast('Product archived');products()}catch(e){toast(e.message,true)}}

async function inventory(){
  [state.products,state.movements]=await Promise.all([api('products'),api('inventory/movements')]);
  main.innerHTML=heading('Count what exists','Inventory','Every change writes a ledger entry; stock is never overwritten.')+
  `<div class="toolbar"><button id="stocktake" class="primary">Count everything</button><a class="button secondary" href="/api/admin/inventory/movements?format=csv">Export CSV</a><select id="reason-filter"><option value="">All reasons</option>${['made','sale_pos','sale_web','return','damaged','gifted','stocktake','oversell_correction','initial'].map(x=>`<option>${x}</option>`).join('')}</select></div>
  <div class="table-wrap"><table><thead><tr><th>Product</th><th>On hand</th><th>Quick adjust</th><th>Threshold</th></tr></thead><tbody>${state.products.map(p=>`<tr class="${p.stock_on_hand===0?'out':p.stock_on_hand<=p.low_stock_at?'low':''}"><td><strong>${esc(p.name)}</strong></td><td>${p.stock_on_hand}</td><td><div class="stock-step"><button aria-label="Remove one ${esc(p.name)}" data-adjust="${p.id}" data-delta="-1">−</button><button aria-label="Add one ${esc(p.name)}" data-adjust="${p.id}" data-delta="1">+</button><button class="secondary" data-full-adjust="${p.id}">Details</button></div></td><td>${p.one_of_a_kind?'One-off':p.low_stock_at}</td></tr>`).join('')}</tbody></table></div>
  <section class="card" style="margin-top:24px"><h2>Movement history</h2><div id="movements">${movementList(state.movements)}</div></section>`;
  $$('[data-adjust]').forEach(b=>b.onclick=()=>adjust(b.dataset.adjust,Number(b.dataset.delta),Number(b.dataset.delta)>0?'made':'damaged','Quick adjustment'));
  $$('[data-full-adjust]').forEach(b=>b.onclick=()=>adjustForm(b.dataset.fullAdjust));
  $('#reason-filter').onchange=async e=>{$('#movements').innerHTML=movementList(await api('inventory/movements?reason='+encodeURIComponent(e.target.value)))};
  $('#stocktake').onclick=stocktakeForm;
}
const movementList=rows=>rows.length?`<div class="timeline">${rows.slice(0,100).map(m=>`<div class="movement"><strong class="${m.delta>0?'positive':'negative'}">${m.delta>0?'+':''}${m.delta}</strong> ${esc(m.products?.name||m.product_id)} · ${esc(m.reason)}<br><small>${date(m.created_at)}${m.note?' · '+esc(m.note):''}</small></div>`).join('')}</div>`:'<p>No movements yet.</p>';
async function adjust(product_id,delta,reason,note){try{await api('inventory/adjust',{method:'POST',body:JSON.stringify({product_id,delta,reason,note})});toast('Stock updated');inventory()}catch(e){toast(e.message,true)}}
function adjustForm(id){const p=state.products.find(x=>x.id===id);openModal(`<h2>Adjust ${esc(p.name)}</h2><form id="adjust-form" class="form-grid">${field('delta','Quantity change','1',true,'','number')}<label>Reason<select name="reason">${['made','return','damaged','gifted','stocktake'].map(x=>`<option>${x}</option>`).join('')}</select></label>${area('note','Note')}<div class="span-2 form-actions"><button class="primary">Record movement</button></div></form>`);$('#adjust-form').onsubmit=e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.target));closeModal();adjust(id,Number(b.delta),b.reason,b.note)}}
function stocktakeForm(){openModal(`<h2>Physical stocktake</h2><p>Enter what you can count. You’ll see the variance before anything changes.</p><form id="count-form"><div class="grid">${state.products.map(p=>`<label>${esc(p.name)} · system ${p.stock_on_hand}<input type="number" min="0" name="${p.id}" value="${p.stock_on_hand}"></label>`).join('')}</div><div id="variance" class="card" style="margin-top:16px"></div><div class="form-actions"><button class="primary">Commit stocktake</button></div></form>`);const f=$('#count-form');const show=()=>{$('#variance').innerHTML=state.products.map(p=>{const d=Number(f.elements[p.id].value)-p.stock_on_hand;return d?`<p>${esc(p.name)}: <strong>${d>0?'+':''}${d}</strong></p>`:''}).join('')||'<p>No differences.</p>'};f.oninput=show;show();f.onsubmit=async e=>{e.preventDefault();if(!confirm('Record every displayed variance?'))return;try{await api('inventory/stocktake',{method:'POST',body:JSON.stringify({counts:state.products.map(p=>({product_id:p.id,counted:Number(f.elements[p.id].value)}))})});closeModal();toast('Stocktake recorded');inventory()}catch(err){toast(err.message,true)}}}

async function orders(){
  state.orders=await api('orders');
  main.innerHTML=heading('From hello to fulfilled','Orders','Inquiries move through quote, payment, and fulfillment; stock moves only when paid.')+
  `<div class="toolbar"><input id="order-search" type="search" placeholder="Ref, name, email"><select id="order-status"><option value="">All statuses</option>${['inquiry','quoted','paid','fulfilled','cancelled'].map(x=>`<option>${x}</option>`).join('')}</select></div><div id="orders-table"></div>`;
  $('#order-search').oninput=$('#order-status').onchange=drawOrders;drawOrders();
}
function drawOrders(){const q=$('#order-search').value.toLowerCase(),s=$('#order-status').value;const rows=state.orders.filter(o=>(!q||(o.ref+' '+o.customer_name+' '+o.customer_email).toLowerCase().includes(q))&&(!s||o.status===s));$('#orders-table').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>Ref</th><th>Customer</th><th>Total</th><th>Channel</th><th>Status</th><th>Created</th></tr></thead><tbody>${rows.map(o=>`<tr class="${o.is_oversell?'low':''}" data-order="${o.id}" tabindex="0"><td><strong>${esc(o.ref)}</strong>${o.is_oversell?'<br><small>Needs attention — sold twice</small>':''}</td><td>${esc(o.customer_name||'Walk-in')}<br><small>${esc(o.customer_email||'')}</small></td><td>${money(o.total_cents)}</td><td>${o.channel}</td><td><span class="status ${o.status}">${o.status}</span></td><td>${date(o.created_at)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No orders found.</div>';$$('[data-order]').forEach(r=>{r.onclick=()=>orderDetail(r.dataset.order);r.onkeydown=e=>{if(e.key==='Enter')r.click()}})}
async function orderDetail(id){const o=await api('orders/'+id);openModal(`<p class="eyebrow">${esc(o.channel)} order</p><h2>${esc(o.ref)}</h2>${o.is_oversell?'<div class="alert">Needs attention — sold twice. Contact the customer to refund or remake.</div>':''}<p><strong>${esc(o.customer_name||'Walk-in')}</strong><br>${esc(o.customer_email||'')} ${esc(o.customer_phone||'')}</p><div class="card">${(o.order_items||[]).map(i=>`<p>${i.qty} × ${esc(i.product_name)} <strong style="float:right">${money(i.line_total_cents)}</strong></p>`).join('')}<hr><p>Total <strong style="float:right">${money(o.total_cents)}</strong></p></div><div class="form-actions"><a class="button secondary" href="mailto:${encodeURIComponent(o.customer_email||'')}?subject=${encodeURIComponent('Verre order '+o.ref)}">Email customer</a>${['inquiry','quoted','paid','fulfilled','cancelled'].map(s=>`<button data-status="${s}" ${s===o.status?'disabled':''}>${s}</button>`).join('')}</div>`);$$('[data-status]').forEach(b=>b.onclick=async()=>{const note=b.dataset.status==='cancelled'?prompt('Cancellation note:')||'Cancelled by admin':'';try{await api(`orders/${id}/status`,{method:'POST',body:JSON.stringify({status:b.dataset.status,payment_method:b.dataset.status==='paid'?'gcash':null,note})});closeModal();toast('Order updated');orders()}catch(e){toast(e.message,true)}})}

async function sessions(){
  state.sessions=await api('sessions');
  main.innerHTML=heading('Market days','POS sessions','Opening float, running sales, and counted cash stay together.')+
  `<div class="toolbar"><button id="open-session" class="primary">Start session</button></div><div class="table-wrap"><table><thead><tr><th>Label</th><th>Device</th><th>Opened</th><th>Opening float</th><th>Status</th><th></th></tr></thead><tbody>${state.sessions.map(s=>`<tr><td>${esc(s.label)}</td><td>${esc(s.device_label||'')}</td><td>${date(s.opened_at)}</td><td>${money(s.opening_float_cents)}</td><td><span class="status ${s.closed_at?'fulfilled':'inquiry'}">${s.closed_at?'closed':'open'}</span></td><td>${s.closed_at?'':`<button data-close-session="${s.id}">Close</button>`}</td></tr>`).join('')}</tbody></table></div>`;
  $('#open-session').onclick=()=>sessionForm();$$('[data-close-session]').forEach(b=>b.onclick=()=>closeSessionForm(b.dataset.closeSession));
}
function sessionForm(){openModal(`<h2>Start a market session</h2><form id="session-form" class="form-grid">${field('label','Label','',true)}${field('device_label','Device',navigator.platform)}${field('opening','Opening cash','0.00',true)}<div class="span-2 form-actions"><button class="primary">Start</button></div></form>`);$('#session-form').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target)),opening=parsePeso(d.opening);if(opening==null)return toast('Enter a valid opening amount',true);await api('sessions',{method:'POST',body:JSON.stringify({label:d.label,device_label:d.device_label,opening_float_cents:opening})});closeModal();toast('Session started');sessions()}}
function closeSessionForm(id){openModal(`<h2>Close session</h2><form id="close-session-form">${field('cash','Counted cash','0.00',true)}<div class="form-actions"><button class="primary">Close session</button></div></form>`);$('#close-session-form').onsubmit=async e=>{e.preventDefault();const cash=parsePeso(new FormData(e.target).get('cash'));if(cash==null)return;await api(`sessions/${id}/close`,{method:'POST',body:JSON.stringify({closing_cash_cents:cash})});closeModal();toast('Session closed');sessions()}}

window.addEventListener('hashchange',render);
api('me').then(x=>$('#account-email').textContent=x.email).catch(()=>$('#account-email').textContent='Sign-in required');
render();
