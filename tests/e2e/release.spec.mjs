import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');

test('direct product permalink keeps all storefront assets root-relative', async ({ page }) => {
  const failures = [];
  page.on('response', response => {
    if (response.status() >= 400 && new URL(response.url()).origin === 'http://127.0.0.1:8787') {
      failures.push([response.status(), new URL(response.url()).pathname]);
    }
  });
  const response = await page.goto('/products/peach-sky-glass-panel');
  expect(response.status()).toBe(200);
  await expect(page.locator('script[src="/support.js"]')).toHaveCount(1);
  expect(await page.locator('html').innerHTML()).toContain('/assets/verre-photo-atlas-v1.webp');
  expect(failures.filter(([, path]) => path.startsWith('/products/support') || path.startsWith('/products/assets'))).toEqual([]);
});

test('catalog outage fallback is readable but explicitly stale', async ({ request }) => {
  const response = await request.get('/api/products');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.stale).toBe(true);
  expect(body.products.length).toBeGreaterThan(0);
  expect(body.products.every(product => !product.id)).toBe(true);
});

test('public health is minimal and refuses incomplete launch data', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(503);
  const body = await response.json();
  expect(body.data.ready).toBe(false);
  expect(JSON.stringify(body)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  expect(JSON.stringify(body)).not.toContain('RESEND_API_KEY');
});

test('policy page and admin navigation are real routes', async ({ page }) => {
  await page.goto('/policies/');
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible();
  await page.goto('/admin/');
  await expect(page.locator('.brand')).toHaveAttribute('href', '/admin/#dashboard');
});

test('POS controls expose labels and dialogs stay operator-controlled', async ({ page }) => {
  await page.goto('/pos/');
  await expect(page.getByLabel('Search products')).toBeVisible();
  await expect(page.locator('#queue-dialog')).toHaveAttribute('aria-labelledby', 'queue-title');
  await expect(page.locator('#session-dialog')).toHaveAttribute('aria-labelledby', 'session-title');
  await expect(page.locator('#success')).toHaveAttribute('aria-labelledby', 'success-title');
  const source = await (await page.request.get('/pos/app.js')).text();
  expect(source).not.toContain('setTimeout(nextSale,4000)');
});

test('public policy page has no critical automated accessibility violations', async ({ page }) => {
  await page.goto('/policies/');
  await page.addScriptTag({ path: axePath });
  const results = await page.evaluate(() => axe.run(document, { resultTypes: ['violations'] }));
  expect(results.violations.filter(violation => violation.impact === 'critical')).toEqual([]);
});
