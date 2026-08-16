import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, selfId, waitConnected, senders } from './helpers/app.js';

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
