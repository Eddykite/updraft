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
// Bind the preview server to 127.0.0.1 explicitly. `vite preview` otherwise listens on
// `localhost`, which on the CI runner resolves to ::1 only — the IPv4 probe below then
// never connects and Playwright times out waiting for a server that is in fact running.
const host = '127.0.0.1'
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://${host}:${port}`
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
      // iPhone 13 gives WebKit plus touch, a mobile UA and DPR 3 (which the
      // viewport's DPR cap of 2 then clamps). Its stock viewport is 390 x 664 —
      // the browser-chrome-inset height. The screenshots are deploy evidence at
      // the device height the spec names, so the viewport is set to 390 x 844.
      use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } },
    },
  ],
  ...(usePreviewServer
    ? {
        webServer: {
          command: `pnpm preview --host ${host} --port ${port} --strictPort`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }
    : {}),
})
