import { resolveTheme, themeById } from '../themes.js';
import { getThemeOverride } from '../db/settings.js';
import { listPublicMarkets } from '../db/markets.js';

/**
 * Serve the storefront with its theme already decided.
 *
 * Injected server-side rather than fetched by the page, because the hero is the
 * first thing on screen: resolving the theme in the browser would paint the
 * everyday pink and then swap to Christmas a moment later. A marketing feature
 * that visibly changes its mind is worse than not having it.
 */
export async function themedPage(request, env) {
  // Hand the path to ASSETS untouched.
  //
  // Rewriting '/' to '/index.html' makes the asset layer canonicalise it
  // straight back to '/' with a 307, and now that '/' is in run_worker_first
  // that redirect comes back here and does it again — the browser ping-pongs
  // until it gives up with ERR_TOO_MANY_REDIRECTS. Directory indexes are the
  // asset layer's job, exactly as noted for '/admin/' in worker.js.
  // Strip the conditional headers before asking for the asset.
  //
  // Left in place, the asset layer answers a repeat visit with 304 Not
  // Modified — correct about index.html, wrong about the page, because the
  // theme is injected here and is not part of that file. The browser then
  // reuses its cached copy with whatever season was live when it first loaded,
  // and the only thing that shakes it loose is index.html changing, i.e. a
  // rebuild. We need the body every time so we can dress it.
  const assetRequest = new Request(request);
  assetRequest.headers.delete('if-none-match');
  assetRequest.headers.delete('if-modified-since');

  const response = await env.ASSETS.fetch(assetRequest);
  // Anything that is not a document — a redirect, a 404 — passes through
  // untouched. Injecting into it would also mean returning it, which is how the
  // loop above sustained itself.
  if (!response.ok) return response;

  const url = new URL(request.url);
  const now = new Date();
  const marketsPromise = listPublicMarkets(env, now);
  // ?theme=<id> previews a season without switching it on for anyone else.
  // Purely decorative, so there is nothing to protect here — and being
  // shareable is the point, it is how you show someone a season before it runs.
  const preview = url.searchParams.get('theme');
  const override = preview || await cachedOverride(env);
  const { theme, source, warning } = resolveTheme(override, now);
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

  const markets = (await marketsPromise).data || [];
  const html = await response.text();
  // JSON inside a script element: `<` must not be able to close it early.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const marketsJson = JSON.stringify(markets).replace(/</g, '\\u003c');
  const tag = '<script>window.__VERRE_THEME__=' + json + ';window.__VERRE_MARKETS__=' + marketsJson + ';</script>';
  const themed = html.includes('</head>')
    ? html.replace('</head>', tag + '</head>')
    : tag + html;

  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  // These describe the file on disk, not the document actually sent. Keeping
  // them lets a browser revalidate a themed page against an undressed one and
  // be told, wrongly, that nothing changed.
  headers.delete('etag');
  headers.delete('last-modified');
  // Nothing is cached on localhost. In production a minute is the right trade;
  // in development it means flipping a season in admin appears to do nothing
  // for up to a minute, which reads as broken.
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  headers.set(
    'cache-control',
    preview || local ? 'no-store' : 'public, max-age=60, must-revalidate'
  );
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
