import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root=resolve(import.meta.dirname,'..');
const migrations=(await readdir(resolve(root,'supabase','migrations'))).filter(name=>name.endsWith('.sql')).sort();
const sql=(await Promise.all(migrations.map(name=>readFile(resolve(root,'supabase','migrations',name),'utf8')))).join('\n');
const tables=['products','product_images','pos_sessions','orders','order_items','stock_movements','admin_audit_log','admin_accounts'];
for(const table of tables)assert.match(sql,new RegExp(`alter table ${table} enable row level security`),table+' must have RLS');
assert.doesNotMatch(sql,/\bcreate\s+policy\b/i,'deny-all RLS must not have permissive policies');
for(const fn of ['record_sale','adjust_stock','create_inquiry','set_order_status','void_pos_sale','dashboard_snapshot','set_admin_account']){
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
// Auto-rotating a panel that contains a form can swap it mid-sentence.
assert.ok(!/connectTab[\s\S]{0,200}setInterval/.test(html),'the connect carousel must never rotate on a timer');

const wrangler=await readFile(resolve(root,'wrangler.toml'),'utf8');
assert.match(
  wrangler,
  /run_worker_first\s*=\s*\["\/admin",\s*"\/admin\/\*",\s*"\/pos",\s*"\/pos\/\*"\]/,
  'bare and nested admin/POS asset paths must run through Worker authorization'
);
for(const file of ['admin/app.js','pos/app.js']){
  const clientAuth=await readFile(resolve(root,file),'utf8');
  assert.match(clientAuth,/\/login\?return_to=/,file+' must send a 401 to the login page');
}
// /login is the page you reach *because* you are not signed in. Listing it in
// run_worker_first would gate the sign-in form behind sign-in.
assert.ok(!/run_worker_first[^\]]*\/login/.test(wrangler),'/login must not be gated');

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
