import assert from 'node:assert/strict';
import worker from './worker.js';
import { _test } from './auth.js';

const encoder = new TextEncoder();
const b64 = (value) => Buffer.from(typeof value === 'string' ? value : value).toString('base64url');
const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' },
  true,
  ['sign','verify']
);
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
jwk.kid = 'access-test';
const header = b64(JSON.stringify({ alg:'RS256', kid:jwk.kid, typ:'JWT' }));
const payload = b64(JSON.stringify({
  iss:'https://verre.cloudflareaccess.com',
  aud:['admin-audience'],
  email:'kyle@example.com',
  exp:Math.floor(Date.now()/1000)+300
}));
const input = header+'.'+payload;
const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, encoder.encode(input));
const token = input+'.'+b64(new Uint8Array(signature));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ keys:[jwk] }), { headers:{'content-type':'application/json'} });

const verified = await _test.verifyAccessJwt(token, {
  CF_ACCESS_TEAM_DOMAIN:'https://verre.cloudflareaccess.com',
  CF_ACCESS_AUD:'admin-audience'
});
assert.equal(verified.email,'kyle@example.com');
assert.equal(await _test.verifyAccessJwt(token.slice(0,-2)+'xx', {
  CF_ACCESS_TEAM_DOMAIN:'https://verre.cloudflareaccess.com',
  CF_ACCESS_AUD:'admin-audience'
}),null,'a tampered signature is rejected');
globalThis.fetch = originalFetch;

const env={ASSETS:{fetch:async()=>new Response('asset')}};
assert.equal((await worker.fetch(new Request('https://verre.test/api/admin/me'),env)).status,401);
assert.equal((await worker.fetch(new Request('https://verre.test/api/pos/products'),env)).status,401);
// The dispatcher header path is gone. This asserts it stays gone: it was an
// unsigned string that granted Super Admin to anyone who could set a header.
const forged=new Request('https://verre.test/api/admin/me',{headers:{'oai-authenticated-user-email':'attacker@example.com'}});
assert.equal((await worker.fetch(forged,env)).status,401,'the Sites identity header grants nothing');
const alsoForged=new Request('https://verre.test/api/admin/me',{headers:{
  'oai-authenticated-user-email':'kvb.engo@gmail.com','x-sites-dispatcher-secret':'anything'
}});
assert.equal((await worker.fetch(alsoForged,{...env,TRUST_SITES_AUTH:'true',SITES_HOSTNAME:'verre.test',SUPER_ADMIN_EMAILS:'kvb.engo@gmail.com'})).status,401,
  'reviving TRUST_SITES_AUTH via env must not work — the code path no longer exists');

const local={...env,LOCAL_AUTH_BYPASS:'true',LOCAL_AUTH_EMAIL:'local@verre.test',SUPER_ADMIN_EMAILS:'local@verre.test'};
const me=await worker.fetch(new Request('http://localhost/api/admin/me'),local);
assert.equal(me.status,200);
// The shape the admin shell actually consumes: api() unwraps `body.data ?? body`
// and assigns it straight to state.me, so `data` must BE the user. Returning
// {ok,user} instead leaves state.me.role undefined and the shell hangs on
// "Loading the studio…" with no error surfaced anywhere.
const mePayload=await me.json();
assert.equal(mePayload.data.email,'local@verre.test');
assert.ok(mePayload.data.role,'me must carry a role — the shell routes on it');
assert.equal(mePayload.user,undefined,'the user must not also sit at the top level');

/* ------------------------------------------------------------------ */
/* password login                                                      */
/* ------------------------------------------------------------------ */

const { _test:authApiTest } = await import('./api/auth.js');
const { hashToken, newToken } = await import('./db/sessions.js');

// Minimal fake of the Supabase REST surface db/client.js talks to. Enough to
// exercise the routing, cookie and enumeration behaviour without a database.
function fakeSupabase({ password='correct horse battery', locked=false }={}) {
  const sessions=new Map();
  const account={id:'11111111-1111-4111-8111-111111111111',email:'kyle@example.com',display_name:'Kyle',role:'super_admin'};
  return {
    sessions,
    account,
    fetch: async (url, options={}) => {
      const path=new URL(url).pathname;
      const payload=options.body?JSON.parse(options.body):{};
      const ok=(data)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
      if(path.endsWith('/rpc/verify_password')){
        if(payload.p_email!==account.email) return ok({ok:false,reason:'INVALID'});
        if(locked) return ok({ok:false,reason:'LOCKED'});
        return ok(payload.p_password===password?{ok:true,account}:{ok:false,reason:'INVALID'});
      }
      if(path.endsWith('/rpc/session_identity')){
        const row=sessions.get(payload.p_token_hash);
        return ok(row?{session_id:'s1',account_id:account.id,email:account.email,display_name:account.display_name,role:account.role}:null);
      }
      if(path.endsWith('/admin_sessions')){
        if(options.method==='POST'){sessions.set(payload.token_hash,payload);return ok([payload])}
        // PATCH = revoke. The query string carries the filter; clearing the map
        // is close enough for these assertions.
        sessions.clear();return ok([]);
      }
      if(path.endsWith('/admin_accounts')) return ok([account]);
      return ok(null);
    }
  };
}

const stub=fakeSupabase();
const realFetch=globalThis.fetch;
globalThis.fetch=stub.fetch;
const dbEnv={...env,SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'k',SUPER_ADMIN_EMAILS:'kyle@example.com'};
const post=(path,payload,headers={})=>new Request('https://verre.test/api/auth/'+path,{
  method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(payload)
});

// Wrong password, unknown account and locked account must be indistinguishable.
const wrong=await worker.fetch(post('login',{email:'kyle@example.com',password:'nope'}),dbEnv);
const unknown=await worker.fetch(post('login',{email:'nobody@example.com',password:'nope'}),dbEnv);
const wrongBody=await wrong.json(), unknownBody=await unknown.json();
assert.equal(wrong.status,401);
assert.equal(unknown.status,401);
assert.deepEqual(wrongBody,unknownBody,'wrong password and unknown account are byte-identical');
assert.equal(wrongBody.error,authApiTest.GENERIC_LOGIN_ERROR);

const good=await worker.fetch(post('login',{email:'kyle@example.com',password:'correct horse battery'}),dbEnv);
assert.equal(good.status,200);
const cookie=good.headers.get('set-cookie');
assert.match(cookie,/^verre_session=/);
assert.match(cookie,/HttpOnly/,'cookie must be HttpOnly');
assert.match(cookie,/Secure/,'cookie must be Secure on a deployed host');
assert.match(cookie,/SameSite=Lax/);
assert.match(cookie,/Max-Age=86400/,'24h, fixed');

// The cookie value must not be what is stored — the table holds a digest.
const issued=cookie.split(';')[0].split('=')[1];
assert.ok(!stub.sessions.has(issued),'raw token must never be a key in the table');
assert.ok(stub.sessions.has(await hashToken(issued)),'the stored key is the SHA-256 digest');

// That cookie now opens /admin.
const withCookie=(path)=>new Request('https://verre.test'+path,{headers:{cookie:'verre_session='+issued}});
assert.equal((await worker.fetch(withCookie('/api/admin/me'),dbEnv)).status,200,'session cookie authenticates');
assert.equal((await worker.fetch(withCookie('/api/auth/me'),dbEnv)).status,200);

// Logout revokes server-side, so replaying the captured cookie fails.
await worker.fetch(new Request('https://verre.test/api/auth/logout',{method:'POST',headers:{cookie:'verre_session='+issued}}),dbEnv);
assert.equal((await worker.fetch(withCookie('/api/admin/me'),dbEnv)).status,401,'a revoked cookie is dead');

// A random token is not a session.
assert.equal((await worker.fetch(new Request('https://verre.test/api/admin/me',{headers:{cookie:'verre_session='+newToken()}}),dbEnv)).status,401);

// Reset never reveals whether an account exists.
const known=await worker.fetch(post('request-reset',{email:'kyle@example.com'}),dbEnv);
const missing=await worker.fetch(post('request-reset',{email:'ghost@example.com'}),dbEnv);
assert.equal(known.status,200);
assert.equal(missing.status,200);
assert.deepEqual(await known.json(),await missing.json(),'reset responses are identical either way');

globalThis.fetch=realFetch;

/* ------------------------------------------------------------------ */
/* browser vs fetch, and open redirects                                */
/* ------------------------------------------------------------------ */

const nav=await worker.fetch(new Request('https://verre.test/admin',{headers:{'sec-fetch-mode':'navigate'}}),env);
assert.equal(nav.status,302,'a person typing /admin is sent to the login page');
assert.equal(new URL(nav.headers.get('location')).pathname,'/login');
const xhr=await worker.fetch(new Request('https://verre.test/admin',{headers:{'sec-fetch-mode':'cors'}}),env);
assert.equal(xhr.status,401,'a fetch gets JSON it can branch on, not an HTML redirect');

for(const evil of ['//evil.com','https://evil.com','javascript:alert(1)']){
  const redirect=await worker.fetch(new Request('https://verre.test/signin-with-chatgpt?return_to='+encodeURIComponent(evil)),env);
  const target=new URL(redirect.headers.get('location'));
  assert.equal(target.origin,'https://verre.test');
  assert.equal(target.searchParams.get('return_to'),'/',`return_to=${evil} must not survive`);
}

// Password policy: length is the property that matters.
assert.equal(authApiTest.passwordProblem('correct horse battery staple'),null);
assert.ok(authApiTest.passwordProblem('short'),'under 12 characters is rejected');
assert.ok(authApiTest.passwordProblem('password1234'),'obvious passwords are rejected');

// Cookie parsing must find the right one among several.
const multi=new Request('https://verre.test/',{headers:{cookie:'a=1; verre_session=abc123; b=2'}});
assert.equal(authApiTest.readCookie(multi),'abc123');
assert.equal(authApiTest.readCookie(new Request('https://verre.test/')),null);

// Secure is dropped only on plain-http localhost, where the browser would
// refuse the cookie outright.
assert.ok(!authApiTest.sessionCookie('t',new URL('http://localhost/')).includes('Secure'));
assert.ok(authApiTest.sessionCookie('t',new URL('https://verre.test/')).includes('Secure'));

/* ------------------------------------------------------------------ */
/* unconfigured deployment                                             */
/* ------------------------------------------------------------------ */

// A Worker deployed without Supabase secrets. Every branch below is an error
// path, which is exactly the code least likely to have been run before it
// matters — an earlier version called an `unavailable()` helper that was never
// defined, so this path threw a ReferenceError and returned a 500 with no JSON
// body. The login page then reported "unreadable response" and the real cause
// was invisible.
const bare = { ASSETS: { fetch: async () => new Response('asset') } };
const loginRequest = () => new Request('https://verre.test/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'kyle@example.com', password: 'correct horse battery' })
});

const unconfigured = await worker.fetch(loginRequest(), bare);
assert.equal(unconfigured.status, 503, 'sign-in on an unconfigured deployment is 503, not a crash');
assert.match(unconfigured.headers.get('content-type'), /application\/json/, 'and it is still JSON the page can read');
const unconfiguredBody = await unconfigured.json();
assert.equal(unconfiguredBody.ok, false);
// "temporarily unavailable" sends whoever is deploying looking for an outage.
// Missing secrets is a different problem with a different fix, so name it.
assert.equal(unconfiguredBody.code, 'AUTH_NOT_CONFIGURED');
assert.match(unconfiguredBody.error, /not configured/i);

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */

const health = await worker.fetch(new Request('https://verre.test/api/health'), bare);
assert.equal(health.status, 503, 'an unconfigured deployment is not ready');
const healthBody = await health.json();
assert.equal(healthBody.data.ready, false);
assert.equal(healthBody.data.database, 'not-configured');
assert.equal(healthBody.data.configured.database, false);
assert.equal(healthBody.data.configured.email, false);
assert.match(healthBody.data.hint, /SUPABASE_URL/, 'health must say what to do, not just what is wrong');

// The failure that actually happened in production: tables read fine, so the
// credentials are right and products load — but verify_password was never
// created, so sign-in alone is dead. A health check that only probes a table
// reports "ok" through this and is worse than useless.
const missingFn = {
  ...bare,
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  SUPER_ADMIN_EMAILS: 'kyle@example.com'
};
const realFetchHealth = globalThis.fetch;
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/rpc/verify_password')) {
    return new Response(
      JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.verify_password' }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    );
  }
  return new Response(JSON.stringify([{ id: true }]), { headers: { 'content-type': 'application/json' } });
};
const partial = await worker.fetch(new Request('https://verre.test/api/health'), missingFn);
const partialBody = await partial.json();
globalThis.fetch = realFetchHealth;

assert.equal(partial.status, 503, 'a database that cannot authenticate is not ready');
assert.equal(partialBody.data.database, 'ok', 'tables are readable');
assert.equal(partialBody.data.auth, 'missing-function', 'but the sign-in function is absent, and it says so');
assert.match(partialBody.data.hint, /db push/i, 'and names the fix');

// Booleans only. A public endpoint that echoes a URL or a key fragment would be
// a far worse problem than the one it was added to solve.
const healthText = JSON.stringify(healthBody);
for (const secret of ['supabase.co', 'sb_secret', 're_', 'http']) {
  assert.ok(!healthText.includes(secret), 'health must not leak "' + secret + '"');
}
assert.equal((await worker.fetch(new Request('https://verre.test/api/health', { method: 'POST' }), bare)).status, 405);

console.log('ok — Access signature, password login, session cookies, enumeration parity, redirect safety, unconfigured deploys');

