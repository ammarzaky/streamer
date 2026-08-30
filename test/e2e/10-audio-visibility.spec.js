import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, selfId, waitConnected } from './helpers/app.js';
import { LOBBY, resolve } from '../../public/js/ui/audio-strings.js';

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

/**
 * getUserMedia that hands back a LIVE, ENABLED, silent audio track: a MediaStreamDestination
 * with nothing wired into it. This is what a headset with its hardware mute engaged, or
 * Windows routing input from a device nobody is speaking into, looks like to the browser --
 * the track is healthy by every flag, the encoder produces a normal bitrate, and no sound
 * is in it. The only honest signal is the audio energy, which is what these tests check for.
 */
const silentMicInitScript = () => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.audio) return original(constraints);
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    // Keep a reference so the graph is not collected while the track is in use.
    window.__silentAudioCtx = ctx;
    return dest.stream;
  };
};

test('the room shows a level bar without fullscreen, amber while muted, green and moving after unmute', async ({
  browser,
}) => {
  // The meter used to live only in the fullscreen overlay, so the one moment you would want it
  // -- deciding whether the mute button is telling the truth -- it was not on screen. The
  // control-bar bar is fed a clone of the track that stays enabled while muted, so amber and
  // moving means "you are talking and nobody can hear you", which is the point of it.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await createRoom(page, 'Host');

  const meter = page.getByTestId('room-meter');
  await expect(meter).toBeVisible();
  await expect(page.getByTestId('stage-overlay'), 'no fullscreen involved').toBeHidden();

  const width = () => meter.evaluate((el) => parseFloat(el.style.width) || 0);

  await expect(meter).toHaveClass(/meter__fill--muted/, { timeout: 15_000 });
  await expect
    .poll(width, { timeout: 15_000, message: 'the bar must move while muted -- the fake device is a tone' })
    .toBeGreaterThan(0);
  await expect(meter).not.toHaveClass(/meter__fill--dead/);

  await page.getByTestId('mic-toggle').click();
  await expect(page.getByTestId('mic-toggle')).toHaveAttribute('data-mic-muted', 'false');

  await expect(meter).not.toHaveClass(/meter__fill--muted/, { timeout: 10_000 });
  await expect
    .poll(width, { timeout: 15_000, message: 'the bar should keep moving once unmuted' })
    .toBeGreaterThan(0);

  await ctx.close();
});

test('a microphone that delivers silence is reported as SILENT, not as a bitrate', async ({ browser }) => {
  // The gap three reports of "he can't hear me" fell through: a mic delivering digital silence
  // produces exactly the bitrate a working one does. A number in the stats panel looked like
  // proof that everything was fine. The verdict must come from the sound the encoder was given.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  await host.addInitScript(silentMicInitScript);

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  await host.getByTestId('mic-toggle').click();
  await expect(host.getByTestId('mic-toggle')).toHaveAttribute('data-mic-muted', 'false');

  await host.getByTestId('stats-toggle').click();
  const micRow = host.getByTestId('stat-mic-send');
  await expect(micRow).toBeVisible();

  await expect(micRow).toHaveText(/SILENT/, { timeout: 25_000 });
  await expect(micRow, 'silence must never be dressed up as speech').not.toHaveText(/speech detected/i);
  await expect(micRow, 'the sender exists; this is not a missing track').not.toHaveText(/not being sent/i);

  // The health verdict needs ~8 s of unmuted silence before it commits, so give it time.
  // Either surface is acceptable: the banner carries the long explanation, the hint under the
  // mic button the short one.
  await expect
    .poll(
      async () => {
        const banner = (await host.getByTestId('room-banner').textContent().catch(() => '')) ?? '';
        const hint = (await host.getByTestId('mic-hint').textContent().catch(() => '')) ?? '';
        return `${banner}\n${hint}`;
      },
      { timeout: 25_000, message: 'the app should say out loud that the microphone is silent' },
    )
    .toMatch(/delivering silence|no sound/i);

  await expect(host.getByTestId('mic-hint')).toHaveAttribute('data-severity', /warn|danger/);

  await hostCtx.close();
  await guestCtx.close();
});

test('with a working microphone the stats panel says speech is detected after unmute', async ({ browser }) => {
  // The positive half of the previous test: a working device must not be flagged silent, and
  // the row must say WHY it believes you -- the level it measured -- not just a bitrate.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  await host.getByTestId('stats-toggle').click();
  const micRow = host.getByTestId('stat-mic-send');
  await expect(micRow).toHaveText(/muted, sending silence/i, { timeout: 20_000 });

  await host.getByTestId('mic-toggle').click();
  await expect(micRow).toHaveText(/speech detected · level/i, { timeout: 25_000 });
  await expect(micRow).not.toHaveText(/SILENT/);

  // Nothing about a healthy microphone should trigger a warning.
  await expect(host.getByTestId('mic-hint')).not.toHaveAttribute('data-severity', /warn|danger/);

  await hostCtx.close();
  await guestCtx.close();
});

test('six seconds of nothing in the lobby names the Windows mute key, and Create stays enabled', async ({
  browser,
}) => {
  // The fallback for a capture that delivers nothing with `muted: false`: getUserMedia
  // succeeds, the track is live, no event ever fires, and every sample is zero (measured: an
  // APO or hardware-gated mute reads one LSB, the same as a quiet room). The Windows endpoint
  // mute itself is visible as `track.muted` and is named at once (see 13-mic-devices); for this
  // signature the most the page can say is "nothing for six seconds" -- and it must still name
  // the usual cause first rather than sending people device-hunting.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.addInitScript(silentMicInitScript);

  await page.goto('/r/new');
  const status = page.getByTestId('lobby-mic-status');

  // First the ordinary "say something" line, naming the device the browser opened.
  await expect(status).toHaveText(/microphone is on/i, { timeout: 20_000 });
  const label = ((await status.textContent()) ?? '').match(/"([^"]+)"/)?.[1] ?? '';

  // Then, within the six-second budget plus slack, the escalation -- both languages, rendered
  // from the same constant the app uses, so the copy and the test cannot drift apart.
  const copy = resolve(LOBBY.silentDevice, { label });
  await expect(status).toContainText(copy.en, { timeout: 10_000 });
  await expect(status).toContainText(copy.ar);
  await expect(status, 'a silent device is a warning').toHaveClass(/field__hint--warn/);
  await expect(status).not.toHaveClass(/field__hint--danger/);
  // The class alone is not the escalation: the English span carries its own colour, and the
  // amber has to reach both halves of the line, not just the Arabic one.
  const colours = await status.evaluate((p) => ({
    line: getComputedStyle(p).color,
    en: getComputedStyle(p.querySelector('.diag__en')).color,
    ar: getComputedStyle(p.querySelector('.diag__ar')).color,
  }));
  expect(colours.en, 'the English half takes the warning colour').toBe(colours.line);
  expect(colours.ar, 'the Arabic half takes the warning colour').toBe(colours.line);

  // A silent microphone is a warning, not a wall: you can still watch and share.
  await expect(page.getByRole('button', { name: /create room/i })).toBeEnabled();
  await expect(page.getByTestId('lobby-meter'), 'the device is open, not dead').not.toHaveClass(/meter__fill--dead/);

  await ctx.close();
});
