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

const html=await readFile(resolve(root,'index.html'),'utf8');
assert.doesNotMatch(html,/const PRODUCTS\b/,'the storefront must not embed a product catalog');
const wrangler=await readFile(resolve(root,'wrangler.toml'),'utf8');
assert.match(
  wrangler,
  /run_worker_first\s*=\s*\["\/admin",\s*"\/admin\/\*",\s*"\/pos",\s*"\/pos\/\*"\]/,
  'bare and nested admin/POS asset paths must run through Worker authorization'
);
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
