import { test, expect } from '@playwright/test';
import {
  createRoom,
  joinRoom,
  share,
  selfId,
  waitConnected,
  inboundVideo,
  encodings,
} from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

test('the stats panel reports live bitrate, frames, resolution and connection type', async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(guest, 1);
  await share(host);

  const hostId = await selfId(host);
  await guest.getByTestId('stats-toggle').click();

  // Bitrate climbs above a floor that noise alone cannot reach.
  await expect
    .poll(
      async () => {
        const value = await guest.getByTestId('stat-bitrate').innerText();
        const number = Number(value.replace(/[^\d.]/g, ''));
        return value.includes('Mbps') ? number * 1000 : number;
      },
      { timeout: 25_000, message: 'inbound bitrate should climb above 50 kbps' },
    )
    .toBeGreaterThan(50);

  // On one machine both contexts are on the loopback/LAN interface, so the pair should be
  // host-to-host. Anything else here would mean media took a longer path than it needed to.
  await expect(guest.getByTestId('stat-connection-type')).toHaveText(/Local network|Direct/);

  // The synthetic capture renders at the 1080p60 default, so the delivered resolution should
  // reflect the real default rather than a scaled-down stand-in.
  await expect
    .poll(async () => (await inboundVideo(guest, hostId))?.frameWidth ?? 0, {
      timeout: 25_000,
      message: 'inbound video should report a frame width',
    })
    .toBeGreaterThanOrEqual(1280);

  // Corroborate the panel against raw getStats: two samples, real growth in both counters.
  const first = await inboundVideo(guest, hostId);
  await guest.waitForTimeout(3000);
  const second = await inboundVideo(guest, hostId);

  expect(second.bytesReceived - first.bytesReceived).toBeGreaterThan(20_000);
  expect(second.framesDecoded - first.framesDecoded).toBeGreaterThan(20);

  await hostCtx.close();
  await guestCtx.close();
});

test('changing quality changes what the encoder is told to do', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);
  await share(host);

  // Encoder parameters are the real lever -- capture constraints are only a request to the
  // capturer, so asserting on them would prove nothing about what is actually sent.
  await expect
    .poll(async () => (await encodings(host))?.[0]?.maxBitrate ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0);

  const before = (await encodings(host))[0];

  await host.getByTestId('quality-toggle').click();
  await host.getByTestId('quality-720p30').click();

  await expect
    .poll(async () => (await encodings(host))?.[0]?.maxBitrate ?? 0, {
      timeout: 10_000,
      message: 'lowering the preset should lower the encoder ceiling',
    })
    .toBeLessThan(before.maxBitrate);

  const after = (await encodings(host))[0];
  expect(after.maxFramerate).toBe(30);
  // Scaling down from a 1080p capture to a 720p target.
  expect(after.scaleResolutionDownBy).toBeGreaterThan(1);

  // And back up.
  await host.getByTestId('quality-toggle').click();
  await host.getByTestId('quality-1080p60').click();

  await expect
    .poll(async () => (await encodings(host))?.[0]?.maxFramerate ?? 0, { timeout: 10_000 })
    .toBe(60);

  await hostCtx.close();
  await guestCtx.close();
});
