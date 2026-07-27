import { resolveTheme, themeById } from '../themes.js';
import { getThemeOverride } from '../db/settings.js';

/**
 * Serve the storefront with its theme already decided.
 *
 * Injected server-side rather than fetched by the page, because the hero is the
 * first thing on screen: resolving the theme in the browser would paint the
 * everyday pink and then swap to Christmas a moment later. A marketing feature
 * that visibly changes its mind is worse than not having it.
 */
export async function themedPage(request, env, assetRequest) {
  const response = await env.ASSETS.fetch(assetRequest);
  if (!response.ok) return response;

  const url = new URL(request.url);
  // ?theme=<id> previews a season without switching it on for anyone else.
  // Purely decorative, so there is nothing to protect here — and being
  // shareable is the point, it is how you show someone a season before it runs.
  const preview = url.searchParams.get('theme');
  const override = preview || await cachedOverride(env);
  const { theme, source, warning } = resolveTheme(override, new Date());
  if (warning) console.warn('theme: ' + warning);

  const payload = {
    id: theme.id,
    label: theme.label,
    hero: theme.hero,
    accent: theme.accent,
    accentDeep: theme.accentDeep,
    onHero: theme.onHero,
    ribbon: theme.ribbon,
    decor: theme.decor,
    source: preview ? 'preview' : source
  };

  const html = await response.text();
  // JSON inside a script element: `<` must not be able to close it early.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const tag = '<script>window.__VERRE_THEME__=' + json + ';</script>';
  const themed = html.includes('</head>')
    ? html.replace('</head>', tag + '</head>')
    : tag + html;

  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  // Short and revalidated: a season starting or an override flipping should
  // reach visitors in about a minute, not whenever a CDN feels like it.
  headers.set('cache-control', preview ? 'no-store' : 'public, max-age=60, must-revalidate');
  headers.set('x-verre-theme', payload.id);
  headers.delete('content-length'); // body length changed
  return new Response(themed, { status: response.status, headers });
}

async function cachedOverride(env) {
  if (!env.CATALOG_CACHE) return getThemeOverride(env);
  try {
    const cached = await env.CATALOG_CACHE.get('theme:override');
    // '' is a real cached value meaning "no override". Only a true miss (null)
    // should hit the database.
    if (cached !== null) return cached || null;
  } catch {}
  const override = await getThemeOverride(env);
  try {
    await env.CATALOG_CACHE.put('theme:override', override || '', { expirationTtl: 60 });
  } catch {}
  return override;
}

export const currentTheme = async (env) => {
  const override = await getThemeOverride(env);
  const resolved = resolveTheme(override, new Date());
  return { override: override || null, active: resolved.theme.id, source: resolved.source };
};

export const isKnownTheme = (id) => id === 'auto' || Boolean(themeById(id));
