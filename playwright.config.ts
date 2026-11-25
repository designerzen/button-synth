import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90000,
  use: { baseURL: 'http://127.0.0.1:5196', headless: true },
  webServer: { command: 'pnpm dev --port 5196 --strictPort', url: 'http://127.0.0.1:5196', reuseExistingServer: false, timeout: 30000 },
});
