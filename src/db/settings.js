import { db } from './client.js';

/**
 * The storefront renders on every request, so a database hiccup must not take
 * the homepage down over a decoration. A failed read returns null, which the
 * resolver treats as "follow the calendar" — the site simply looks like the
 * time of year, which is the correct answer anyway.
 */
export async function getThemeOverride(env) {
  const result = await db(env).rest('site_settings', 'select=theme_override&limit=1');
  if (result.error) {
    console.error('settings: theme read failed — ' + result.error.code);
    return null;
  }
  return result.data?.[0]?.theme_override ?? null;
}

export const setThemeOverride = (env, theme, actor) =>
  db(env).rpc('set_theme_override', { p_theme: theme, p_actor: actor });
