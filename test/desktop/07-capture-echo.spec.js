import { test, expect } from '@playwright/test';
import { launchApp, homeWindow } from './helpers/launch.js';

test('Windows system sharing requests and applies exclusion of Streamer playback', async () => {
  test.skip(process.platform !== 'win32');
  const app = await launchApp({ port: 8507 });
  try {
    const page = await homeWindow(app);
    await page.getByTestId('host-button').click();
    await page.waitForURL('https://localhost:8507/r/new', { timeout: 45000 });
    await page.getByLabel('Your name').fill('Capture regression');
    await page.getByRole('button', { name: /create room/i }).click();
    await page.waitForURL(/\/r\/[A-Za-z0-9_-]{8,}$/);
    await page.evaluate(() => {
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async (options) => {
        window.captureRequest = options;
        const stream = await original(options);
        window.captureAudioSettings = stream.getAudioTracks()[0]?.getSettings();
        return stream;
      };
    });
    await page.getByTestId('share-toggle').click();
    let picker;
    await expect.poll(() => {
      picker = app.windows().find((w) => w.url().includes('picker.html'));
      return Boolean(picker);
    }).toBe(true);
    await expect(picker.getByTestId('picker-system-audio')).toBeChecked();
    await picker.getByTestId('picker-source').first().click();
    await picker.getByTestId('picker-share').click();
    await expect.poll(() => page.evaluate(() => window.__app.hasDisplayAudio()), { timeout: 30000 }).toBe(true);
    expect(await page.evaluate(() => window.captureRequest.audio)).toEqual({ restrictOwnAudio: true });
    expect(await page.evaluate(() => window.captureAudioSettings.restrictOwnAudio)).toBe(true);
  } finally { await app.close(); }
});
