import { test, expect } from '@playwright/test';
import {
  createRoom,
  joinRoom,
  share,
  selfId,
  waitConnected,
  isStillSendingVideo,
  shareState,
  senders,
} from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

test('taking over sharing actually stops the previous sender', async ({ browser }) => {
  // The failure this guards against is silent: flipping ownership server-side does nothing to
  // the RTP already leaving the previous sharer's machine. The roster would show the handover
  // correctly while the old screen kept transmitting, so this asserts on media, not on flags.
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  const roomUrl = await createRoom(a, 'Alice');
  await joinRoom(b, roomUrl, 'Bob');
  await waitConnected(a, 1);

  await share(a);
  const aId = await selfId(a);
  const bId = await selfId(b);

  // A is genuinely transmitting before we take it away.
  expect(await isStillSendingVideo(a, bId), 'A should be sending video first').toBe(true);

  // B claims; the button offers a takeover because someone else owns the share.
  await b.getByTestId('share-toggle').click();
  await expect(b.getByTestId('dialog')).toBeVisible();
  await b.getByTestId('dialog-confirm').click();

  await expect
    .poll(async () => (await shareState(b)).sharerId, {
      timeout: 20_000,
      message: 'B should own the share after taking over',
    })
    .toBe(bId);

  // Everyone agrees, including the peer that lost it.
  await expect.poll(async () => (await shareState(a)).sharerId, { timeout: 10_000 }).toBe(bId);

  // The decisive assertion: A's outbound video has actually stopped.
  expect(
    await isStillSendingVideo(a, bId),
    'the previous sharer must stop transmitting, not merely lose the flag',
  ).toBe(false);

  // A's video sender still exists (the transceiver is reused) but carries no track.
  const aSenders = await senders(a, bId);
  const video = aSenders.find((s) => s.role === 'video');
  expect(video, 'the video transceiver should be reused, not removed').toBeTruthy();
  expect(video.hasTrack).toBe(false);

  void aId;
  await aCtx.close();
  await bCtx.close();
});

test('stopping a share clears it for everyone', async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  const roomUrl = await createRoom(a, 'Alice');
  await joinRoom(b, roomUrl, 'Bob');
  await waitConnected(b, 1);

  await share(a);
  await expect(b.getByTestId('stage-video')).toBeVisible();

  await a.getByTestId('share-toggle').click();

  await expect.poll(async () => (await shareState(b)).sharerId, { timeout: 15_000 }).toBeNull();
  await expect(b.getByTestId('stage-video')).toBeHidden();

  await aCtx.close();
  await bCtx.close();
});
