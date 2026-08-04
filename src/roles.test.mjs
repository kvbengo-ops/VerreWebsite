import assert from 'node:assert/strict';
import { adminApi } from './api/admin.js';
import { deleteAccount } from './db/accounts.js';
import { posApi } from './api/pos.js';
import { ROLES, can, isBootstrapSuperAdmin, resolveUser } from './roles.js';
import worker from './worker.js';

const superAdmin={email:'owner@example.com',role:ROLES.SUPER_ADMIN};
const generalAdmin={email:'admin@example.com',role:ROLES.GENERAL_ADMIN};
const cashier={email:'cashier@example.com',role:ROLES.CASHIER};

for(const capability of ['admin','dashboard','catalog','inventory','sales','sessions','accounts','pos']){
  assert.equal(can(superAdmin,capability),true,'Super Admin needs '+capability);
}
for(const capability of ['admin','inventory','sales','pos']){
  assert.equal(can(generalAdmin,capability),true,'General Admin needs '+capability);
}
assert.equal(can(generalAdmin,'dashboard'),false,'General Admin cannot view the Super Admin dashboard');
assert.equal(can(generalAdmin,'sessions'),false,'General Admin cannot administer sessions outside POS');
assert.equal(can(generalAdmin,'catalog'),false,'General Admin cannot manage products');
assert.equal(can(generalAdmin,'accounts'),false,'General Admin cannot manage accounts');
assert.equal(can(cashier,'pos'),true,'Cashier can use POS');
assert.equal(can(cashier,'admin'),false,'Cashier cannot use admin');

const bootstrapEnv={SUPER_ADMIN_EMAILS:'owner@example.com, backup@example.com'};
assert.equal(isBootstrapSuperAdmin('OWNER@example.com',bootstrapEnv),true);
const bootstrap=await resolveUser(bootstrapEnv,{email:'OWNER@example.com',name:'Owner'});
assert.equal(bootstrap.data.role,ROLES.SUPER_ADMIN);
assert.equal(bootstrap.data.bootstrap,true);

const deniedWrite=await adminApi(
  new Request('https://verre.test/api/admin/products',{method:'POST',body:'{}'}),
  {},
  generalAdmin
);
assert.equal(deniedWrite.status,403,'General Admin product writes are denied before database access');
const deniedAccounts=await adminApi(
  new Request('https://verre.test/api/admin/accounts'),
  {},
  generalAdmin
);
assert.equal(deniedAccounts.status,403,'General Admin account management is denied');
const cashierMe=await posApi(new Request('https://verre.test/api/pos/me'),{},cashier);
assert.equal(cashierMe.status,200);
assert.equal((await cashierMe.json()).data.role,ROLES.CASHIER);

const originalFetch=globalThis.fetch;
globalThis.fetch=async (url)=>{
  assert.match(String(url),/admin_accounts/);
  return new Response(JSON.stringify([{
    id:'00000000-0000-4000-8000-000000000001',
    email:'admin@example.com',
    display_name:'Studio Admin',
    role:'general_admin',
    active:true
  }]),{headers:{'content-type':'application/json'}});
};
const resolved=await resolveUser(
  {SUPABASE_URL:'https://database.example',SUPABASE_SERVICE_ROLE_KEY:'secret'},
  {email:'ADMIN@example.com'}
);
globalThis.fetch=originalFetch;
assert.equal(resolved.error,null);
assert.equal(resolved.data.role,ROLES.GENERAL_ADMIN);
assert.equal(resolved.data.display_name,'Studio Admin');

const actorId='00000000-0000-4000-8000-000000000010';
const selectedAccountId='00000000-0000-4000-8000-000000000011';
let deleteRpcPayload;
globalThis.fetch=async (url,options={})=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/admin_accounts')){
    return new Response(JSON.stringify([{
      id:selectedAccountId,
      email:'staff@example.com',
      display_name:'Staff Member',
      role:'general_admin',
      active:true
    }]),{headers:{'content-type':'application/json'}});
  }
  assert.match(path,/\/rpc\/delete_admin_account$/);
  deleteRpcPayload=JSON.parse(options.body);
  return new Response(JSON.stringify({id:selectedAccountId}),{headers:{'content-type':'application/json'}});
};
const deleteEnv={SUPABASE_URL:'https://database.example',SUPABASE_SERVICE_ROLE_KEY:'secret'};
const deleted=await adminApi(
  new Request(`https://verre.test/api/admin/accounts/${selectedAccountId}`,{method:'DELETE'}),
  deleteEnv,
  {email:'owner@example.com',account_id:actorId,role:ROLES.SUPER_ADMIN}
);
assert.equal(deleted.status,200);
assert.deepEqual(deleteRpcPayload,{p_id:selectedAccountId,p_actor:actorId},'account deletion sends only UUIDs to the RPC');

let malformedRpcCalled=false;
globalThis.fetch=async ()=>{malformedRpcCalled=true;throw new Error('RPC must not be called')};
const missingActor=await adminApi(
  new Request(`https://verre.test/api/admin/accounts/${selectedAccountId}`,{method:'DELETE'}),
  deleteEnv,
  {email:'owner@example.com',role:ROLES.SUPER_ADMIN}
);
assert.equal(missingActor.status,401);
assert.match((await missingActor.json()).error,/identify the signed-in administrator/i);
const malformedTarget=await deleteAccount(deleteEnv,'staff@example.com',actorId);
assert.equal(malformedTarget.error.code,'INVALID_ACCOUNT_ID');
assert.equal(malformedRpcCalled,false,'malformed UUIDs are rejected before the RPC');

globalThis.fetch=async ()=>new Response(JSON.stringify([{
  id:'00000000-0000-4000-8000-000000000002',
  email:'cashier@example.com',
  display_name:'Market Cashier',
  role:'cashier',
  active:true
}]),{headers:{'content-type':'application/json'}});
const cashierEnv={
  SUPABASE_URL:'https://database.example',
  SUPABASE_SERVICE_ROLE_KEY:'secret',
  LOCAL_AUTH_BYPASS:'true',
  LOCAL_AUTH_EMAIL:'cashier@example.com',
  ASSETS:{fetch:async ()=>new Response('POS shell')}
};
assert.equal(
  (await worker.fetch(new Request('http://localhost/admin'),cashierEnv)).status,
  403,
  'Cashier cannot load the admin shell'
);
assert.equal(
  (await worker.fetch(new Request('http://localhost/pos'),cashierEnv)).status,
  200,
  'Cashier can load the POS shell'
);
globalThis.fetch=originalFetch;

console.log('ok — role capabilities, bootstrap access, API denial, and database role lookup');
