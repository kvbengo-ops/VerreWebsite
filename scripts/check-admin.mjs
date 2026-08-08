import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root=resolve(import.meta.dirname,'..');
const migrations=(await readdir(resolve(root,'supabase','migrations'))).filter(name=>name.endsWith('.sql')).sort();
const sql=(await Promise.all(migrations.map(name=>readFile(resolve(root,'supabase','migrations',name),'utf8')))).join('\n');
const tables=['products','product_images','pos_sessions','orders','order_items','stock_movements','admin_audit_log','admin_accounts','site_markets'];
for(const table of tables)assert.match(sql,new RegExp(`alter table ${table} enable row level security`),table+' must have RLS');
assert.doesNotMatch(sql,/\bcreate\s+policy\b/i,'deny-all RLS must not have permissive policies');
for(const fn of ['record_sale','adjust_stock','create_inquiry','set_order_status','void_pos_sale','dashboard_snapshot','set_admin_account','delete_admin_account']){
  const start=sql.indexOf('create function '+fn);
  assert.ok(start>=0,fn+' migration is missing');
  const block=sql.slice(start,start+900);
  assert.match(block,/security definer/i,fn+' must be security definer');
  assert.match(block,/set search_path = public, pg_temp/i,fn+' must lock search_path');
}
assert.match(sql,/values \('product-images', 'product-images', false\)/,'product image bucket must be private');
assert.match(sql,/client_uuid\s+uuid unique/,'POS idempotency key must be unique');
assert.match(sql,/greatest\(stock_on_hand - v_qty, 0\)/,'oversells must clamp stock to zero');
assert.match(sql,/'oversell_correction'/,'oversells need a compensating movement');
assert.match(sql,/alter table order_items\s+add constraint order_items_product_id_fkey\s+foreign key \(product_id\) references products\(id\) on delete restrict/i,
  'historical order lines must prevent physical product deletion');

// pgcrypto is installed into the `extensions` schema on Supabase and is not on
// the search_path during migrations, so its functions must be schema qualified
// or `db push` dies with "function ... does not exist". gen_random_uuid is
// exempt: Postgres 13+ ships it in pg_catalog.
for(const name of ['gen_random_bytes','gen_salt','crypt','digest','hmac']){
  const bare=new RegExp('(?<!extensions\\.)(?<![\\w.])'+name+'\\s*\\(','g');
  const offenders=sql.split('\n')
    .filter(line=>!line.trim().startsWith('--'))
    .filter(line=>bare.test(line));
  assert.equal(offenders.length,0,`pgcrypto's ${name}() must be written as extensions.${name}() — found: ${offenders[0]?.trim()}`);
}

const html=await readFile(resolve(root,'index.html'),'utf8');
assert.doesNotMatch(html,/const PRODUCTS\b/,'the storefront must not embed a product catalog');
// The three storefront forms share one tabbed panel. Each nav anchor must still
// exist and each form must still render, or a link silently lands on a card
// showing something else — or a form disappears from the site entirely.
for(const anchor of ['newsletter','custom','contact']){
  assert.ok(html.includes('id="'+anchor+'"'),'#'+anchor+' must remain a scroll anchor');
  assert.ok(new RegExp("id:\\s*'"+anchor+"'").test(html),anchor+' must be a tab in CONNECT_TABS');
}
for(const render of ['renderNewsletterForm','renderCustomForm','renderContactForm']){
  assert.ok(html.includes(render+'()'),render+' must still be reachable from the panel');
}
assert.ok(html.includes('{{ connectPanel }}')&&html.includes('{{ connectTabs }}'),'the connect panel and its tabs must be bound in the template');
const productPhotoBlock=html.slice(html.indexOf('const productPhoto'),html.indexOf('const peso'));
assert.match(productPhotoBlock,/image\.url/,'storefront product art must use uploaded database image URLs');
assert.match(productPhotoBlock,/Photo coming soon/,'products without database photos need an honest missing-photo state');
assert.doesNotMatch(productPhotoBlock,/atlasPhoto\(/,'product cards must not disguise a missing database photo with static atlas art');
// Auto-rotating a panel that contains a form can swap it mid-sentence.
assert.ok(!/connectTab[\s\S]{0,200}setInterval/.test(html),'the connect carousel must never rotate on a timer');

const wrangler=await readFile(resolve(root,'wrangler.toml'),'utf8');
const workerFirst=wrangler.match(/run_worker_first\s*=\s*\[([^\]]*)\]/);
assert.ok(workerFirst,'run_worker_first must be configured');
const workerFirstPaths=[...workerFirst[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]);
for(const path of ['/products/*','/media/products/*','/robots.txt','/sitemap.xml','/admin','/admin/*','/pos','/pos/*']){
  assert.ok(workerFirstPaths.includes('/*')||workerFirstPaths.includes(path),path+' must run through Worker authorization before the asset layer');
}
// Not authorization — the Worker injects the seasonal theme into this document.
// Served straight off the asset layer that code never runs and the storefront
// is undressed all year, with nothing anywhere reporting a problem.
for(const path of ['/','/index.html']){
  assert.ok(workerFirstPaths.includes('/*')||workerFirstPaths.includes(path),path+' must reach the Worker so the season can be injected');
}
assert.match(await readFile(resolve(root,'src','worker.js'),'utf8'),/env\.ASSETS\.fetch\(request\)/,'public assets, including login, still pass through after headers');
const buildScript=await readFile(resolve(root,'scripts','build.mjs'),'utf8');
assert.match(buildScript,/copyTree\(resolve\(root, "assets"\)/,'all public SEO and storefront assets must reach the production build');
// A section needs its nav link, its route permission and its PAGES entry to
// agree. Miss one and the link either 404s to the dashboard or renders a header
// with no body — both silent.
const adminApp=await readFile(resolve(root,'admin','app.js'),'utf8');
const adminHtml=await readFile(resolve(root,'admin','index.html'),'utf8');
for(const route of ['dashboard','products','inventory','orders','sessions','accounts','markets','themes']){
  assert.ok(adminHtml.includes('data-route="'+route+'"'),route+' needs a nav link');
  assert.ok(new RegExp('^\\s*'+route+':','m').test(adminApp),route+' needs a routeRoles and PAGES entry');
}
assert.match(adminApp,/data-inventory-archive/, 'inventory needs an archive action');
assert.match(adminApp,/data-inventory-delete/, 'inventory needs a product-removal action');
assert.match(adminApp,/data-publish=/, 'draft products need an explicit publish-to-shop action');
assert.match(adminApp,/Only active products appear in the public shop\./, 'product visibility must explain the active-only shop rule');
assert.match(adminApp,/name="cost"/, 'product form must collect per-unit buying or making cost');
assert.match(adminApp,/Gross profit/, 'dashboard and order details must report gross profit');
assert.match(adminApp,/id="dashboard-range"/, 'analytics needs an explicit reporting-period selector');
assert.match(adminApp,/Sales channels/, 'analytics needs channel revenue breakdowns');
assert.match(adminApp,/Payment methods/, 'analytics needs payment-method breakdowns');
assert.match(adminApp,/Stock value by product/, 'analytics needs current inventory valuation');
assert.match(adminApp,/Order stages/, 'analytics needs an order pipeline view');
assert.match(sql,/add column cost_cents integer check \(cost_cents >= 0\)/, 'products need a validated private cost field');
assert.match(sql,/add column unit_cost_cents integer/, 'order lines need a historical unit-cost snapshot');
assert.match(sql,/create trigger order_items_snapshot_cost/, 'every catalog sale path must snapshot product cost');
assert.match(sql,/'gross_profit_cents'/, 'dashboard aggregation must return gross profit');
assert.match(sql,/'channel_breakdown'/, 'dashboard aggregation must return channel analytics');
assert.match(sql,/'order_pipeline'/, 'dashboard aggregation must return the order pipeline');
assert.match(sql,/'inventory'/, 'dashboard aggregation must return private inventory analytics');
assert.match(sql,/'stock_movements'/, 'dashboard aggregation must return movement analytics');
assert.match(adminApp,/Current products/, 'product management should hide archived rows by default');
assert.match(adminApp,/data-restore/, 'archived products need an explicit restore-as-draft action');
assert.match(adminApp,/cache:'no-store'/, 'admin refreshes must not reuse a pre-delete catalog response');
assert.match(adminApp,/capabilities\?\.includes\('catalog'\)/, 'destructive inventory actions must only render for catalog managers');
assert.match(adminHtml,/id="delete-product-modal"/, 'product deletion needs an accessible in-app confirmation dialog');
assert.match(adminApp,/id="confirm-product-slug"/, 'product deletion must require the exact slug');
assert.match(adminApp,/Remove from catalog/, 'products with history need an archive-oriented confirmation action');
assert.match(adminApp,/This product has historical records\. It will be removed from the active catalog while its order, sales, and inventory history remain available\./, 'historical product removal needs clear preservation copy');
assert.match(adminApp,/Delete permanently/, 'history-free products retain an explicit permanent-delete action');
assert.doesNotMatch(adminApp,/prompt\(`Permanently delete/, 'product deletion must not fall back to a browser prompt');
assert.match(adminApp,/\/api\/admin\/images\/upload\?/, 'product photos must use the authenticated same-origin upload route');
assert.match(adminApp,/headers:\{'content-type':'image\/webp'\}/, 'prepared product photos must declare their WebP content type');
assert.doesNotMatch(adminApp,/fetch\(signed\.signedUrl/, 'product photos must not depend on a cross-origin signed upload handoff');
assert.match(adminApp,/They will upload after the product is saved\./, 'new products must allow photos to be queued before the product ID exists');
for(const action of ['data-market-edit','data-market-delete','data-market-up','data-market-down']){
  assert.ok(adminApp.includes(action),'market CMS needs '+action);
}
assert.ok(html.includes('window.__VERRE_MARKETS__'),'the storefront must accept server-managed market dates');

for(const file of ['admin/app.js','pos/app.js']){
  const clientAuth=await readFile(resolve(root,file),'utf8');
  assert.match(clientAuth,/\/login\?return_to=/,file+' must send a 401 to the login page');
}

// A wildcard select on admin_accounts now drags password_hash out of the
// database, and listAccounts renders into the browser.
const accountsDb=await readFile(resolve(root,'src','db','accounts.js'),'utf8');
// Comments stripped first — they explain exactly why these columns are excluded
// and would otherwise trip the check they document.
const accountsCode=accountsDb.split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');
assert.ok(!/admin_accounts[^)]*select=\*/.test(accountsCode),'admin_accounts must never be queried with select=*');
for(const column of ['password_hash','failed_attempts','locked_until']){
  assert.ok(!accountsCode.includes(column),'no admin_accounts query may select '+column);
}
// The POS shell is cache-first, so a SHELL file changing without VERSION moving
// means every installed till keeps serving the old build indefinitely.
const sw=await readFile(resolve(root,'pos','sw.js'),'utf8');
const shellVersion=sw.match(/VERSION\s*=\s*'([^']+)'/)?.[1];
assert.ok(shellVersion,'pos/sw.js must declare a cache VERSION');
const posStyleRaw=await readFile(resolve(root,'pos','style.css'),'utf8');
// Comments stripped first. They explain why these declarations matter and
// therefore quote them verbatim, which made an earlier version of this check
// match its own documentation and pass with the real declaration deleted.
const posStyle=posStyleRaw.replace(/\/\*[\s\S]*?\*\//g,'');
// min-height:0 is what lets the scrolling pane shrink instead of overflowing on
// top of the totals. Losing it reintroduces the overlapping-cart bug. Matched
// on the rule containing the selector rather than an exact selector string, so
// grouping it with another selector does not defeat the check.
const scrollRule=posStyle.match(/[^}]*\.cart-lines[^{]*\{[^}]*\}/);
assert.ok(scrollRule&&/min-height:0/.test(scrollRule[0]),'.cart-lines needs min-height:0 to scroll rather than overflow');
assert.ok(scrollRule&&/overflow-y:auto/.test(scrollRule[0]),'.cart-lines needs its own scrollbar');
assert.match(posStyle,/\.cart\{[^}]*overflow:hidden/,'.cart must clip so the total and pay button stay pinned');

// The cart is a two-step flow. Both panes stay mounted because app.js reads
// #tendered / #discount / #gcash-reference straight from the DOM — swapping to
// removal would break payment silently, with no error anywhere.
const posMarkup=await readFile(resolve(root,'pos','index.html'),'utf8');
for(const id of ['tendered','gcash-reference','discount','discount-reason','to-payment','back-to-cart','complete']){
  assert.ok(posMarkup.includes('id="'+id+'"'),'pos markup must keep #'+id+' mounted');
}
assert.match(posStyle,/\.cart\[data-view="cart"\][\s\S]{0,120}display:none/,'the cart step must hide the payment pane');
assert.match(posStyle,/\.cart\[data-view="pay"\][\s\S]{0,160}display:none/,'the payment step must hide the line list');

const clientFiles=[
  resolve(root,'dist','client','index.html'),
  resolve(root,'dist','client','admin','app.js'),
  resolve(root,'dist','client','pos','app.js')
];
for(const file of clientFiles){
  const client=await readFile(file,'utf8');
  assert.doesNotMatch(client,/SUPABASE_SERVICE_ROLE_KEY|CF_ACCESS_AUD/,'secret configuration names leaked into '+file);
}
console.log('ok — migrations enforce ledger, idempotency, RLS, private storage, and locked-down RPCs');
