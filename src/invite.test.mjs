import assert from 'node:assert/strict';
import { sendAccountInvite } from './api/invite.js';

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ana@example.com',
  display_name: 'Ana <script>alert(1)</script>',
  role: 'general_admin',
  active: true
};
let delivery;
const sent = await sendAccountInvite(
  { RESEND_API_KEY: 're_test', FROM_EMAIL: 'Verre <hello@mail.verre.test>' },
  account,
  'https://verrecrafts.shop',
  { display_name: 'Kyle' },
  {
    createReset: async (_env, id) => {
      assert.equal(id, account.id);
      return { data: { token: 'private-token' }, error: null };
    },
    fetch: async (url, options) => {
      delivery = { url, options, body: JSON.parse(options.body) };
      return new Response('{}', { status: 200 });
    }
  }
);

assert.equal(sent.sent, true);
assert.equal(delivery.url, 'https://api.resend.com/emails');
assert.equal(delivery.body.to, account.email);
assert.ok(delivery.body.text.includes('https://verrecrafts.shop/login/reset?token=private-token&invite=1'));
assert.ok(delivery.body.html.startsWith('<!doctype html>'));
assert.ok(delivery.body.html.includes('Create my password'));
assert.ok(delivery.body.html.includes('General Admin'));
assert.ok(!delivery.body.html.includes('<script>alert(1)</script>'), 'staff details are escaped in the email');
assert.ok(delivery.body.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

let created = false;
const unconfigured = await sendAccountInvite({}, account, 'https://verrecrafts.shop', {}, {
  createReset: async () => { created = true; return { data: { token: 'never' }, error: null }; }
});
assert.equal(unconfigured.sent, false);
assert.equal(unconfigured.status, 503);
assert.equal(created, false, 'do not create a live token when email cannot deliver it');

const rejected = await sendAccountInvite(
  { RESEND_API_KEY: 're_test', FROM_EMAIL: 'Verre <hello@mail.verre.test>' },
  account,
  'https://verrecrafts.shop',
  {},
  {
    createReset: async () => ({ data: { token: 'private-token' }, error: null }),
    fetch: async () => new Response('{}', { status: 500 })
  }
);
assert.equal(rejected.sent, false);
assert.equal(rejected.status, 502);

console.log('ok — staff invitations use one-time password links and branded email');
