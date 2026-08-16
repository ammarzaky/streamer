import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, selfId, waitConnected, senders, stats } from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

test('mute state propagates to the other peer', async ({ browser }) => {
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  const hostId = await selfId(host);
  const guestId = await selfId(guest);

  // Everyone arrives muted: being live before you have said anything is a small privacy
  // failure that people notice.
  await expect
    .poll(() => host.evaluate(() => window.__app.micMuted()), { timeout: 10_000 })
    .toBe(true);

  await expect
    .poll(
      async () =>
        (await guest.getByTestId(`participant-${hostId}`).getAttribute('data-mic-muted')) === 'true',
      { timeout: 10_000, message: "the host should appear muted on the guest's roster" },
    )
    .toBe(true);

  // Unmute the guest and watch it reach the host.
  await guest.getByTestId('mic-toggle').click();
  expect(await guest.evaluate(() => window.__app.micMuted())).toBe(false);

  await expect
    .poll(
      async () =>
        (await host.getByTestId(`participant-${guestId}`).getAttribute('data-mic-muted')) === 'false',
      { timeout: 10_000, message: 'unmuting should propagate to the other peer' },
    )
    .toBe(true);

  // Mute again, and confirm the mechanism: the track is DISABLED, not stopped. Stopping it
  // would make unmute impossible without renegotiating, and the remote cannot observe either
  // -- which is exactly why the mute-state message exists.
  await guest.getByTestId('mic-toggle').click();

  expect(await guest.evaluate(() => window.__app.micTrackEnabled())).toBe(false);

  const guestSenders = await senders(guest);
  const mic = guestSenders.find((s) => s.role === 'mic');
  expect(mic, 'the mic sender should still exist while muted').toBeTruthy();
  expect(mic.hasTrack, 'muting must not remove the track').toBe(true);
  expect(mic.trackEnabled).toBe(false);

  await expect
    .poll(
      async () =>
        (await host.getByTestId(`participant-${guestId}`).getAttribute('data-mic-muted')) === 'true',
      { timeout: 10_000 },
    )
    .toBe(true);

  await hostCtx.close();
  await guestCtx.close();
});

test("the joiner's microphone actually reaches the other peer", async ({ browser }) => {
  // The regression this exists for is invisible from the UI. The joining side is the ANSWERER,
  // so its transceivers do not exist until the remote offer arrives -- while getUserMedia
  // resolves on its own schedule. If the track is attached first and the attempt is not
  // retried, the connection reports connected, the track is live and enabled, the roster shows
  // the person unmuted, and nobody can hear them.
  //
  // Worse, the winner is a race between local media and a network round trip: it passes on a
  // LAN and fails more reliably the further apart the participants are. So this asserts on
  // audio actually arriving rather than on any flag.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  const guestId = await selfId(guest);
  const hostId = await selfId(host);

  // The joiner's mic sender must carry a track at all.
  const guestSenders = await senders(guest, hostId);
  const guestMic = guestSenders.find((s) => s.role === 'mic');
  expect(guestMic, 'the joiner should have a mic sender').toBeTruthy();
  expect(
    guestMic.hasTrack,
    'the joining peer must have its microphone attached, whichever won the race with the offer',
  ).toBe(true);

  await guest.getByTestId('mic-toggle').click(); // unmute so real samples flow

  // And the audio genuinely arrives at the far end.
  const inboundAudioBytes = async () => {
    const reports = await stats(host, guestId);
    const audio = (reports ?? []).find((r) => r.type === 'inbound-rtp' && r.kind === 'audio');
    return audio?.bytesReceived ?? 0;
  };

  await expect
    .poll(inboundAudioBytes, {
      timeout: 20_000,
      message: "the host should receive audio from the joiner",
    })
    .toBeGreaterThan(0);

  const before = await inboundAudioBytes();
  await host.waitForTimeout(2500);
  const after = await inboundAudioBytes();
  expect(after - before, 'audio should keep flowing, not arrive once and stop').toBeGreaterThan(500);

  await hostCtx.close();
  await guestCtx.close();
});
