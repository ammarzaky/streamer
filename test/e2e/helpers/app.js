import { expect } from '@playwright/test';

/**
 * Helpers for driving the app from a browser context.
 *
 * Everything here goes through the real UI (clicking real buttons) except assertions on
 * WebRTC internals, which read `window.__app` -- a read-only hook the server injects only
 * under STREAMER_E2E=1. Asserting on getStats beats asserting on pixels: a green video
 * element proves far less than a peer connection reporting advancing frames.
 */

/** Create a room and return its shareable URL. */
export async function createRoom(page, name) {
  await page.goto('/r/new');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: /create room/i }).click();

  // room.html sends create-room on open and replaceStates the real id in.
  await page.waitForURL(/\/r\/[A-Za-z0-9_-]{8,}$/, { timeout: 15_000 });
  await expect(page.getByTestId('participants-count')).toBeVisible();
  return page.url();
}

export async function joinRoom(page, roomUrl, name) {
  await page.goto(roomUrl);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: /join room/i }).click();
  await expect(page.getByTestId('participants-count')).toBeVisible({ timeout: 15_000 });
}

/** Start sharing. Under E2E the picker is replaced by a synthetic 1920x1080@60 canvas. */
export async function share(page) {
  await page.getByTestId('share-toggle').click();
  await expect
    .poll(() => page.evaluate(() => window.__app.share().sharerId === window.__app.selfId()), {
      timeout: 15_000,
      message: 'this page should own the share',
    })
    .toBe(true);
}

export const selfId = (page) => page.evaluate(() => window.__app.selfId());

/** Wait until this page has `count` peer connections in state `connected`. */
export async function waitConnected(page, count, timeout = 30_000) {
  await expect
    .poll(
      () => page.evaluate(() => window.__app.connections().filter((s) => s === 'connected').length),
      { timeout, message: `expected ${count} connected peer connection(s)` },
    )
    .toBe(count);
}

/** Raw getStats reports for one peer connection. */
export const stats = (page, peerId) => page.evaluate((id) => window.__app.stats(id), peerId);

async function findStat(page, peerId, predicate) {
  const reports = await stats(page, peerId);
  return (reports ?? []).find(predicate) ?? null;
}

export const inboundVideo = (page, peerId) =>
  findStat(page, peerId, (s) => s.type === 'inbound-rtp' && s.kind === 'video');

export const outboundVideo = (page, peerId) =>
  findStat(page, peerId, (s) => s.type === 'outbound-rtp' && s.kind === 'video');

/**
 * The candidate pair actually carrying media, resolved to candidate types.
 *
 * `host` on both ends means a direct connection on the same network. Anything reporting
 * `relay` would mean media is going through a TURN server, which this app is built to avoid
 * and which the tests assert never happens.
 */
export async function selectedCandidatePair(page, peerId) {
  const reports = await stats(page, peerId);
  if (!reports) return null;

  const byId = new Map(reports.map((r) => [r.id, r]));
  const transport = reports.find((r) => r.type === 'transport' && r.selectedCandidatePairId);
  const pair =
    (transport && byId.get(transport.selectedCandidatePairId)) ??
    reports.find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');

  if (!pair) return null;
  return {
    local: byId.get(pair.localCandidateId) ?? null,
    remote: byId.get(pair.remoteCandidateId) ?? null,
    pair,
  };
}

/**
 * Assert a peer is receiving real, moving video.
 *
 * Two samples, because a single non-zero byte count proves only that something arrived once.
 * Advancing `framesDecoded` is what distinguishes a live stream from one frozen frame.
 */
export async function assertLiveVideo(page, peerId, { minFrames = 10, windowMs = 3000 } = {}) {
  await expect
    .poll(
      async () => {
        const report = await inboundVideo(page, peerId);
        return report?.framesDecoded ?? 0;
      },
      { timeout: 25_000, message: 'inbound video should start decoding frames' },
    )
    .toBeGreaterThan(0);

  const first = await inboundVideo(page, peerId);
  await page.waitForTimeout(windowMs);
  const second = await inboundVideo(page, peerId);

  expect(second.framesDecoded - first.framesDecoded, 'frames should keep advancing').toBeGreaterThan(
    minFrames,
  );
  expect(second.bytesReceived - first.bytesReceived, 'bytes should keep arriving').toBeGreaterThan(
    1000,
  );
}

/**
 * Whether a sender is still transmitting video.
 *
 * Chrome may drop the outbound-rtp report entirely after replaceTrack(null) rather than
 * freezing its counters, so an absent report means stopped -- subtracting from `undefined`
 * would throw instead of failing cleanly.
 */
export async function videoBytesSent(page, peerId) {
  const report = await outboundVideo(page, peerId);
  return report?.bytesSent ?? null;
}

export async function isStillSendingVideo(page, peerId, windowMs = 2500) {
  const before = await videoBytesSent(page, peerId);
  if (before === null) return false;
  await page.waitForTimeout(windowMs);
  const after = await videoBytesSent(page, peerId);
  if (after === null) return false;
  return after - before > 2000;
}

/**
 * Assert the <video> element is really painting frames.
 *
 * Distinct from assertLiveVideo, which reads getStats: a peer connection can be decoding
 * 1080p perfectly while the stage shows black, because attaching the track to the element is
 * a separate step that can be missed. That exact bug shipped once and every stats-based
 * assertion passed straight through it.
 */
export async function assertVideoElementPlaying(page, testId = 'stage-video') {
  const video = page.getByTestId(testId);
  await expect(video).toBeVisible();

  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          return el?.videoWidth ?? 0;
        }, testId),
      { timeout: 20_000, message: 'the video element should report real dimensions' },
    )
    .toBeGreaterThan(0);

  const readAt = () =>
    page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el?.currentTime ?? 0;
    }, testId);

  const first = await readAt();
  await page.waitForTimeout(1500);
  const second = await readAt();

  expect(second, 'playback position should advance -- a still frame is not a live stream').
    toBeGreaterThan(first);

  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return { width: el.videoWidth, height: el.videoHeight, paused: el.paused };
  }, testId);
}

/**
 * Wait for the delivered resolution to reach `minWidth`.
 *
 * Polled rather than asserted once, because a video encoder legitimately starts small and
 * scales up over several seconds -- a single reading taken during that ramp says nothing
 * about the steady state, and asserting on it would either flake or force the product to
 * promise a resolution floor it deliberately does not.
 */
export async function waitForResolution(page, peerId, minWidth, timeout = 30_000) {
  await expect
    .poll(async () => (await inboundVideo(page, peerId))?.frameWidth ?? 0, {
      timeout,
      message: `inbound video should reach at least ${minWidth}px wide`,
    })
    .toBeGreaterThanOrEqual(minWidth);
}

export const senders = (page, peerId) =>
  page.evaluate((id) => window.__app.senders(id), peerId ?? undefined);

export const shareState = (page) => page.evaluate(() => window.__app.share());

export const encodings = (page, peerId) =>
  page.evaluate((id) => window.__app.encodings(id), peerId ?? undefined);
