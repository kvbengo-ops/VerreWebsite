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
assert.equal(_test.allowed('kyle@example.com',{ADMIN_EMAILS:'kyle@example.com'}),true);
assert.equal(_test.allowed('other@example.com',{ADMIN_EMAILS:'kyle@example.com'}),false);
assert.equal(_test.allowed('kyle@example.com',{}),false,'Cloudflare Access requires an explicit allowlist');
globalThis.fetch = originalFetch;

const env={ASSETS:{fetch:async()=>new Response('asset')}};
assert.equal((await worker.fetch(new Request('https://verre.test/api/admin/me'),env)).status,401);
assert.equal((await worker.fetch(new Request('https://verre.test/api/pos/products'),env)).status,401);
const forged=new Request('https://verre.test/api/admin/me',{headers:{'oai-authenticated-user-email':'attacker@example.com'}});
assert.equal((await worker.fetch(forged,env)).status,401,'a client-supplied Sites identity is not trusted by default');
const local={...env,LOCAL_AUTH_BYPASS:'true',LOCAL_AUTH_EMAIL:'local@verre.test'};
const me=await worker.fetch(new Request('http://localhost/api/admin/me'),local);
assert.equal(me.status,200);
assert.equal((await me.json()).user.email,'local@verre.test');

console.log('ok — Access signature, allowlist, protected routes, and localhost bypass');
