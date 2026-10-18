import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests run against the BUILT site (spec §4 step 8), not the dev server —
 * a dev-server pass would not prove the production bundle works.
 *
 * Desktop Chromium at 1440×900 and mobile WebKit at 390×844 are the two viewports
 * the spec names for screenshots, which double as deploy evidence (spec §6).
 *
 * The deploy task adds a third project that points at the production URL via
 * PLAYWRIGHT_BASE_URL instead of the local preview server.
 */
const port = 4173
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const usePreviewServer = !process.env.PLAYWRIGHT_BASE_URL

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-webkit',
      use: { ...devices['iPhone 13'] },
    },
  ],
  ...(usePreviewServer
    ? {
        webServer: {
          command: `pnpm preview --port ${port} --strictPort`,
          url: `http://127.0.0.1:${port}`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }
    : {}),
})
