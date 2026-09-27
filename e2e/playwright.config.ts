import { defineConfig } from '@playwright/test';

// Runs against the locally started stack (API :4000, worker, Vite :5173).
// See README "End-to-end check" for how to start it and obtain E2E_SESSION.
export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    timezoneId: process.env.E2E_TIMEZONE ?? 'Asia/Kolkata',
    locale: 'en-US',
    screenshot: 'only-on-failure',
  },
});
