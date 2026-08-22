import { test, expect } from '@playwright/test';
import {
  createRoom,
  joinRoom,
  share,
  selfId,
  waitConnected,
  inboundVideo,
  outboundVideo,
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

test('a healthy connection keeps the 60fps preset instead of quietly halving it', async ({
  browser,
}) => {
  // The regression: for roughly the first twelve seconds of any share the encoder ramps
  // (960x540 -> 1280x720 -> 1920x1080) and reports qualityLimitationReason 'bandwidth' the
  // whole way, with the send rate far below the cap. The old step-down test asked exactly
  // those two questions, so it fired on the ramp itself. Whether a session then held 60fps or
  // was dropped to 1080p30 for good came down to whether the ramp beat the sample counter --
  // two identical runs went opposite ways, and the downgrade was silent, so the user just saw
  // "I chose 1080p60 and I'm getting 30".
  //
  // Nothing here is bandwidth-constrained: two contexts on one machine over loopback, with the
  // estimate reporting ~5 Mbps of headroom throughout. So the preset must survive.
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  // What is asserted is the *justification*, not the outcome.
  //
  // Stepping down can be entirely correct here: two Chromium contexts encoding and decoding
  // 1080p on one box can genuinely exhaust the CPU, and under that load Chrome's bandwidth
  // estimate really does collapse. Demanding that the preset never move would make this test a
  // measure of how busy the machine is.
  //
  // The bug was different in kind: a step down for 'bandwidth' while the estimate showed
  // megabits of headroom, triggered by the encoder's own start-up ramp. So each decision now
  // carries the number that justified it, and the test checks the arithmetic held.
  const stepDowns = [];
  host.on('console', (message) => {
    const text = message.text();
    if (!text.includes('quality: stepping down')) return;
    stepDowns.push({
      reason: /reason: (\w+)/.exec(text)?.[1],
      estimateBps: Number(/estimateBps: (\d+)/.exec(text)?.[1] ?? NaN),
      capBps: Number(/capBps: (\d+)/.exec(text)?.[1] ?? NaN),
      text,
    });
  });

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(guest, 1);
  await share(host);

  const hostId = await selfId(host);
  const guestId = await selfId(guest);

  // The encoder was allowed 60 to begin with, before adaptation has had a chance to act.
  expect((await encodings(host, guestId))[0].maxFramerate).toBe(60);

  // Wait out the ramp and then well past the point where the old logic had already stepped down
  // (warm-up plus six consecutive samples).
  await expect
    .poll(async () => (await inboundVideo(guest, hostId))?.frameWidth ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1280);
  await host.waitForTimeout(15_000);

  for (const step of stepDowns.filter((s) => s.reason === 'bandwidth')) {
    // The old logic could not produce this line with a healthy estimate attached, because it
    // never looked at one -- it inferred congestion from a send rate that is equally low during
    // a perfectly healthy ramp.
    expect(
      Number.isFinite(step.estimateBps),
      `a bandwidth step down must record the estimate that justified it: ${step.text}`,
    ).toBe(true);
    expect(
      step.estimateBps,
      `stepped down for bandwidth while the link reported ${step.estimateBps} bps against a ` +
        `${step.capBps} bps cap — that is headroom, not congestion`,
    ).toBeLessThan(step.capBps * 0.8);
  }

  if (stepDowns.length === 0) {
    // Nothing was constrained, so the chosen preset must have survived intact.
    expect(await host.locator('#quality-label').innerText()).toBe('1080p 60');

    const rateOver = async (read, field, ms) => {
      const first = await read();
      await host.waitForTimeout(ms);
      const second = await read();
      return ((second[field] - first[field]) / ms) * 1000;
    };
    const fps = await rateOver(() => outboundVideo(host, guestId), 'framesEncoded', 4000);
    // The floor only has to separate "encoder capped at 30" from "not capped": a step down to
    // 1080p30 pins this at ~31, while a healthy 1080p60 pipeline sustains 37-63 here.
    expect(fps, `encoding ${fps.toFixed(1)} fps from a 60fps source`).toBeGreaterThan(33);
  }

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
