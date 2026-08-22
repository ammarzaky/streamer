import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, selfId, waitConnected } from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

/**
 * The question this file exists to make answerable: "can he hear me?"
 *
 * A real call was lost to it. The app captured the microphone, held it open, showed the mute
 * button flipping between Mute and Unmute, and streamed video the whole time — while nothing
 * anywhere could say whether a single audio packet was leaving the machine. The outbound audio
 * counter was even being computed and then discarded before it reached the UI.
 */

test('the stats panel says whether your microphone is actually being sent', async ({ browser }) => {
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  const guestId = await selfId(guest);
  await host.getByTestId('stats-toggle').click();

  const micRow = host.getByTestId('stat-mic-send');
  await expect(micRow).toBeVisible();

  // Muted on arrival. The sender exists and is sending silence -- muting is track.enabled =
  // false, which keeps the RTP session up on purpose -- so this reads as a real bitrate that is
  // explicitly labelled muted, never as 'not being sent'.
  await expect(micRow).toHaveText(/muted, sending silence/i, { timeout: 20_000 });
  await expect(micRow, 'a muted mic is attached, not missing').not.toHaveText(/not being sent/i);

  // Unmute, and real audio from the fake device starts flowing.
  await host.getByTestId('mic-toggle').click();
  await expect(micRow).toHaveText(/kbps|Mbps/i, {
    timeout: 25_000,
  });

  // And the receiving end can confirm it independently, rather than the two of you guessing.
  await guest.getByTestId('stats-toggle').click();
  await expect(guest.getByTestId('stat-audio-recv')).toHaveText(/kbps|Mbps/i, { timeout: 25_000 });

  expect(guestId).toBeTruthy();
  await hostCtx.close();
  await guestCtx.close();
});

test('the lobby checks the microphone before anyone is waiting on you', async ({ browser }) => {
  // The five-second version of last night's debugging session, moved to the one moment a dead
  // or blocked microphone can still be fixed privately.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();

  await page.goto('/r/new');

  await expect(page.getByTestId('lobby-mic-check')).toBeVisible();
  await expect(page.getByTestId('lobby-mic-status')).toHaveText(/microphone is/i, {
    timeout: 20_000,
  });

  // The fake device produces a tone, so the bar should leave zero on its own.
  await expect
    .poll(
      () => page.getByTestId('lobby-meter').evaluate((el) => parseFloat(el.style.width) || 0),
      { timeout: 20_000, message: 'the level meter should respond to the microphone' },
    )
    .toBeGreaterThan(0);

  await ctx.close();
});

test('fullscreen expands the stage, not the bare video element', async ({ browser }) => {
  // Fullscreening the <video> itself would drop the sharer label and the overlay controls,
  // leaving no way to mute or exit without a shortcut nobody has been told about.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await createRoom(page, 'Host');

  await expect(page.getByTestId('fullscreen-toggle')).toBeVisible();
  await page.getByTestId('fullscreen-toggle').click();

  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null), { timeout: 10_000 })
    .toBe('stage');

  // The overlay is what makes fullscreen usable, so it must actually be there.
  await expect(page.getByTestId('stage-overlay')).toBeVisible();
  await expect(page.getByTestId('overlay-mic')).toBeVisible();

  // And leaving works from inside it.
  await page.getByTestId('overlay-exit').click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null), { timeout: 10_000 })
    .toBe(null);

  await ctx.close();
});

test('the mute button never claims you are live when there is no microphone', async ({ browser }) => {
  // The exact lie this fixes: with no track, setMicMuted(false) is a no-op, but the button used
  // to flip to "Mute" and the roster showed you unmuted to everyone else. Both ends were told
  // something that was not true, and neither screen could reveal it.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  // Deny the microphone outright for the guest, before any script runs.
  await guest.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => {
      const err = new Error('denied by test');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    };
  });

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  const guestId = await selfId(guest);

  await guest.getByTestId('mic-toggle').click();

  // It stays muted, and says so on both screens.
  await expect(guest.getByTestId('mic-toggle')).toHaveAttribute('data-mic-muted', 'true');
  await expect
    .poll(
      () => host.getByTestId(`participant-${guestId}`).getAttribute('data-mic-muted'),
      { timeout: 15_000, message: 'a peer with no microphone must never appear unmuted' },
    )
    .toBe('true');

  await hostCtx.close();
  await guestCtx.close();
});
