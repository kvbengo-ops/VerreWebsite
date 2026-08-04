import { db } from './client.js';

const encode = encodeURIComponent;

// Explicit column list, never `select=*`.
//
// admin_accounts now holds password_hash, failed_attempts and locked_until. A
// wildcard select sends all three to whoever called — and listAccounts renders
// straight into the browser, so a wildcard here would put bcrypt hashes in the
// admin page's network tab. Add columns deliberately; the default is exclusion.
const SAFE_COLUMNS = 'id,email,display_name,role,active,created_at,updated_at,last_login_at,password_set_at';
const SAFE_KEYS = SAFE_COLUMNS.split(',');
const safeAccount = (account) => account && Object.fromEntries(SAFE_KEYS.map((key) => [key, account[key]]));
export const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));

export async function findAccountByEmail(env, email) {
  const result = await db(env).rest(
    'admin_accounts',
    `select=${SAFE_COLUMNS}&email=eq.${encode(String(email || '').toLowerCase())}&active=eq.true&limit=1`
  );
  return result.error ? result : { data: result.data?.[0] || null, error: null };
}

export async function findAccountById(env, id) {
  const result = await db(env).rest(
    'admin_accounts',
    `select=${SAFE_COLUMNS}&id=eq.${encode(id)}&limit=1`
  );
  return result.error ? result : { data: result.data?.[0] || null, error: null };
}

export const listAccounts = (env) =>
  db(env).rest('admin_accounts', `select=${SAFE_COLUMNS}&order=active.desc,role.asc,display_name.asc`);

export async function saveAccount(env, account, actor) {
  const result = await db(env).rpc('set_admin_account', {
    p_id: account.id || null,
    p_email: account.email,
    p_display_name: account.display_name,
    p_role: account.role,
    p_active: account.active !== false,
    p_actor: actor
  });
  return result.error ? result : { data: safeAccount(result.data), error: null };
}

export async function deleteAccount(env, id, actor) {
  if (!isUuid(actor)) {
    return { data: null, error: { message: 'Unable to identify the signed-in administrator.', code: 'INVALID_ACTOR_ID' } };
  }
  if (!isUuid(id)) {
    return { data: null, error: { message: 'Unable to identify the selected administrator account.', code: 'INVALID_ACCOUNT_ID' } };
  }
  const result = await db(env).rpc('delete_admin_account', {
    p_id: id,
    p_actor: actor
  });
  return result.error ? result : { data: safeAccount(result.data), error: null };
}
