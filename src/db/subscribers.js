import { db } from './client.js';

export const addSubscriber = (env, email, source) =>
  db(env).rpc('subscribe', { p_email: email, p_source: source || 'storefront' });

export const removeSubscriber = (env, token) =>
  db(env).rpc('unsubscribe', { p_token: token });

/**
 * Admin export. Deliberately excludes `unsubscribe_token` — that token is a
 * live credential for removing someone from the list, and it has no business
 * in a CSV that gets emailed around or opened in a spreadsheet.
 */
export const listSubscribers = (env) =>
  db(env).rest(
    'subscribers',
    'select=email,source,created_at,unsubscribed_at&order=created_at.desc&limit=5000'
  );
