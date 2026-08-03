const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const main=$('#main'), modal=$('#modal'), modalBody=$('#modal-body');
const money=(c=0)=>'₱'+(Number(c)/100).toLocaleString('en-PH',{minimumFractionDigits:2});
const date=(v)=>new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Manila'}).format(new Date(v));
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={products:[],orders:[],movements:[],sessions:[],accounts:[],custom:[],optionGroups:[],me:null,dirty:false};
const roleLabels={super_admin:'Super Admin',general_admin:'General Admin',cashier:'Cashier'};
const routeRoles={
  dashboard:['super_admin'],
  products:['super_admin'],
  inventory:['super_admin','general_admin'],
  orders:['super_admin','general_admin'],
  // Quoting a commission is answering a customer, which General Admin already
  // does for web orders. Editing the option tables is a catalog change and is
  // gated separately inside the page, not by the route.
  custom:['super_admin','general_admin'],
  sessions:['super_admin'],
  accounts:['super_admin'],
  themes:['super_admin']
};
function signIn(){
  const returnTo=location.pathname+location.search+location.hash;
  location.replace('/login?return_to='+encodeURIComponent(returnTo));
}
// A POST, not a link: signing out has to revoke the session server-side, or the
// cookie stays valid in whatever captured it and "sign out" is theatre.
async function signOut(){
  try{await fetch('/api/auth/logout',{method:'POST'})}catch{}
  location.replace('/login');
}
document.getElementById('sign-out')?.addEventListener('click',signOut);

async function api(path,options={}){
  const response=await fetch('/api/admin/'+path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  if(response.status===401){signIn();return new Promise(()=>{})}
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
  const current=route();
  if(!state.me)return;
  if(!routeRoles[current]?.includes(state.me.role)){
    const fallback=state.me.role==='general_admin'?'orders':'dashboard';
    // Assigning the hash it already has fires no hashchange, so this used to
    // return into silence and leave the shell on its loading message forever.
    // If we are already at the fallback and still not permitted, the role is
    // missing or unrecognised — say so instead of hanging.
    if(route()===fallback){
      main.innerHTML=setupError(new Error(
        state.me.role?`Your account role (${state.me.role}) has no sections available.`
                     :'Your session did not include a role.'
      ));
      return;
    }
    location.hash=fallback;
    return;
  }
  $$('[data-route]').forEach(a=>a.classList.toggle('active',a.dataset.route===current));
  // Paint the page header and a skeleton of the right shape immediately.
  // Wiping main to a single "Loading…" line collapsed the layout to nothing and
  // then rebuilt it, which is the flash-and-jump the whole page used to do on
  // every nav. The header is known synchronously, so it should never blink.
  const meta=PAGES[current];
  if(!meta){location.hash='dashboard';return}
  main.setAttribute('aria-busy','true');
  main.innerHTML=`<header class="page-head">${heading(meta.eyebrow,meta.title,meta.copy)}</header><div id="page-body">${meta.skeleton()}</div>`;
  try{
    await meta.load();
    main.focus();
  }catch(error){main.innerHTML=setupError(error)}
  finally{main.removeAttribute('aria-busy')}
}

/* Skeletons mirror the real layout closely enough that content swaps into the
   same box it was holding. Approximate shapes are fine; approximate HEIGHTS are
   not, because that is what makes the page jump. */
const skLines=(n,width='100%')=>Array.from({length:n},()=>`<div class="skeleton sk-line" style="width:${width}"></div>`).join('');
const skTable=(rows=6)=>`<div class="sk-panel">${skLines(1,'22%')}${Array.from({length:rows},()=>'<div class="skeleton sk-row"></div>').join('')}</div>`;
const skCards=(n=4)=>`<div class="grid metrics">${Array.from({length:n},()=>'<div class="skeleton sk-card"></div>').join('')}</div>`;
const skDashboard=()=>`<div class="skeleton" style="height:96px;border-radius:22px"></div>${skCards(4)}<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))"><div class="skeleton" style="height:230px;border-radius:22px"></div><div class="skeleton" style="height:230px;border-radius:22px"></div></div>`;

/* One table maps a route to its header, its skeleton and its loader, so adding
   a section cannot leave those three out of step. */
const PAGES={
  dashboard:{eyebrow:'Today at a glance',title:'Studio dashboard',copy:'Manila time · the things needing action come first.',skeleton:skDashboard,load:()=>dashboard()},
  products:{eyebrow:'Catalog',title:'Products',copy:'Search, publish, archive, and keep every public slug stable.',skeleton:()=>skTable(7),load:()=>products()},
  inventory:{eyebrow:'Stock',title:'Inventory',copy:'Every movement is a ledger entry. Nothing edits a count directly.',skeleton:()=>skTable(7),load:()=>inventory()},
  orders:{eyebrow:'Sales',title:'Orders',copy:'Web inquiries and POS sales in one place.',skeleton:()=>skTable(6),load:()=>orders()},
  custom:{eyebrow:'Commissions',title:'Custom orders',copy:'Briefs waiting on a quote, and the steps the wizard asks.',skeleton:()=>skTable(6),load:()=>customPage()},
  sessions:{eyebrow:'Markets',title:'Sessions',copy:'Opening float, counted cash, and the variance between them.',skeleton:()=>skTable(5),load:()=>sessions()},
  accounts:{eyebrow:'Access',title:'Accounts',copy:'Who can sign in, and what each of them may do.',skeleton:()=>skTable(4),load:()=>accounts()},
  themes:{eyebrow:'Marketing',title:'Seasons',copy:'Dress the homepage for the time of year. Runs on a calendar unless you say otherwise.',skeleton:()=>skCards(3),load:()=>themes()}
};

/** Swap just the content region, leaving the already-painted header alone. */
const setBody=(html)=>{const body=$('#page-body');if(body)body.innerHTML=html;else main.innerHTML=html};

const emptyState=(mark,title,copy)=>
  `<div class="empty"><div class="mark" aria-hidden="true">${mark}</div><strong>${esc(title)}</strong><p>${esc(copy)}</p></div>`;
function setupError(error){return `${heading('Needs setup','The studio could not load')}<div class="card attention"><h2>${esc(error.message)}</h2><p>Check the Worker’s private Supabase and authentication configuration. Your storefront remains available while admin is offline.</p><button onclick="location.reload()">Try again</button></div>`}

function configureAccount(){
  $$('[data-roles]').forEach(node=>{
    node.hidden=!node.dataset.roles.split(/\s+/).includes(state.me.role);
  });
  $('#account-email').textContent=state.me.display_name||state.me.email;
  $('#account-email').title=state.me.email;
  $('#account-role').textContent=roleLabels[state.me.role]||state.me.role;
}

async function dashboard(refresh=false){
  const data=await api('dashboard'+(refresh?'?refresh=1':''));
  const a=data.attention;
  // Severity is carried on the item, not inferred from position, so the two
  // that mean "money or a customer is affected right now" stay visually
  // separate from the two that mean "keep an eye on this".
  const alerts=[
    ...a.oversells.map(o=>({level:'urgent',text:`${o.ref} needs attention — sold twice`})),
    ...a.unanswered.map(o=>({level:'urgent',text:`Unanswered ${o.ref} is older than 48 hours`})),
    ...a.ledger_drift.map(p=>({level:'urgent',text:`Ledger drift on ${p.name} — counted stock disagrees with the ledger`})),
    ...a.out_of_stock.map(p=>({level:'',text:`${p.name} is active on the storefront but sold out`})),
    ...a.low_stock.map(p=>({level:'',text:`${p.name} is low (${p.stock_on_hand} left)`})),
    ...a.open_sessions.map(s=>({level:'',text:`Session “${s.label}” has been open over 24 hours`}))
  ];
  setBody(`<div class="toolbar"><button id="refresh-dashboard" class="secondary">Refresh metrics</button></div>`+
    `<section class="card attention"><h2>Needs attention</h2><div class="attention-list">${
      alerts.length
        ? alerts.map(x=>`<div class="alert ${x.level}">${esc(x.text)}</div>`).join('')
        : '<div class="alert calm">Nothing needs you right now.</div>'
    }</div></section>
    <section class="grid metrics">
      ${metric('Revenue',money(data.revenue_cents))}${metric('Orders',data.order_count)}${metric('Average order',money(data.average_order_cents))}${metric('Units sold',data.units)}
    </section>
    <section class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
      <div class="card"><h2>Revenue by day</h2>${revenueChart(data.daily)}</div>
      <div class="card"><h2>Top products</h2>${
        data.top_products.length
          ? data.top_products.map((p,i)=>`<div class="rank"><b>${i+1}</b><div><strong>${esc(p.name)}</strong><br><small>${p.units} units · ${money(p.revenue_cents)}</small></div></div>`).join('')
          : emptyState('✦','No sales yet','Once an order is marked paid, your best sellers appear here.')
      }</div>
    </section>`);
  $('#refresh-dashboard').onclick=()=>dashboard(true);
}
const metric=(label,value)=>`<div class="card metric"><span>${label}</span><strong>${value}</strong></div>`;

/**
 * Revenue bars as real SVG rather than flex-height <i> elements.
 *
 * The old version had no scale at all: every chart looked identical because the
 * tallest bar was always 100%, so a ₱200 day and a ₱20,000 day drew the same
 * picture. A labelled axis is the difference between decoration and a number
 * you can act on.
 */
function revenueChart(daily=[]){
  if(!daily.length)return emptyState('✦','No paid orders yet','Revenue appears here once an order reaches the paid stage.');
  const W=600,H=150,pad={l:46,r:6,t:10,b:20};
  const max=Math.max(1,...daily.map(d=>d.revenue_cents));
  const plotW=W-pad.l-pad.r, plotH=H-pad.t-pad.b;
  const slot=plotW/daily.length, barW=Math.max(3,Math.min(26,slot*.62));
  const peso=(c)=>'₱'+Math.round(c/100).toLocaleString('en-PH');
  const bars=daily.map((d,i)=>{
    const h=Math.max(2,(d.revenue_cents/max)*plotH);
    const x=pad.l+slot*i+(slot-barW)/2;
    return `<rect class="bar" x="${x.toFixed(1)}" y="${(pad.t+plotH-h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${esc(d.date)}: ${money(d.revenue_cents)}</title></rect>`;
  }).join('');
  // Only first, middle and last dates are labelled — a tick per day is
  // unreadable at 30 days and pointless at 7.
  const labelAt=[0,Math.floor((daily.length-1)/2),daily.length-1].filter((v,i,arr)=>arr.indexOf(v)===i);
  const xLabels=labelAt.map(i=>{
    const x=pad.l+slot*i+slot/2;
    const day=String(daily[i].date).slice(5);
    return `<text class="tick" x="${x.toFixed(1)}" y="${H-6}" text-anchor="middle">${esc(day)}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue by day, peak ${peso(max)}" preserveAspectRatio="none">
    <defs><linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F157A8"/><stop offset="100%" stop-color="#FFB6D9"/></linearGradient></defs>
    <line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${W-pad.r}" y2="${pad.t}"/>
    <line class="axis" x1="${pad.l}" y1="${pad.t+plotH}" x2="${W-pad.r}" y2="${pad.t+plotH}"/>
    <text class="tick" x="${pad.l-6}" y="${pad.t+4}" text-anchor="end">${peso(max)}</text>
    <text class="tick" x="${pad.l-6}" y="${pad.t+plotH}" text-anchor="end">₱0</text>
    ${bars}${xLabels}
  </svg>`;
}

async function products(){
  state.products=await api('products');
  setBody(`<div class="toolbar"><input id="search" type="search" placeholder="Search name or slug"><select id="category"><option value="">All categories</option><option>glass</option><option>charms</option><option>stickers</option></select><select id="status"><option value="">All statuses</option><option>active</option><option>draft</option><option>archived</option></select><select id="sort"><option value="name">Name</option><option value="stock">Lowest stock</option></select><button class="primary" id="new-product">Add product</button></div><div id="products-table"></div>`);
  const update=()=>drawProducts();
  $$('#search,#category,#status,#sort').forEach(el=>el.addEventListener('input',update));
  $('#new-product').onclick=()=>productForm();
  drawProducts();
}
function drawProducts(){
  const q=$('#search').value.toLowerCase(),cat=$('#category').value,status=$('#status').value,sort=$('#sort').value;
  const rows=state.products.filter(p=>(!q||(p.name+' '+p.slug).toLowerCase().includes(q))&&(!cat||p.category===cat)&&(!status||p.status===status))
    .sort((a,b)=>sort==='stock'?a.stock_on_hand-b.stock_on_hand:a.name.localeCompare(b.name));
  $('#products-table').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>Piece</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(p=>`<tr class="${p.stock_on_hand===0?'out':p.stock_on_hand<=p.low_stock_at?'low':''}"><td><strong>${esc(p.name)}</strong><br><small>${esc(p.slug)}</small></td><td>${esc(p.category)}</td><td>${money(p.price_cents)}</td><td>${p.stock_on_hand}</td><td><span class="status ${p.status}">${p.status}</span></td><td><div class="row-actions"><button data-edit="${p.id}">Edit</button>${p.status==='archived'?'':`<button class="secondary" data-archive="${p.id}">Archive</button>`}</div></td></tr>`).join('')}</tbody></table></div>`:(state.products.length?emptyState('✦','Nothing matches','Try clearing the search box or widening the category and status filters.'):emptyState('✦','No products yet','Add your first handmade piece and it will appear on the storefront once published.'));
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
    <div class="span-2 form-actions">${p.id?'<button type="button" class="danger" id="delete-product">Delete permanently</button>':''}<button type="button" class="secondary" id="cancel-product">Cancel</button><button class="primary">Save product</button></div>
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
    $('#delete-product').onclick=()=>deleteProduct(p,products,true);
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
async function archive(id,refresh=products){if(!confirm('Archive this product? It will leave the public shop but keep its order history.'))return;try{await api(`products/${id}/archive`,{method:'POST'});toast('Product archived');await refresh()}catch(e){toast(e.message,true)}}
async function deleteProduct(product,refresh=products,closeAfter=false){
  const typed=prompt(`Permanently delete ${product.name}? Type ${product.slug} to confirm. Products with order history must be archived instead.`);
  if(typed!==product.slug)return;
  try{
    await api('products/'+product.id,{method:'DELETE'});
    if(closeAfter){state.dirty=false;closeModal()}
    toast('Product permanently deleted');await refresh();
  }catch(error){toast(error.message,true)}
}

async function inventory(){
  [state.products,state.movements]=await Promise.all([api('products'),api('inventory/movements')]);
  const canManageCatalog=state.me.capabilities?.includes('catalog');
  setBody(`<div class="toolbar"><button id="stocktake" class="primary">Count everything</button><a class="button secondary" href="/api/admin/inventory/movements?format=csv">Export CSV</a><select id="reason-filter"><option value="">All reasons</option>${['made','sale_pos','sale_web','return','damaged','gifted','stocktake','oversell_correction','initial'].map(x=>`<option>${x}</option>`).join('')}</select></div>
  <div class="table-wrap"><table><thead><tr><th>Product</th><th>Status</th><th>On hand</th><th>Quick adjust</th><th>Threshold</th>${canManageCatalog?'<th>Actions</th>':''}</tr></thead><tbody>${state.products.map(p=>`<tr class="${p.stock_on_hand===0?'out':p.stock_on_hand<=p.low_stock_at?'low':''}"><td><strong>${esc(p.name)}</strong><br><small>${esc(p.slug)}</small></td><td><span class="status ${p.status}">${p.status}</span></td><td>${p.stock_on_hand}</td><td><div class="stock-step"><button aria-label="Remove one ${esc(p.name)}" data-adjust="${p.id}" data-delta="-1">−</button><button aria-label="Add one ${esc(p.name)}" data-adjust="${p.id}" data-delta="1">+</button><button class="secondary" data-full-adjust="${p.id}">Details</button></div></td><td>${p.one_of_a_kind?'One-off':p.low_stock_at}</td>${canManageCatalog?`<td><div class="row-actions">${p.status==='archived'?'<span class="status archived">archived</span>':`<button class="secondary" data-inventory-archive="${p.id}">Archive</button>`}<button class="danger" data-inventory-delete="${p.id}">Delete</button></div></td>`:''}</tr>`).join('')}</tbody></table></div>
  <section class="card" style="margin-top:24px"><h2>Movement history</h2><div id="movements">${movementList(state.movements)}</div></section>`);
  $$('[data-adjust]').forEach(b=>b.onclick=()=>adjust(b.dataset.adjust,Number(b.dataset.delta),Number(b.dataset.delta)>0?'made':'damaged','Quick adjustment'));
  $$('[data-full-adjust]').forEach(b=>b.onclick=()=>adjustForm(b.dataset.fullAdjust));
  $$('[data-inventory-archive]').forEach(b=>b.onclick=()=>archive(b.dataset.inventoryArchive,inventory));
  $$('[data-inventory-delete]').forEach(b=>b.onclick=()=>deleteProduct(state.products.find(p=>p.id===b.dataset.inventoryDelete),inventory));
  $('#reason-filter').onchange=async e=>{$('#movements').innerHTML=movementList(await api('inventory/movements?reason='+encodeURIComponent(e.target.value)))};
  $('#stocktake').onclick=stocktakeForm;
}
const movementList=rows=>rows.length?`<div class="timeline">${rows.slice(0,100).map(m=>`<div class="movement"><strong class="${m.delta>0?'positive':'negative'}">${m.delta>0?'+':''}${m.delta}</strong> ${esc(m.products?.name||m.product_id)} · ${esc(m.reason)}<br><small>${date(m.created_at)}${m.note?' · '+esc(m.note):''}</small></div>`).join('')}</div>`:emptyState('✦','No movements yet','Every stock change — made, sold, damaged, counted — will be listed here.');
async function adjust(product_id,delta,reason,note){try{await api('inventory/adjust',{method:'POST',body:JSON.stringify({product_id,delta,reason,note})});toast('Stock updated');inventory()}catch(e){toast(e.message,true)}}
function adjustForm(id){const p=state.products.find(x=>x.id===id);openModal(`<h2>Adjust ${esc(p.name)}</h2><form id="adjust-form" class="form-grid">${field('delta','Quantity change','1',true,'','number')}<label>Reason<select name="reason">${['made','return','damaged','gifted','stocktake'].map(x=>`<option>${x}</option>`).join('')}</select></label>${area('note','Note')}<div class="span-2 form-actions"><button class="primary">Record movement</button></div></form>`);$('#adjust-form').onsubmit=e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.target));closeModal();adjust(id,Number(b.delta),b.reason,b.note)}}
function stocktakeForm(){openModal(`<h2>Physical stocktake</h2><p>Enter what you can count. You’ll see the variance before anything changes.</p><form id="count-form"><div class="grid">${state.products.map(p=>`<label>${esc(p.name)} · system ${p.stock_on_hand}<input type="number" min="0" name="${p.id}" value="${p.stock_on_hand}"></label>`).join('')}</div><div id="variance" class="card" style="margin-top:16px"></div><div class="form-actions"><button class="primary">Commit stocktake</button></div></form>`);const f=$('#count-form');const show=()=>{$('#variance').innerHTML=state.products.map(p=>{const d=Number(f.elements[p.id].value)-p.stock_on_hand;return d?`<p>${esc(p.name)}: <strong>${d>0?'+':''}${d}</strong></p>`:''}).join('')||'<p>No differences.</p>'};f.oninput=show;show();f.onsubmit=async e=>{e.preventDefault();if(!confirm('Record every displayed variance?'))return;try{await api('inventory/stocktake',{method:'POST',body:JSON.stringify({counts:state.products.map(p=>({product_id:p.id,counted:Number(f.elements[p.id].value)}))})});closeModal();toast('Stocktake recorded');inventory()}catch(err){toast(err.message,true)}}}

async function orders(){
  state.orders=await api('orders');
  setBody(`<div class="toolbar"><input id="order-search" type="search" placeholder="Ref, name, email"><select id="order-status"><option value="">All statuses</option>${['inquiry','quoted','awaiting_payment','paid','in_production','fulfilled','cancelled'].map(x=>`<option>${x}</option>`).join('')}</select></div><div id="orders-table"></div>`);
  $('#order-search').oninput=$('#order-status').onchange=drawOrders;drawOrders();
}
function drawOrders(){const q=$('#order-search').value.toLowerCase(),s=$('#order-status').value;const rows=state.orders.filter(o=>(!q||(o.ref+' '+o.customer_name+' '+o.customer_email).toLowerCase().includes(q))&&(!s||o.status===s));$('#orders-table').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>Ref</th><th>Customer</th><th>Total</th><th>Channel</th><th>Status</th><th>Created</th></tr></thead><tbody>${rows.map(o=>`<tr class="${o.is_oversell?'low':''}" data-order="${o.id}" tabindex="0"><td><strong>${esc(o.ref)}</strong>${o.is_oversell?'<br><small>Needs attention — sold twice</small>':''}</td><td>${esc(o.customer_name||'Walk-in')}<br><small>${esc(o.customer_email||'')}</small></td><td>${money(o.total_cents)}</td><td>${o.channel}</td><td><span class="status ${o.status}">${o.status}</span></td><td>${date(o.created_at)}</td></tr>`).join('')}</tbody></table></div>`:(state.orders.length?emptyState('✦','Nothing matches','No order matches that search or status filter.'):emptyState('✦','No orders yet','Web inquiries and POS sales will both land here.'));$$('[data-order]').forEach(r=>{r.onclick=()=>orderDetail(r.dataset.order);r.onkeydown=e=>{if(e.key==='Enter')r.click()}})}
async function orderDetail(id){const o=await api('orders/'+id);openModal(`<p class="eyebrow">${esc(o.channel)} order</p><h2>${esc(o.ref)}</h2>${o.is_oversell?'<div class="alert">Needs attention — sold twice. Contact the customer to refund or remake.</div>':''}<p><strong>${esc(o.customer_name||'Walk-in')}</strong><br>${esc(o.customer_email||'')} ${esc(o.customer_phone||'')}</p><div class="card">${(o.order_items||[]).map(i=>`<p>${i.qty} × ${esc(i.product_name)} <strong style="float:right">${money(i.line_total_cents)}</strong></p>`).join('')}<hr><p>Total <strong style="float:right">${money(o.total_cents)}</strong></p></div><div class="form-actions"><a class="button secondary" href="mailto:${encodeURIComponent(o.customer_email||'')}?subject=${encodeURIComponent('Verre order '+o.ref)}">Email customer</a>${['inquiry','quoted','awaiting_payment','paid','in_production','fulfilled','cancelled'].map(s=>`<button data-status="${s}" ${s===o.status?'disabled':''}>${s.replace('_',' ')}</button>`).join('')}</div>`);$$('[data-status]').forEach(b=>b.onclick=async()=>{const note=b.dataset.status==='cancelled'?prompt('Cancellation note:')||'Cancelled by admin':'';try{await api(`orders/${id}/status`,{method:'POST',body:JSON.stringify({status:b.dataset.status,payment_method:b.dataset.status==='paid'?'gcash':null,note})});closeModal();toast('Order updated');orders()}catch(e){toast(e.message,true)}})}

/* ------------------------------------------------------------------ */
/* custom commissions                                                  */
/* ------------------------------------------------------------------ */

const CUSTOM_STAGES=['inquiry','quoted','awaiting_payment','paid','in_production','fulfilled'];
const canEditOptions=()=>state.me?.role==='super_admin';

async function customPage(){
  // Two tabs, one route. The briefs are the daily job; the options behind the
  // wizard are edited rarely, and giving them their own nav entry would put a
  // link Kyle uses monthly above one he uses every morning.
  setBody(`<div class="toolbar">
      <button id="tab-briefs" class="primary">Briefs</button>
      ${canEditOptions()?'<button id="tab-options">Wizard steps</button>':''}
    </div><div id="custom-body"></div>`);
  $('#tab-briefs').onclick=()=>{$('#tab-briefs').className='primary';const o=$('#tab-options');if(o)o.className='';customBriefs()};
  if(canEditOptions())$('#tab-options').onclick=()=>{$('#tab-options').className='primary';$('#tab-briefs').className='';customOptions()};
  await customBriefs();
}

async function customBriefs(){
  state.custom=await api('custom/orders');
  const body=$('#custom-body');
  if(!state.custom.length){
    body.innerHTML=emptyState('✦','No commissions yet','Requests from the storefront wizard land here, oldest first.');
    return;
  }
  // Sorted by "needs Kyle" rather than by date: an unanswered brief is the only
  // thing on this page with a clock running against it.
  const waiting=state.custom.filter(o=>o.status==='inquiry');
  const rest=state.custom.filter(o=>o.status!=='inquiry');
  const row=(o)=>`<tr data-custom="${o.id}" tabindex="0">
      <td><strong>${esc(o.ref)}</strong></td>
      <td>${esc(o.customer_name||'')}<br><small>${esc(o.customer_email||'')}</small></td>
      <td>${(o.custom_order_selections||[]).length} answers${(o.custom_order_images||[]).length?`<br><small>${o.custom_order_images.length} photo(s)</small>`:''}</td>
      <td>${o.quoted_cents!=null?money(o.quoted_cents):`<small>est. ${money(o.estimate_cents||0)}</small>`}</td>
      <td><span class="status ${o.status}">${o.status.replace('_',' ')}</span></td>
      <td>${date(o.created_at)}</td>
    </tr>`;
  body.innerHTML=`${waiting.length?`<div class="card attention"><h2>${waiting.length} brief${waiting.length>1?'s':''} waiting on a quote</h2><p>Customers were told 2–3 days.</p></div>`:''}
    <div class="table-wrap"><table>
      <thead><tr><th>Ref</th><th>Customer</th><th>Brief</th><th>Price</th><th>Status</th><th>Received</th></tr></thead>
      <tbody>${waiting.concat(rest).map(row).join('')}</tbody>
    </table></div>`;
  $$('[data-custom]').forEach(r=>{
    r.onclick=()=>customDetail(r.dataset.custom);
    r.onkeydown=e=>{if(e.key==='Enter')r.click()};
  });
}

async function customDetail(id){
  const o=await api('custom/orders/'+id);
  const spec=(o.selections||[]).map(s=>`<p><small>${esc(s.group_label)}</small><br><strong>${esc(s.option_label||s.text_value||'—')}</strong>${s.price_delta_cents?` <span style="float:right">${money(s.price_delta_cents)}</span>`:''}</p>`).join('<hr>');
  const photos=(o.images||[]).filter(i=>i.url).map(i=>`<a href="${esc(i.url)}" target="_blank" rel="noopener"><img src="${esc(i.url)}" alt="Reference photo" style="width:88px;height:88px;object-fit:cover;border-radius:12px;border:3px solid #fff"></a>`).join('');
  const address=[o.ship_line1,o.ship_line2,o.ship_city,o.ship_province,o.ship_postcode].filter(Boolean).map(esc).join(', ');
  // Only the transitions the database will actually accept. Rendering every
  // status and letting the RPC reject five of them turns a one-click job into
  // guess-and-toast.
  const at=CUSTOM_STAGES.indexOf(o.status);
  const nextStages=at>=0?CUSTOM_STAGES.slice(at+1,at+3):[];

  openModal(`<p class="eyebrow">Custom commission</p><h2>${esc(o.ref)}</h2>
    <p><strong>${esc(o.customer_name||'')}</strong><br>${esc(o.customer_email||'')} ${esc(o.customer_phone||'')}
    ${address?`<br><small>${esc(o.fulfillment||'')} · ${address}</small>`:`<br><small>${esc(o.fulfillment||'')}</small>`}</p>
    ${photos?`<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px">${photos}</div>`:''}
    <div class="card">${spec}
      <hr><p>Wizard estimate <strong style="float:right">${money(o.estimate_cents||0)}</strong></p>
      ${o.quoted_cents!=null?`<p>Your quote <strong style="float:right">${money(o.quoted_cents)}</strong></p>`:''}
      ${o.deposit_cents?`<p><small>Deposit ${money(o.deposit_cents)}</small></p>`:''}
    </div>
    ${o.note?`<p><small>They added:</small><br>${esc(o.note)}</p>`:''}
    <div class="form-actions">
      <a class="button secondary" href="mailto:${encodeURIComponent(o.customer_email||'')}?subject=${encodeURIComponent('Verre commission '+o.ref)}">Email customer</a>
      ${o.status==='inquiry'||o.status==='quoted'?`<button id="quote-btn" class="primary">${o.quoted_cents!=null?'Revise quote':'Send quote'}</button>`:''}
      ${o.status==='paid'||o.status==='in_production'?'<button id="ship-btn">Add tracking</button>':''}
      ${nextStages.map(s=>`<button data-custom-status="${s}">Mark ${s.replace('_',' ')}</button>`).join('')}
      ${o.status!=='cancelled'&&o.status!=='fulfilled'?'<button data-custom-status="cancelled">Cancel</button>':''}
    </div>`);

  if($('#quote-btn'))$('#quote-btn').onclick=()=>quoteForm(o);
  if($('#ship-btn'))$('#ship-btn').onclick=()=>shippingForm(o);
  $$('[data-custom-status]').forEach(b=>b.onclick=async()=>{
    const status=b.dataset.customStatus;
    const note=status==='cancelled'?(prompt('Cancellation note:')||'Cancelled by admin'):'';
    if(status==='cancelled'&&!confirm('Cancel this commission?'))return;
    try{
      await api(`orders/${id}/status`,{method:'POST',body:JSON.stringify({status,payment_method:status==='paid'?'gcash':null,note})});
      closeModal();toast('Commission updated');customBriefs();
    }catch(e){toast(e.message,true)}
  });
}

function quoteForm(o){
  openModal(`<h2>Quote ${esc(o.ref)}</h2>
    <p class="sub">The wizard estimated ${money(o.estimate_cents||0)}. That was a ballpark shown to the customer — this is the number they pay.</p>
    <form id="quote-form" class="form-grid">
      ${field('quoted','Your price','',true)}
      ${field('deposit','Deposit to start (optional)','')}
      ${area('note','Note to include with the quote')}
      <div class="span-2 form-actions"><button class="primary">Save quote</button></div>
    </form>`);
  $('#quote-form').onsubmit=async e=>{
    e.preventDefault();
    const d=Object.fromEntries(new FormData(e.target));
    const quoted=parsePeso(d.quoted);
    if(quoted==null)return toast('Enter a valid amount',true);
    const deposit=d.deposit?parsePeso(d.deposit):0;
    if(deposit==null)return toast('Enter a valid deposit, or leave it blank',true);
    if(deposit>quoted)return toast('The deposit cannot be more than the quote',true);
    try{
      await api(`custom/orders/${o.id}/quote`,{method:'POST',body:JSON.stringify({quoted_cents:quoted,deposit_cents:deposit,note:d.note})});
      closeModal();toast('Quote saved — email it to them next');customBriefs();
    }catch(err){toast(err.message,true)}
  };
}

function shippingForm(o){
  openModal(`<h2>Tracking for ${esc(o.ref)}</h2>
    <p class="sub">This appears on the customer's tracking page as soon as you save it.</p>
    <form id="ship-form" class="form-grid">
      ${field('carrier','Courier',o.ship_carrier||'',true)}
      ${field('tracking','Tracking number',o.ship_tracking||'',true)}
      <div class="span-2 form-actions"><button class="primary">Save tracking</button></div>
    </form>`);
  $('#ship-form').onsubmit=async e=>{
    e.preventDefault();
    const d=Object.fromEntries(new FormData(e.target));
    try{
      await api(`custom/orders/${o.id}/shipping`,{method:'POST',body:JSON.stringify({carrier:d.carrier,tracking:d.tracking})});
      closeModal();toast('Tracking saved');customBriefs();
    }catch(err){toast(err.message,true)}
  };
}

/* ---- the wizard's own options ------------------------------------ */

async function customOptions(){
  state.optionGroups=await api('custom/options');
  const groups=[...state.optionGroups].sort((a,b)=>a.step-b.step);
  const allOptions=groups.flatMap(g=>(g.custom_options||[]).map(o=>({...o,groupKey:g.key})));
  const parentName=(id)=>{const o=allOptions.find(x=>x.id===id);return o?o.label:''};

  $('#custom-body').innerHTML=`<p class="sub">These are the steps the storefront wizard walks through, in order. Changes go live within a minute.</p>
    <div class="toolbar"><button id="add-group">Add a step</button></div>
    ${groups.map(g=>`<div class="card">
      <h2>${g.step}. ${esc(g.label)} ${g.is_active?'':'<small>(hidden)</small>'}</h2>
      <p class="sub">${esc(g.helper||'')} <small>${g.input_kind==='text'?'free text':'pick one'}${g.required?' · required':' · optional'}</small></p>
      <div class="table-wrap"><table>
        <thead><tr><th>Choice</th><th>Adds</th><th>Lead time</th><th>Only after</th><th>Live</th><th></th></tr></thead>
        <tbody>${(g.custom_options||[]).sort((a,b)=>a.sort_order-b.sort_order).map(o=>`<tr>
          <td><strong>${esc(o.label)}</strong><br><small>${esc(o.description||'')}</small></td>
          <td>${o.price_delta_cents?money(o.price_delta_cents):'—'}</td>
          <td>${o.lead_time_days?o.lead_time_days+' days':'—'}</td>
          <td>${o.parent_option_id?esc(parentName(o.parent_option_id)):'always'}</td>
          <td>${o.is_active?'✓':'—'}</td>
          <td><button data-edit-option="${o.id}">Edit</button> <button data-retire-option="${o.id}">Remove</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="form-actions"><button data-edit-group="${g.id}">Edit step</button><button data-add-option="${g.id}" class="primary">Add a choice</button></div>
    </div>`).join('')}`;

  $('#add-group').onclick=()=>groupForm();
  $$('[data-edit-group]').forEach(b=>b.onclick=()=>groupForm(groups.find(g=>g.id===b.dataset.editGroup)));
  $$('[data-add-option]').forEach(b=>b.onclick=()=>optionForm({group_id:b.dataset.addOption},groups,allOptions));
  $$('[data-edit-option]').forEach(b=>b.onclick=()=>optionForm(allOptions.find(o=>o.id===b.dataset.editOption),groups,allOptions));
  $$('[data-retire-option]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Remove this choice? If anyone has already picked it, it is hidden rather than deleted so old quotes keep their wording.'))return;
    try{await api('custom/options/'+b.dataset.retireOption,{method:'DELETE'});toast('Choice removed');customOptions()}catch(e){toast(e.message,true)}
  });
}

function groupForm(g={step:(state.optionGroups.length||0)+1,input_kind:'single',required:true,is_active:true}){
  const editing=Boolean(g.id);
  openModal(`<h2>${editing?'Edit step':'New step'}</h2>
    <form id="group-form" class="form-grid">
      ${field('key','Key (lowercase, no spaces)',g.key||'',true,editing)}
      ${field('label','Question shown to the customer',g.label||'',true)}
      ${field('helper','Helper line under it',g.helper||'')}
      ${field('step','Position',g.step??1,true,false,'number')}
      <label>Kind<select name="input_kind">${['single','text'].map(k=>`<option ${g.input_kind===k?'selected':''}>${k}</option>`).join('')}</select></label>
      <label>Required<select name="required"><option value="yes" ${g.required!==false?'selected':''}>yes</option><option value="no" ${g.required===false?'selected':''}>no</option></select></label>
      <label>Live<select name="is_active"><option value="yes" ${g.is_active!==false?'selected':''}>yes</option><option value="no" ${g.is_active===false?'selected':''}>no</option></select></label>
      <div class="span-2 form-actions"><button class="primary">Save step</button></div>
    </form>`);
  // The key is what selections snapshot and what the browser sends back, so an
  // existing one is not editable — renaming it would orphan every brief that
  // already used it.
  $('#group-form').onsubmit=async e=>{
    e.preventDefault();
    const d=Object.fromEntries(new FormData(e.target));
    const payload={key:editing?g.key:d.key,label:d.label,helper:d.helper,step:Number(d.step),
      input_kind:d.input_kind,required:d.required==='yes',is_active:d.is_active==='yes'};
    try{
      await api(editing?'custom/groups/'+g.id:'custom/groups',{method:editing?'PATCH':'POST',body:JSON.stringify(payload)});
      closeModal();toast('Step saved');customOptions();
    }catch(err){toast(err.message,true)}
  };
}

function optionForm(o={},groups=[],allOptions=[]){
  const editing=Boolean(o.id);
  const group=groups.find(g=>g.id===o.group_id);
  // A parent can only come from an earlier step. Offering a later one builds a
  // dependency that can never be satisfied, because the answer arrives after
  // the question that needed it.
  const candidates=allOptions.filter(x=>{
    const owner=groups.find(g=>g.id===x.group_id);
    return owner&&group&&owner.step<group.step;
  });
  openModal(`<h2>${editing?'Edit choice':'New choice'}</h2>
    <form id="option-form" class="form-grid">
      ${field('key','Key (lowercase, no spaces)',o.key||'',true,editing)}
      ${field('label','What the customer sees',o.label||'',true)}
      ${area('description','One line of detail',o.description||'')}
      ${field('price','Adds to the estimate',o.price_delta_cents?String(o.price_delta_cents/100):'0')}
      ${field('lead_time_days','Extra days to make',o.lead_time_days??'',false,false,'number')}
      ${field('swatch','Card colour',o.swatch||'#FFE0EE')}
      ${field('sort_order','Position',o.sort_order??0,false,false,'number')}
      <label>Only shown after<select name="parent_option_id"><option value="">always shown</option>${candidates.map(c=>`<option value="${c.id}" ${o.parent_option_id===c.id?'selected':''}>${esc(c.label)}</option>`).join('')}</select></label>
      <label>Live<select name="is_active"><option value="yes" ${o.is_active!==false?'selected':''}>yes</option><option value="no" ${o.is_active===false?'selected':''}>no</option></select></label>
      <div class="span-2 form-actions"><button class="primary">Save choice</button></div>
    </form>`);
  $('#option-form').onsubmit=async e=>{
    e.preventDefault();
    const d=Object.fromEntries(new FormData(e.target));
    const price=parsePeso(d.price||'0');
    if(price==null)return toast('Enter a valid amount, or 0',true);
    const payload={group_id:o.group_id,key:editing?o.key:d.key,label:d.label,description:d.description,
      price_delta_cents:price,lead_time_days:d.lead_time_days===''?null:Number(d.lead_time_days),
      swatch:d.swatch,sort_order:Number(d.sort_order)||0,
      parent_option_id:d.parent_option_id||null,is_active:d.is_active==='yes'};
    try{
      await api(editing?'custom/options/'+o.id:'custom/options',{method:editing?'PATCH':'POST',body:JSON.stringify(payload)});
      closeModal();toast('Choice saved');customOptions();
    }catch(err){toast(err.message,true)}
  };
}

async function sessions(){
  state.sessions=await api('sessions');
  setBody(`<div class="toolbar"><button id="open-session" class="primary">Start session</button></div><div class="table-wrap"><table><thead><tr><th>Label</th><th>Device</th><th>Opened</th><th>Opening float</th><th>Status</th><th></th></tr></thead><tbody>${state.sessions.map(s=>`<tr><td>${esc(s.label)}</td><td>${esc(s.device_label||'')}</td><td>${date(s.opened_at)}</td><td>${money(s.opening_float_cents)}</td><td><span class="status ${s.closed_at?'fulfilled':'inquiry'}">${s.closed_at?'closed':'open'}</span></td><td>${s.closed_at?'':`<button data-close-session="${s.id}">Close</button>`}</td></tr>`).join('')}</tbody></table></div>`);
  $('#open-session').onclick=()=>sessionForm();$$('[data-close-session]').forEach(b=>b.onclick=()=>closeSessionForm(b.dataset.closeSession));
}

async function accounts(){
  state.accounts=await api('accounts');
  setBody(`${state.me.bootstrap?`<div class="card attention" style="margin:22px 0"><strong>${esc(state.me.email)}</strong> is the environment bootstrap Super Admin. Keep that setting until another Super Admin account has been tested.</div>`:''}
    <section class="role-grid" aria-label="Role permissions">
      <div class="card"><h2>Super Admin</h2><p>All features, including products and account management.</p></div>
      <div class="card"><h2>General Admin</h2><p>Orders and sales, inventory, and POS.</p></div>
      <div class="card"><h2>Cashier</h2><p>POS only. No admin dashboard, orders, inventory, or accounts.</p></div>
    </section>
    <div class="toolbar"><button id="new-account" class="primary">Add account</button></div>
    <div id="accounts-table"></div>`);
  $('#new-account').onclick=()=>accountForm();
  drawAccounts();
}
function drawAccounts(){
  $('#accounts-table').innerHTML=state.accounts.length?`<div class="table-wrap"><table><thead><tr><th>Person</th><th>Email</th><th>Role</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${state.accounts.map(account=>{const pending=account.active&&!account.password_set_at;return `<tr class="${account.active?'':'out'}"><td><strong>${esc(account.display_name)}</strong></td><td>${esc(account.email)}</td><td><span class="role-badge">${esc(roleLabels[account.role]||account.role)}</span></td><td><span class="status ${!account.active?'archived':pending?'inquiry':'active'}">${!account.active?'inactive':pending?'invite pending':'active'}</span></td><td>${date(account.updated_at)}</td><td><div class="row-actions"><button data-edit-account="${account.id}">Edit</button>${pending?`<button data-invite-account="${account.id}">Resend invite</button>`:''}</div></td></tr>`}).join('')}</tbody></table></div>`:emptyState('✦','No staff accounts yet','You are signed in from the bootstrap list. Add an account here to manage access from the database instead.');
  $$('[data-edit-account]').forEach(button=>button.onclick=()=>accountForm(state.accounts.find(account=>account.id===button.dataset.editAccount)));
  $$('[data-invite-account]').forEach(button=>button.onclick=async()=>{
    const account=state.accounts.find(item=>item.id===button.dataset.inviteAccount);
    if(!account||!confirm(`Send a new password-creation link to ${account.email}?`))return;
    button.disabled=true;button.textContent='Sending…';
    try{await api(`accounts/${account.id}/invite`,{method:'POST'});toast(`Invitation sent to ${account.email}`)}
    catch(error){toast(error.message,true);button.disabled=false;button.textContent='Resend invite'}
  });
}
function accountForm(account={role:'cashier',active:true}){
  openModal(`<p class="eyebrow">${account.id?'Edit account':'New staff account'}</p><h2>${esc(account.display_name||'Invite by email')}</h2>
    <p>${account.id?(account.password_set_at?'Update this person’s role or access. Their existing password will keep working.':'This person has not created a password yet. You can resend their invitation from the accounts list.'):'Saving an active account immediately emails a secure, one-time link for the person to create their password.'}</p>
    <form id="account-form" class="form-grid" novalidate>
      ${field('display_name','Display name',account.display_name||'',true)}
      ${field('email','Sign-in email',account.email||'',true,false,'email')}
      <label>Role<select name="role"><option value="super_admin">Super Admin — everything</option><option value="general_admin">General Admin — sales, inventory, POS</option><option value="cashier">Cashier — POS only</option></select></label>
      <label><span>Account active</span><input name="active" type="checkbox" ${account.active!==false?'checked':''}></label>
      <p class="error span-2" id="account-error" role="status"></p>
      <div class="span-2 form-actions">${account.id&&account.email!==state.me.email?'<button type="button" class="danger" id="delete-account">Delete account</button>':''}<button type="button" class="secondary" id="cancel-account">Cancel</button><button class="primary">${account.id?'Save account':'Send invitation'}</button></div>
    </form>`);
  const form=$('#account-form');form.role.value=account.role||'cashier';
  form.addEventListener('input',()=>state.dirty=true);
  $('#cancel-account').onclick=()=>{if(!state.dirty||confirm('Discard unsaved changes?'))closeModal()};
  const deleteButton=$('#delete-account');
  if(deleteButton)deleteButton.onclick=async()=>{
    if(!confirm(`Permanently delete ${account.display_name}? They will be signed out immediately, and this cannot be undone.`))return;
    deleteButton.disabled=true;deleteButton.textContent='Deleting…';
    try{
      await api('accounts/'+account.id,{method:'DELETE'});
      state.dirty=false;closeModal();toast(`${account.display_name} was deleted`);accounts();
    }catch(error){$('#account-error').textContent=error.message;deleteButton.disabled=false;deleteButton.textContent='Delete account'}
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    const data=Object.fromEntries(new FormData(form));
    data.display_name=data.display_name.trim();data.email=data.email.trim().toLowerCase();data.active=form.elements.active.checked;
    if(!data.display_name)return $('#account-error').textContent='Display name is required.';
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))return $('#account-error').textContent='Enter a valid email address.';
    if(account.active&& !data.active && !confirm(`Deactivate ${account.display_name}? They will lose access on their next request.`))return;
    try{
      const saved=await api('accounts'+(account.id?'/'+account.id:''),{method:account.id?'PATCH':'POST',body:JSON.stringify(data)});
      state.dirty=false;closeModal();
      if(account.id)toast('Account permissions saved');
      else if(saved.invite_sent)toast(`Invitation sent to ${data.email}`);
      else toast(saved.invite_warning||'Account saved, but the invitation could not be sent.',true);
      accounts();
    }catch(error){$('#account-error').textContent=error.message}
  };
}
const MONTHS=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const windowLabel=(w)=>w?`${w.from[1]} ${MONTHS[w.from[0]]} – ${w.to[1]} ${MONTHS[w.to[0]]}`:'Whenever nothing else is running';

async function themes(){
  const data=await api('theme');
  const auto=!data.override;
  setBody(`
    <section class="card attention" style="margin-bottom:22px">
      <h2>Live right now</h2>
      <p style="margin:0 0 14px">
        <strong>${esc((data.themes.find(t=>t.id===data.active)||{}).label||data.active)}</strong>
        ${auto?' — chosen by today\u2019s date.':' — forced on. The calendar is being ignored until you switch back.'}
      </p>
      <div class="toolbar" style="margin:0">
        <button id="theme-auto" class="${auto?'':'primary'}" ${auto?'disabled':''}>Back to automatic</button>
        <a class="button secondary" href="/" target="_blank" rel="noopener">Open the storefront ↗</a>
      </div>
    </section>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
      ${data.themes.map(t=>`
        <article class="card" style="display:grid;gap:12px;${t.id===data.active?'outline:3px solid var(--pink);outline-offset:3px':''}">
          <div style="height:74px;border-radius:14px;background:${esc(t.hero)}"></div>
          <div style="display:flex;gap:6px">${(t.swatch||[]).map(c=>`<span style="width:22px;height:22px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 0 rgba(58,36,48,.12);background:${esc(c)}"></span>`).join('')}</div>
          <div>
            <h2 style="margin:0 0 4px">${esc(t.label)}${t.id===data.active?' <span class="status active">live</span>':''}</h2>
            <p class="sub" style="margin:0;font-size:13px">${esc(t.blurb||'')}</p>
            <p style="margin:8px 0 0;font-size:12px;color:var(--faint)">${esc(windowLabel(t.window))}</p>
            ${t.ribbon?`<p style="margin:6px 0 0;font-size:12px;color:var(--muted)">Banner: \u201c${esc(t.ribbon)}\u201d</p>`:''}
          </div>
          <div class="row-actions" style="justify-content:flex-start">
            <a class="button secondary" href="/?theme=${encodeURIComponent(t.id)}" target="_blank" rel="noopener">Preview</a>
            <button data-force="${esc(t.id)}" ${data.override===t.id?'disabled':''}>${data.override===t.id?'Forced on':'Force on'}</button>
          </div>
        </article>`).join('')}
    </div>`);
  $('#theme-auto').onclick=()=>setTheme('auto');
  $$('[data-force]').forEach(b=>b.onclick=()=>setTheme(b.dataset.force));
}
async function setTheme(theme){
  try{
    await api('theme',{method:'POST',body:JSON.stringify({theme})});
    toast(theme==='auto'?'Back to the calendar':'Season forced on');
    themes();
  }catch(error){toast(error.message,true)}
}

function sessionForm(){openModal(`<h2>Start a market session</h2><form id="session-form" class="form-grid">${field('label','Label','',true)}${field('device_label','Device',navigator.platform)}${field('opening','Opening cash','0.00',true)}<div class="span-2 form-actions"><button class="primary">Start</button></div></form>`);$('#session-form').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target)),opening=parsePeso(d.opening);if(opening==null)return toast('Enter a valid opening amount',true);await api('sessions',{method:'POST',body:JSON.stringify({label:d.label,device_label:d.device_label,opening_float_cents:opening})});closeModal();toast('Session started');sessions()}}
function closeSessionForm(id){openModal(`<h2>Close session</h2><form id="close-session-form">${field('cash','Counted cash','0.00',true)}<div class="form-actions"><button class="primary">Close session</button></div></form>`);$('#close-session-form').onsubmit=async e=>{e.preventDefault();const cash=parsePeso(new FormData(e.target).get('cash'));if(cash==null)return;await api(`sessions/${id}/close`,{method:'POST',body:JSON.stringify({closing_cash_cents:cash})});closeModal();toast('Session closed');sessions()}}

window.addEventListener('hashchange',render);
async function boot(){
  try{
    state.me=await api('me');
    configureAccount();
    await render();
  }catch(error){
    $('#account-email').textContent='Sign-in required';
    main.innerHTML=setupError(error);
  }
}
boot();
