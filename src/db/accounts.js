import { db } from './client.js';

const encode = encodeURIComponent;

export async function findAccountByEmail(env, email) {
  const result = await db(env).rest(
    'admin_accounts',
    `select=*&email=eq.${encode(String(email || '').toLowerCase())}&active=eq.true&limit=1`
  );
  return result.error ? result : { data: result.data?.[0] || null, error: null };
}

export const listAccounts = (env) =>
  db(env).rest('admin_accounts', 'select=*&order=active.desc,role.asc,display_name.asc');

export const saveAccount = (env, account, actor) => db(env).rpc('set_admin_account', {
  p_id: account.id || null,
  p_email: account.email,
  p_display_name: account.display_name,
  p_role: account.role,
  p_active: account.active !== false,
  p_actor: actor
});
