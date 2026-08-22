import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration.
 *
 * The flags below are the difference between a suite that reliably connects two real peers in
 * about two seconds and one that fails intermittently for reasons that look like application
 * bugs. Each is commented with what breaks without it, because none of them are guessable.
 */

/**
 * Deliberately NOT the app's default 8443.
 *
 * `reuseExistingServer` only checks that something answers on the URL. With the suite on the
 * same port as a running dev server or an installed desktop app, Playwright quietly adopts that
 * process -- which serves a different copy of public/ and was never started with STREAMER_E2E,
 * so window.__app is missing and every test fails inside a helper with "cannot read properties
 * of undefined". The cause is invisible from the failure, and it costs an hour every time.
 * A distinct default removes the whole class.
 */
const PORT = Number(process.env.STREAMER_TEST_PORT ?? 8444);
// The plain-HTTP redirect listener needs its own port, and it must be overridable separately:
// otherwise running the suite while a dev server is up fails with EADDRINUSE on 8080 alone,
// even though STREAMER_TEST_PORT moved the HTTPS port out of the way.
const HTTP_PORT = Number(process.env.STREAMER_TEST_HTTP_PORT ?? 8081);
const BASE_URL = `https://localhost:${PORT}`;

/** Flags shared by every browser project. */
const WEBRTC_FLAGS = [
  // Synthetic camera and microphone. Note the spelling: the commonly cited
  // `--use-fake-device-for-media-capture` is not a real flag and is silently ignored,
  // after which getUserMedia fails on any machine without a physical microphone.
  '--use-fake-device-for-media-stream',

  // Auto-accepts the getUserMedia permission prompt. It does NOT cover getDisplayMedia,
  // which is a separate picker -- see the capture tiers in the README of test/e2e.
  '--use-fake-ui-for-media-stream',

  // Without this, Chrome hides host candidates behind *.local mDNS names. Two browser
  // contexts on one Windows box frequently cannot resolve each other's mDNS names, so ICE
  // either stalls for ten seconds or never completes. This single flag is the most common
  // cause of "flaky" WebRTC suites.
  '--disable-features=WebRtcHideLocalIpsWithMdns',

  // Remote <video> and unmuted audio must start without a user gesture.
  '--autoplay-policy=no-user-gesture-required',
];

export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test-results/artifacts',
  fullyParallel: false, // Every test drives multiple browser contexts and real encoders.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0, // A retry here hides a real race; fix the test instead.
  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: [['list'], ['html', { outputFolder: 'test-results/html', open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    // The server presents a certificate from our own local CA, which the test browser has
    // no reason to trust. Cleaner than --ignore-certificate-errors, which also adds a
    // headed infobar that can shift the page layout.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },

  projects: [
    {
      // Default project. Screen capture is a synthetic canvas stream installed behind the
      // E2E flag; everything downstream of it -- encoder, RTP, DTLS-SRTP, ICE, jitter
      // buffer, decoder, <video> -- is the real implementation. Only the OS picker is
      // skipped, and that is UX, not WebRTC.
      name: 'e2e',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium', // Full Chromium, not chrome-headless-shell, which lacks WebRTC bits.
        launchOptions: {
          args: [
            ...WEBRTC_FLAGS,
            // Auto-approves getDisplayMedia({preferCurrentTab:true}), which is the only
            // dependable way to exercise the real capture API headlessly.
            '--auto-accept-this-tab-capture',
          ],
        },
      },
    },
    {
      // Run on demand: `npm run test:e2e:headed`. Goes through the real desktop picker, so
      // it needs an interactive session and is sensitive to the OS display language.
      name: 'e2e-headed',
      testMatch: /.*\.headed\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        headless: false,
        launchOptions: {
          args: [
            ...WEBRTC_FLAGS,
            '--auto-select-desktop-capture-source=Entire screen',
            '--enable-usermedia-screen-capturing',
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'node src/index.js',
    url: BASE_URL,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      STREAMER_PORT: String(PORT),
      STREAMER_HTTP_PORT: String(HTTP_PORT),
      // Installs window.__E2E__ so the client swaps in the synthetic capture stream and
      // exposes the read-only window.__app test hook.
      STREAMER_E2E: '1',
      STREAMER_LOG_LEVEL: 'warn',
    },
  },
});
