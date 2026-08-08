import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8787',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ],
  webServer: {
    command: 'npm run build && npx wrangler dev --port 8787 --var LOCAL_AUTH_BYPASS:true --var SUPER_ADMIN_EMAILS:local@verre.test --var SUPABASE_URL:http://127.0.0.1:9 --var SUPABASE_SERVICE_ROLE_KEY:test',
    url: 'http://127.0.0.1:8787/api/products',
    reuseExistingServer: true,
    timeout: 120000
  }
});
