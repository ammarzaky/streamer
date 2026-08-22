import { defineConfig } from '@playwright/test';

/**
 * Electron E2E, kept in its own config rather than as a project inside playwright.config.js.
 *
 * The browser config declares a `webServer`, and Playwright starts it for every project in the
 * file. The desktop app starts its *own* server, so sharing a config would mean two servers
 * racing for the same port on every desktop run -- an EADDRINUSE that looks like an app bug.
 */
export default defineConfig({
  testDir: './test/desktop',
  outputDir: './test-results/desktop',
  fullyParallel: false,
  workers: 1, // Each test drives a real Electron app that binds a real port.
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: 'test-results/desktop-html', open: 'never' }]],
});
