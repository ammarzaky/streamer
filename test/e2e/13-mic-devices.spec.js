import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, selfId, waitConnected, senders } from './helpers/app.js';
import { LOBBY, AUDIO_HINT, resolve } from '../../public/js/ui/audio-strings.js';

test.describe.configure({ mode: 'serial' });

/**
 * Microphone devices and the lobby-to-room handoff.
 *
 * The room lets a person choose a microphone and flip its processing flags, and the lobby
 * checks the device before anyone is waiting. What can go wrong is quiet: the room opening a
 * SECOND copy of the microphone (the OS indicator never clears), a device switch renegotiating
 * the whole connection instead of swapping the sender track, or the lobby proving one device
 * works and the room silently opening another. None of that is visible on screen, so these
 * tests read the track ids, the sender mids and the signaling state.
 */

/** Counts getUserMedia calls and keeps every stream it returned, so a test can reach the
 *  live track the app never exposes. Installed before any page script runs. */
const GUM_COUNTER = `
  window.__gumCalls = 0;
  window.__gumStreams = [];
  const md = navigator.mediaDevices;
  const original = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints) => {
    window.__gumCalls += 1;
    const stream = await original(constraints);
    window.__gumStreams.push(stream);
    return stream;
  };
`;

/**
 * getUserMedia whose audio track reports `muted: true`, which is what Chromium does for a
 * capture endpoint muted in Windows (measured on a real device: true from the first tick when
 * acquired muted, `mute`/`unmute` events within a second otherwise). The fake device keeps
 * delivering its tone underneath, exactly as the meter's clone does on the real thing, so the
 * verdict must come from the flag and not from the level. The track is exposed so a test can
 * flip the flag back and fire `unmute`, which is what Chromium does when the key is released.
 */
const OS_MUTED_MIC = `
  const md = navigator.mediaDevices;
  const original = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints) => {
    const stream = await original(constraints);
    const track = stream.getAudioTracks()[0];
    if (track) {
      Object.defineProperty(track, 'muted', { value: true, configurable: true, writable: true });
      window.__probeTrack = track;
    }
    return stream;
  };
`;

/**
 * OS_MUTED_MIC with every acquisition labelled as a different device. The fake device has one
 * label, so this is the only way to stage "picked another microphone, and that one is muted in
 * Windows too": the same verdict for a different device.
 */
const OS_MUTED_MIC_NUMBERED = `
  const md = navigator.mediaDevices;
  const original = md.getUserMedia.bind(md);
  let n = 0;
  md.getUserMedia = async (constraints) => {
    const stream = await original(constraints);
    const track = stream.getAudioTracks()[0];
    if (track) {
      n += 1;
      Object.defineProperty(track, 'muted', { value: true, configurable: true, writable: true });
      Object.defineProperty(track, 'label', { value: track.label + ' (mic ' + n + ')', configurable: true });
    }
    return stream;
  };
`;

/** Release the Windows mic-mute key, as Chromium reports it: the flag flips and `unmute` fires. */
const releaseOsMute = (page) =>
  page.evaluate(() => {
    const track = window.__probeTrack;
    track.muted = false;
    track.dispatchEvent(new Event('unmute'));
  });

const meterWidth = (page, testId) =>
  page.getByTestId(testId).evaluate((el) => parseFloat(el.style.width) || 0);

async function expectMeterMoving(page, testId = 'room-meter') {
  // The bar is repainted per frame, so two samples both above zero are what "moving" means.
  await expect
    .poll(() => meterWidth(page, testId), { timeout: 15_000, message: `${testId} should leave zero` })
    .toBeGreaterThan(0);
}

test('the lobby lists microphones and remembers the choice into the room', async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();

  await page.goto('/r/new');

  // The device list only appears once a capture has been granted: before that, Chromium
  // returns devices without labels, and a list of blank entries helps nobody.
  const status = page.getByTestId('lobby-mic-status');
  await expect(status).toHaveText(/microphone is/i, { timeout: 20_000 });

  const select = page.getByTestId('lobby-mic-device');
  await expect(select).toBeVisible({ timeout: 20_000 });

  const options = select.locator('option');
  await expect.poll(() => options.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

  // __app does not exist in the lobby, so the assertion is on what the person sees: the
  // first option carries a real device label, not an id fragment.
  const firstLabel = (await options.first().textContent())?.trim() ?? '';
  expect(firstLabel, 'device options should show a label').not.toBe('');
  expect(firstLabel, 'a label should be a name, not a bare device id').not.toMatch(/^[0-9a-f]{8}$/);

  // The status names the device it heard, quoted; that name must be the one the room opens.
  const statusText = (await status.textContent()) ?? '';
  const quoted = statusText.match(/"([^"]+)"/);
  expect(quoted, 'the lobby status should name the device it heard').toBeTruthy();
  const lobbyLabel = quoted[1];

  await page.getByLabel('Your name').fill('Host');
  await page.getByRole('button', { name: /create room/i }).click();
  await page.waitForURL(/\/r\/[A-Za-z0-9_-]{8,}$/, { timeout: 15_000 });
  await expect(page.getByTestId('participants-count')).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => window.__app.micSettings()?.label ?? null), {
      timeout: 15_000,
      message: 'the room should be using the microphone the lobby verified',
    })
    .toBe(lobbyLabel);

  await ctx.close();
});

test('the room reuses the lobby stream: exactly one getUserMedia from lobby to room', async ({
  browser,
}) => {
  // A second getUserMedia is not just wasteful: the lobby's stream would stay open alongside
  // the room's, the OS microphone indicator would never clear, and the track the bar moved
  // for on the join screen would not be the track peers receive.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.addInitScript(GUM_COUNTER);

  await page.goto('/r/new');
  await expect(page.getByTestId('lobby-mic-status')).toHaveText(/microphone is/i, {
    timeout: 20_000,
  });
  expect(await page.evaluate(() => window.__gumCalls)).toBe(1);

  await page.getByLabel('Your name').fill('Host');
  await page.getByRole('button', { name: /create room/i }).click();
  await page.waitForURL(/\/r\/[A-Za-z0-9_-]{8,}$/, { timeout: 15_000 });
  await expect(page.getByTestId('participants-count')).toBeVisible();

  // Wait until the room actually holds a microphone, otherwise a late second request could
  // slip in after the assertion.
  await expect
    .poll(() => page.evaluate(() => window.__app.micTrackId()), { timeout: 15_000 })
    .toBeTruthy();
  await page.waitForTimeout(1000);

  expect(
    await page.evaluate(() => window.__gumCalls),
    'the room must adopt the lobby stream rather than open the microphone again',
  ).toBe(1);

  // And the lobby track is the room track: same object, not merely the same device.
  const adopted = await page.evaluate(
    () => window.__gumStreams[0]?.getAudioTracks()[0]?.id === window.__app.micTrackId(),
  );
  expect(adopted, 'the track the lobby meter moved for should be the one in the room').toBe(true);

  await ctx.close();
});

test('switching microphone in the room replaces the sender track without renegotiation', async ({
  browser,
}) => {
  // Switching devices is replaceTrack on the existing sender: same transceiver, same mid, no
  // offer/answer round trip. A renegotiation mid-call would glitch every peer and is exactly
  // what pre-allocated transceivers exist to avoid.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const consoleLines = [];
  host.on('console', (msg) => consoleLines.push(msg.text()));
  const transceiverLogs = () => consoleLines.filter((l) => l.includes('audio: transceivers')).length;

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);
  const guestId = await selfId(guest);

  await host.getByTestId('mic-toggle').click(); // unmute so the meter has something to show
  await expectMeterMoving(host);

  const oldTrackId = await host.evaluate(() => window.__app.micTrackId());
  expect(oldTrackId).toBeTruthy();
  const oldMic = (await senders(host, guestId)).find((s) => s.role === 'mic');
  expect(oldMic?.hasTrack).toBe(true);
  expect(oldMic.trackId).toBe(oldTrackId);
  expect(await host.evaluate((id) => window.__app.signalingState(id), guestId)).toBe('stable');

  // Let the initial negotiation's log lines land before taking the baseline.
  await host.waitForTimeout(500);
  const logsBefore = transceiverLogs();

  await host.getByTestId('mic-menu-toggle').click();
  const device = host.locator('[data-testid^="mic-device-"]').first();
  await expect(device).toBeVisible({ timeout: 10_000 });
  // Picking the fake device again still re-acquires, which is what we want: a new track id
  // proves the swap path ran end to end.
  await device.click();

  await expect
    .poll(() => host.evaluate(() => window.__app.micTrackId()), {
      timeout: 10_000,
      message: 'the microphone track should be replaced',
    })
    .not.toBe(oldTrackId);
  const newTrackId = await host.evaluate(() => window.__app.micTrackId());

  await expect
    .poll(async () => (await senders(host, guestId)).find((s) => s.role === 'mic')?.trackId, {
      timeout: 10_000,
      message: 'the sender should carry the new track',
    })
    .toBe(newTrackId);

  const newMic = (await senders(host, guestId)).find((s) => s.role === 'mic');
  expect(newMic.hasTrack).toBe(true);
  expect(newMic.mid, 'same transceiver: the mid must not change').toBe(oldMic.mid);
  expect(await host.evaluate((id) => window.__app.signalingState(id), guestId)).toBe('stable');

  await host.waitForTimeout(1000);
  expect(transceiverLogs(), 'a device switch must not renegotiate').toBe(logsBefore);

  // The meter follows the new track; a meter left on the old one reads zero forever.
  await expectMeterMoving(host);
  expect(await host.evaluate(() => window.__app.micMuted()), 'mute state survives a switch').toBe(
    false,
  );

  await hostCtx.close();
  await guestCtx.close();
});

test('toggling a processing flag re-acquires and reports the effective settings', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();

  await createRoom(page, 'Host');
  await expect
    .poll(() => page.evaluate(() => window.__app.micTrackId()), { timeout: 15_000 })
    .toBeTruthy();
  const oldTrackId = await page.evaluate(() => window.__app.micTrackId());
  expect(await page.evaluate(() => window.__app.micSettings()?.settings?.noiseSuppression)).toBe(
    true,
  );

  await page.getByTestId('mic-menu-toggle').click();
  const ns = page.getByTestId('mic-proc-ns');
  await expect(ns).toBeVisible({ timeout: 10_000 });
  await expect(ns).toBeChecked();
  await ns.click();

  // Constraints cannot be changed on a live track, so a flag flip is a fresh acquisition.
  await expect
    .poll(() => page.evaluate(() => window.__app.micTrackId()), {
      timeout: 10_000,
      message: 'changing processing should re-acquire the microphone',
    })
    .not.toBe(oldTrackId);

  // What the UI reports must be what the track actually has, read back via getSettings(),
  // not merely the box the user ticked. Chromium's fake device honours noiseSuppression.
  // If a browser ever ignores the constraint, the fallback would be: the switch completed
  // (asserted above) and the reported settings are whatever the track says -- but Chromium
  // does honour it, so the strict form is asserted here.
  await expect
    .poll(() => page.evaluate(() => window.__app.micSettings()?.settings?.noiseSuppression), {
      timeout: 10_000,
      message: 'reported settings should be read back from the new track',
    })
    .toBe(false);
  expect(await page.evaluate(() => window.__app.audio().processing?.noiseSuppression)).toBe(false);

  await ctx.close();
});

test('an ended microphone track is reported dead and unmute re-acquires', async ({ browser }) => {
  // A microphone can die mid-call: the headset is unplugged, or another application grabs the
  // device. The track fires `ended`, and from then on the mute button must not flip over a
  // dead sender pretending to be live -- and the next unmute should open the device again.
  //
  // __app never exposes the track object, so the stream is captured at the getUserMedia
  // boundary instead and stopped from there.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.addInitScript(GUM_COUNTER);

  await createRoom(page, 'Host');
  await expect
    .poll(() => page.evaluate(() => window.__app.micTrackId()), { timeout: 15_000 })
    .toBeTruthy();
  const oldTrackId = await page.evaluate(() => window.__app.micTrackId());

  await page.getByTestId('mic-toggle').click(); // unmute
  await expectMeterMoving(page);

  const stopped = await page.evaluate((id) => {
    for (const stream of window.__gumStreams) {
      for (const track of stream.getAudioTracks()) {
        if (track.id === id) {
          track.stop();
          // A programmatic stop() does not fire `ended` on the same track; the event exists
          // for the device going away. Dispatch it, which is what an unplug would do.
          track.dispatchEvent(new Event('ended'));
          return true;
        }
      }
    }
    return false;
  }, oldTrackId);
  expect(stopped, 'the live track should be reachable through the captured stream').toBe(true);

  // An ended track is not a microphone: the app reports it as absent rather than as a live
  // track that happens to deliver nothing.
  await expect
    .poll(() => page.evaluate(() => window.__app.micTrackId()), {
      timeout: 10_000,
      message: 'an ended track must not be reported as the live microphone',
    })
    .toBeNull();

  // And the person is told, in red, above the mic button -- not left with a bar at zero.
  const hint = page.getByTestId('mic-hint');
  await expect(hint).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => hint.getAttribute('data-severity'), { timeout: 15_000 })
    .toMatch(/danger|warn/);
  await expect
    .poll(() => page.evaluate(() => window.__app.health()?.code ?? null), { timeout: 15_000 })
    .toMatch(/MIC_ERROR|TRACK_ENDED/);

  // A dead track is a muted microphone as far as the room is concerned: the app flips to
  // muted on its own (and tells the room), so the button reads Unmute over nothing rather
  // than Mute over a dead sender. Nothing is re-acquired until the person asks to speak.
  await expect
    .poll(() => page.evaluate(() => window.__app.micMuted()), { timeout: 10_000 })
    .toBe(true);
  await expect(page.getByTestId('mic-toggle')).toHaveAttribute('data-mic-muted', 'true');
  const gumBefore = await page.evaluate(() => window.__gumCalls);

  // Unmute is the retry moment: the person has asked to speak, so open the device again.
  await page.getByTestId('mic-toggle').click();

  await expect
    .poll(() => page.evaluate(() => window.__app.micTrackId()), {
      timeout: 15_000,
      message: 'unmuting after a dead track should re-acquire the microphone',
    })
    .toBeTruthy();
  expect(await page.evaluate(() => window.__app.micTrackId())).not.toBe(oldTrackId);
  expect(await page.evaluate(() => window.__gumCalls)).toBe(gumBefore + 1);
  await expect
    .poll(() => page.evaluate(() => window.__app.micMuted()), { timeout: 10_000 })
    .toBe(false);

  await expect
    .poll(() => page.evaluate(() => window.__app.health()?.code ?? null), {
      timeout: 15_000,
      message: 'the verdict should recover once a live microphone is back',
    })
    .not.toMatch(/MIC_ERROR|TRACK_ENDED/);
  await expectMeterMoving(page);

  await ctx.close();
});

test('a microphone Windows has muted is named in the lobby at once, in red, and clears on unmute', async ({
  browser,
}) => {
  // The bug that started all of this: the capture endpoint muted in Windows (the ASUS F9 key).
  // It used to take six seconds of nothing to get an inference; Chromium mirrors the mute onto
  // the track, so the lobby can say it the moment the device is opened -- and stop saying it
  // the moment the key is released, without anyone reloading.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.addInitScript(OS_MUTED_MIC);

  await page.goto('/r/new');
  const status = page.getByTestId('lobby-mic-status');
  await expect(status).not.toHaveText(/checking/i, { timeout: 20_000 });
  // Named within three seconds of acquisition, not after a six-second budget.
  await expect(status).toContainText('Windows has muted', { timeout: 3_000 });
  const label = ((await status.textContent()) ?? '').match(/"([^"]+)"/)?.[1] ?? '';
  expect(label, 'the line names the device').not.toBe('');
  const copy = resolve(LOBBY.osMutedDevice, { label });
  await expect(status).toContainText(copy.en);
  await expect(status).toContainText(copy.ar);
  await expect(status, 'certain, so red').toHaveClass(/field__hint--danger/);
  await expect(status).not.toHaveClass(/field__hint--warn/);

  // Not a wall: the device is open, so the bar is amber (muted), not dead, and Create works.
  const meter = page.getByTestId('lobby-meter');
  await expect(meter).toHaveClass(/meter__fill--muted/);
  await expect(meter).not.toHaveClass(/meter__fill--dead/);
  await expect(page.getByRole('button', { name: /create room/i })).toBeEnabled();

  // Muted for longer than the silence budget: the budget does not run while muted, so the
  // six-second fallback copy must never replace the certain one.
  await page.waitForTimeout(7_000);
  await expect(status).toContainText(copy.en);
  await expect(status).not.toContainText(resolve(LOBBY.silentDevice, { label }).en);

  await releaseOsMute(page);
  await expect(status).toHaveText(/microphone is/i, { timeout: 3_000 });
  await expect(status).not.toContainText('Windows has muted');
  await expect(status).not.toHaveClass(/field__hint--danger/);
  await expect(meter).not.toHaveClass(/meter__fill--muted/);

  await ctx.close();
});

test('in the room, a microphone Windows has muted is the hint above Mute, and unmuting clears it', async ({
  browser,
}) => {
  // Joining with the key still down: the room adopts the lobby track, flag and all, and the
  // verdict must be the Windows mute at once -- ranked above the eight-second "silent" rule,
  // which would otherwise send the person device-hunting for a key they can release.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.addInitScript(OS_MUTED_MIC);

  await createRoom(page, 'Host');
  await expect
    .poll(() => page.evaluate(() => window.__app.micTrackId()), { timeout: 15_000 })
    .toBeTruthy();
  expect(
    await page.evaluate(() => window.__probeTrack?.id === window.__app.micTrackId()),
    'the room should be sending the lobby track, muted flag included',
  ).toBe(true);
  const label = await page.evaluate(() => window.__app.micSettings()?.label ?? '');
  expect(label).not.toBe('');

  const hint = page.getByTestId('mic-hint');
  const hintCopy = resolve(AUDIO_HINT.SOURCE_MUTED, { label });
  await expect(hint).toBeVisible({ timeout: 5_000 });
  await expect(hint).toContainText(hintCopy.en, { timeout: 5_000 });
  await expect(hint).toContainText(hintCopy.ar);
  await expect(hint).toHaveAttribute('data-severity', 'danger');
  await expect
    .poll(() => page.evaluate(() => window.__app.health()?.code ?? null), { timeout: 5_000 })
    .toBe('SOURCE_MUTED');
  // The banner carries the SHORT copy -- the same sentence as the hint. The long explanation
  // lives behind its Audio check button rather than across the stage.
  await expect(page.getByTestId('room-banner')).toContainText(hintCopy.en, { timeout: 5_000 });
  await expect(page.getByTestId('room-banner-action')).toBeVisible();

  await releaseOsMute(page);
  await expect
    .poll(() => page.evaluate(() => window.__app.health()?.code ?? null), {
      timeout: 10_000,
      message: 'the verdict should move on once Windows unmutes the device',
    })
    .not.toBe('SOURCE_MUTED');
  // The hint element keeps its last text while hidden, so read it only while it is shown.
  const shownHint = async () => ((await hint.isVisible()) ? ((await hint.textContent()) ?? '') : '');
  await expect.poll(shownHint, { timeout: 10_000 }).not.toContain(hintCopy.en);
  expect(await page.evaluate(() => window.__app.micSettings()?.muted)).toBe(false);

  await ctx.close();
});

test('a muted replacement microphone is named in the hint, not the device it replaced', async ({
  browser,
}) => {
  // The built-in array is muted in Windows, so the hint says so and names it. The person
  // reacts by picking their headset -- muted at the endpoint too, as a headset that has been
  // sitting unused often is. The verdict code does not change, and nothing used to be
  // re-rendered: the hint, the banner and __app.health() kept naming the first device, so the
  // instructions pointed at a microphone the room was no longer using.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.addInitScript(OS_MUTED_MIC_NUMBERED);

  await createRoom(page, 'Host');
  await expect
    .poll(() => page.evaluate(() => window.__app.health()?.code ?? null), { timeout: 5_000 })
    .toBe('SOURCE_MUTED');
  const first = await page.evaluate(() => window.__app.micSettings()?.label ?? '');
  expect(first).toMatch(/\(mic 1\)$/);
  const hint = page.getByTestId('mic-hint');
  await expect(hint).toContainText(resolve(AUDIO_HINT.SOURCE_MUTED, { label: first }).en, {
    timeout: 5_000,
  });
  expect(await page.evaluate(() => window.__app.health()?.params?.label ?? null)).toBe(first);

  await page.getByTestId('mic-menu-toggle').click();
  const device = page.locator('[data-testid^="mic-device-"]').first();
  await expect(device).toBeVisible({ timeout: 10_000 });
  await device.click();

  await expect
    .poll(() => page.evaluate(() => window.__app.micSettings()?.label ?? ''), {
      timeout: 10_000,
      message: 'the switch should open the second (differently labelled) device',
    })
    .toMatch(/\(mic 2\)$/);
  const second = await page.evaluate(() => window.__app.micSettings()?.label ?? '');
  expect(second).not.toBe(first);

  // Same code, different device: everything that names the device must follow.
  await expect
    .poll(() => page.evaluate(() => window.__app.health()?.params?.label ?? null), {
      timeout: 5_000,
      message: 'the verdict params should name the device the room now uses',
    })
    .toBe(second);
  expect(await page.evaluate(() => window.__app.health()?.code ?? null)).toBe('SOURCE_MUTED');
  const secondHint = resolve(AUDIO_HINT.SOURCE_MUTED, { label: second });
  await expect(hint).toContainText(secondHint.en, { timeout: 5_000 });
  await expect(hint).toContainText(secondHint.ar);
  await expect(hint).not.toContainText(first);
  const banner = page.getByTestId('room-banner');
  await expect(banner).toContainText(secondHint.en, { timeout: 5_000 });
  await expect(banner).not.toContainText(first);

  await ctx.close();
});

test('a lobby microphone that goes away is reported as gone, not as silent', async ({ browser }) => {
  // Unplugging the headset while the join screen is open used to be reported as "nothing
  // for six seconds -- press the mic-mute key", and the line then froze there for good: the
  // dying meter's last zero was read as a reading from a live device, and no tick followed.
  // The lobby must say the device is gone, in red, with the bar dead.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.addInitScript(GUM_COUNTER);

  await page.goto('/r/new');
  const status = page.getByTestId('lobby-mic-status');
  await expect(status).toHaveText(/microphone is/i, { timeout: 20_000 });

  const ended = await page.evaluate(() => {
    const track = window.__gumStreams.flatMap((s) => s.getAudioTracks())[0];
    if (!track) return false;
    track.stop();
    track.dispatchEvent(new Event('ended'));
    return true;
  });
  expect(ended, 'the lobby track should be reachable through the captured stream').toBe(true);

  await expect(status).toHaveText(/no microphone found/i, { timeout: 5_000 });
  await expect(status).toHaveClass(/field__hint--danger/);
  await expect(status).not.toHaveClass(/field__hint--warn/);
  await expect(page.getByTestId('lobby-meter')).toHaveClass(/meter__fill--dead/);

  // And it stays that way: the Windows-mute escalation must never follow a dead device.
  await page.waitForTimeout(7_000);
  await expect(status).toHaveText(/no microphone found/i);
  await expect(status).not.toHaveClass(/field__hint--warn/);

  await ctx.close();
});
