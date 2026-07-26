import { findAccountByEmail } from './db/accounts.js';

export const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  GENERAL_ADMIN: 'general_admin',
  CASHIER: 'cashier'
});

const CAPABILITIES = Object.freeze({
  super_admin: ['admin', 'dashboard', 'catalog', 'inventory', 'sales', 'sessions', 'accounts', 'pos'],
  general_admin: ['admin', 'dashboard', 'inventory', 'sales', 'sessions', 'pos'],
  cashier: ['pos']
});

const emails = (value) => String(value || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export function isBootstrapSuperAdmin(email, env) {
  const configured = env.SUPER_ADMIN_EMAILS || env.ADMIN_EMAILS;
  return emails(configured).includes(String(email || '').toLowerCase());
}

export function can(user, capability) {
  return Boolean(user && CAPABILITIES[user.role]?.includes(capability));
}

export async function resolveUser(env, identity) {
  if (!identity?.email) return { data: null, error: null };
  const email = identity.email.toLowerCase();
  if (isBootstrapSuperAdmin(email, env)) {
    return {
      data: {
        ...identity,
        email,
        display_name: identity.name || email,
        role: ROLES.SUPER_ADMIN,
        capabilities: CAPABILITIES[ROLES.SUPER_ADMIN],
        bootstrap: true
      },
      error: null
    };
  }

  const account = await findAccountByEmail(env, email);
  if (account.error) return account;
  if (!account.data) return { data: null, error: null };
  return {
    data: {
      ...identity,
      id: account.data.id,
      email,
      display_name: account.data.display_name,
      role: account.data.role,
      capabilities: CAPABILITIES[account.data.role] || [],
      bootstrap: false
    },
    error: null
  };
}

export const _test = { CAPABILITIES, emails };
