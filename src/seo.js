const HOME_TITLE = 'Verre — Handmade Glass Paintings, Charms & Stickers | Cebu City';
const HOME_DESCRIPTION = 'Shop small-batch hand-painted glass, beaded charms and illustrated stickers, handmade by Verre in Cebu City, Philippines.';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const escapeXml = escapeHtml;

export function siteOrigin(request, env = {}) {
  const fallback = new URL(request.url).origin;
  const configured = String(env.PUBLIC_SITE_URL || '').trim();
  if (!configured) return fallback;
  try {
    const url = new URL(configured);
    return /^https?:$/.test(url.protocol) ? url.origin : fallback;
  } catch {
    return fallback;
  }
}

export const productPath = (slug) => '/products/' + encodeURIComponent(slug);

const absoluteUrl = (origin, path) => {
  if (!path) return null;
  try { return new URL(path, origin).href; } catch { return null; }
};

const productDescription = (product) =>
  product.description || product.blurb || `${product.name}, handmade in Cebu City by Verre.`;

const availability = (product) => {
  if (product.status !== 'active') return 'https://schema.org/Discontinued';
  return Number(product.stock_on_hand) > 0
    ? 'https://schema.org/InStock'
    : 'https://schema.org/OutOfStock';
};

function structuredData(origin, product) {
  if (!product) {
    return {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          '@id': origin + '/#organization',
          name: 'Verre',
          url: origin + '/',
          logo: {
            '@type': 'ImageObject',
            url: origin + '/icon-512.png',
            width: 512,
            height: 512
          },
          description: HOME_DESCRIPTION,
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'Cebu City',
            addressCountry: 'PH'
          }
        },
        {
          '@type': 'WebSite',
          '@id': origin + '/#website',
          name: 'Verre',
          url: origin + '/',
          publisher: { '@id': origin + '/#organization' },
          inLanguage: 'en-PH'
        }
      ]
    };
  }

  const url = origin + productPath(product.slug);
  const images = (product.images || [])
    .map((image) => absoluteUrl(origin, image.url))
    .filter(Boolean);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': url + '#product',
    name: product.name,
    description: productDescription(product),
    ...(images.length ? { image: images } : {}),
    ...(product.id ? { sku: product.id } : {}),
    category: product.category,
    brand: { '@type': 'Brand', name: 'Verre' },
    url,
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'PHP',
      price: (Number(product.price_cents || 0) / 100).toFixed(2),
      availability: availability(product),
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: 'Verre' }
    }
  };
}

export function injectSeo(html, request, env = {}, options = {}) {
  const origin = siteOrigin(request, env);
  const product = options.product || null;
  const title = product ? `${product.name} | Handmade by Verre` : HOME_TITLE;
  const description = product ? productDescription(product) : HOME_DESCRIPTION;
  const canonical = product ? origin + productPath(product.slug) : origin + '/';
  const productImage = product && product.images && product.images[0]
    ? absoluteUrl(origin, product.images[0].url)
    : null;
  const shareImage = productImage || origin + '/assets/verre-social-card-v1.webp';
  const robots = options.noindex || (product && product.status !== 'active')
    ? 'noindex,follow'
    : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1';
  const verification = String(env.GOOGLE_SITE_VERIFICATION || '').trim();
  const json = JSON.stringify(structuredData(origin, product)).replace(/</g, '\\u003c');

  let document = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  const descriptionTag = `<meta name="description" content="${escapeHtml(description)}">`;
  if (/<meta\s+name=["']description["'][^>]*>/i.test(document)) {
    document = document.replace(/<meta\s+name=["']description["'][^>]*>/i, descriptionTag);
  } else {
    document = document.replace('</head>', descriptionTag + '</head>');
  }

  const tags = [
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta name="robots" content="${robots}">`,
    `<meta property="og:locale" content="en_PH">`,
    `<meta property="og:site_name" content="Verre">`,
    `<meta property="og:type" content="${product ? 'product' : 'website'}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    `<meta property="og:image" content="${escapeHtml(shareImage)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(shareImage)}">`,
    ...(verification ? [`<meta name="google-site-verification" content="${escapeHtml(verification)}">`] : []),
    `<script type="application/ld+json">${json}</script>`
  ].join('');

  return document.includes('</head>') ? document.replace('</head>', tags + '</head>') : tags + document;
}

// Keep every public hostname on one HTTPS origin. Canonical tags tell search
// engines which URL we prefer; a permanent redirect makes browsers, links and
// crawlers use it consistently in the first place.
export function canonicalRedirect(request, env = {}) {
  const current = new URL(request.url);
  if (['localhost', '127.0.0.1'].includes(current.hostname)) return null;
  const configured = String(env.PUBLIC_SITE_URL || '').trim();
  if (!configured) return null;
  try {
    const canonical = new URL(configured);
    if (canonical.protocol !== 'https:' || canonical.origin === current.origin) return null;
    canonical.pathname = current.pathname;
    canonical.search = current.search;
    canonical.hash = '';
    return Response.redirect(canonical, 308);
  } catch {
    return null;
  }
}

export function robotsText(request, env = {}) {
  const requestUrl = new URL(request.url);
  const origin = siteOrigin(request, env);
  const duplicateOrigin = origin !== requestUrl.origin || requestUrl.hostname.endsWith('.workers.dev');
  if (duplicateOrigin) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /pos',
    'Disallow: /login',
    'Disallow: /api/',
    'Disallow: /order/',
    'Disallow: /r/',
    '',
    'Sitemap: ' + origin + '/sitemap.xml',
    ''
  ].join('\n');
}

const validDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
};

export function sitemapXml(request, env, products) {
  const origin = siteOrigin(request, env);
  const entry = (loc, lastmod, images = []) => {
    const imageTags = images.map((image) => {
      const imageUrl = absoluteUrl(origin, image.url);
      if (!imageUrl) return '';
      return `<image:image><image:loc>${escapeXml(imageUrl)}</image:loc>` +
        (image.alt ? `<image:caption>${escapeXml(image.alt)}</image:caption>` : '') +
        '</image:image>';
    }).join('');
    return '<url><loc>' + escapeXml(loc) + '</loc>' +
      (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') + imageTags + '</url>';
  };
  const urls = [entry(origin + '/', null)];
  for (const product of products || []) {
    if (!product || product.status !== 'active' || !product.slug) continue;
    urls.push(entry(
      origin + productPath(product.slug),
      validDate(product.updated_at),
      product.images || []
    ));
  }
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
    'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">' +
    urls.join('') + '</urlset>';
}
