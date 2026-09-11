import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, selfId, waitConnected, senders } from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

/**
 * The audio diagnostics: the mic menu, the self test, the incoming test-mute, Copy diagnostics,
 * the blocked-playback banner, the guided Audio check and the release-microphone test.
 *
 * Each of these exists because "nobody can hear me" was reported three times and the app had
 * no way to say which of the six possible causes it was. These tests pin the behaviour of each
 * tool, not the pixels: a menu that lists a device is only useful if it lists the device the
 * browser actually opened, and a "mute incoming audio" switch is only useful if every remote
 * element really goes silent.
 */

/** The fake device's tone is well above the speaking threshold (0.06 in level-meter.js). */
const SPEAKING_THRESHOLD = 0.06;

async function openMicMenu(page) {
  await page.getByTestId('mic-menu-toggle').click();
  await expect(page.getByTestId('mic-selftest')).toBeVisible();
}

test('the mic menu lists the device the browser opened and lets you switch', async ({ browser }) => {
  // The one field a person can act on is the label of the device Windows actually opened. The
  // menu must show it -- and it must come from the live track, not from what was requested.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await createRoom(page, 'Host');

  await expect
    .poll(() => page.evaluate(() => window.__app.micSettings()?.label ?? ''), {
      timeout: 15_000,
      message: 'the room should have acquired a microphone with a label',
    })
    .not.toBe('');
  const label = await page.evaluate(() => window.__app.micSettings().label);

  await openMicMenu(page);
  await expect(page.getByTestId('mic-menu-current')).toBeVisible();
  await expect(page.getByTestId('mic-menu-current')).toContainText(label);

  // At least one device button, so switching is possible at all. The menu refreshes the
  // device list when it opens, so the buttons may arrive a moment after the menu does.
  await expect
    .poll(() => page.locator('[data-testid^="mic-device-"]').count(), {
      timeout: 10_000,
      message: 'the menu should list at least one input device',
    })
    .toBeGreaterThan(0);

  // Switching to a listed device keeps a microphone attached -- nothing else about the switch
  // is observable on a machine with a single fake device, but a switch that leaves no track
  // would be the worst possible outcome of this menu.
  await page.locator('[data-testid^="mic-device-"]').first().click();
  await expect
    .poll(() => page.evaluate(() => window.__app.micSettings()?.readyState ?? null), { timeout: 15_000 })
    .toBe('live');

  await ctx.close();
});

test('the self test records and plays back with a peak above the speaking threshold', async ({ browser }) => {
  // "Record three seconds and play it back" is the one test that needs nobody on the far end.
  // The peak proves the microphone delivers sound to the app; the bytes prove the recorder
  // produced a file. Playback needs a gesture in some browsers, which is a separate failure the
  // result reports explicitly rather than folding into a generic "failed".
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await createRoom(page, 'Host');

  await expect
    .poll(() => page.evaluate(() => window.__app.micTrackId()), { timeout: 15_000 })
    .not.toBeNull();

  // Blob / revoke are not serialisable, so pick the fields that matter inside the page.
  const result = await page.evaluate(async () => {
    const r = await window.__app.runSelfTest();
    if (!r) return null;
    return { ok: r.ok, peak: r.peak, bytes: r.bytes, error: r.error, playbackError: r.playbackError };
  });

  expect(result, 'the self test should run (not be busy or without a track)').not.toBeNull();
  expect(result.error, 'recording itself should not fail').toBeNull();
  expect(result.peak, 'the fake tone should register well above the speaking threshold').toBeGreaterThan(
    SPEAKING_THRESHOLD,
  );
  expect(result.bytes, 'the recorder should produce a non-empty file').toBeGreaterThan(0);
  if (!result.ok) {
    // Acceptable only when the browser refused playback for want of a gesture -- and it must
    // say so, because "failed" without a reason is what this feature replaces.
    expect(result.playbackError, 'a failed self test must name the playback error').toBeTruthy();
  }

  // The verdict is shown in the menu, where the person who ran it will look for it.
  await openMicMenu(page);
  await expect(page.getByTestId('mic-selftest-result')).toBeVisible();
  await expect(page.getByTestId('mic-selftest-result')).toHaveText(/Recorded|refused to play/i);

  await ctx.close();
});

test('Mute incoming audio (test) mutes every remote audio element and says so', async ({ browser }) => {
  // The question this answers: "is the voice I hear coming from this app?" With every remote
  // element muted, anything still audible is Windows 'Listen to this device' or a headset's
  // sidetone. The switch is worthless unless it really reaches every element, and dangerous
  // unless the banner says you cannot hear anyone.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  // A remote audio element exists once the guest's mic track arrives.
  await expect
    .poll(() => host.locator('#audio-sinks audio').count(), {
      timeout: 20_000,
      message: "the host should have an <audio> element for the guest",
    })
    .toBeGreaterThan(0);

  const allMuted = () =>
    host.evaluate(() => {
      const els = [...document.querySelectorAll('#audio-sinks audio')];
      return els.length > 0 && els.every((a) => a.muted === true);
    });

  expect(await allMuted(), 'remote audio starts unmuted').toBe(false);

  await openMicMenu(host);
  await host.getByTestId('mic-incoming-mute').check();

  await expect.poll(allMuted, { timeout: 5_000 }).toBe(true);
  await expect(host.getByTestId('room-banner')).toHaveText(/muted for testing/i);

  // And the peer is told too -- their tile should say so rather than "cannot hear you".
  // (The report rides on the 1 s stats tick, so give it a moment.)
  const hostId = await selfId(host);
  await expect(guest.getByTestId(`hear-${hostId}`)).toHaveText(/muted incoming audio \(test\)/i, {
    timeout: 15_000,
  });

  // Untick: everything comes back, including the banner going away.
  // The checkbox does not close the menu, but a re-render on the audio slice may have rebuilt
  // it, so re-open if it is gone rather than clicking a stale node.
  if ((await host.getByTestId('mic-menu-toggle').getAttribute('aria-expanded')) !== 'true') {
    await openMicMenu(host);
  }
  await host.getByTestId('mic-incoming-mute').uncheck();
  await expect.poll(allMuted, { timeout: 5_000 }).toBe(false);
  await expect(host.getByTestId('room-banner')).not.toHaveText(/muted for testing/i);

  await hostCtx.close();
  await guestCtx.close();
});

test('a participant can be turned up past what the element alone can reach', async ({ browser }) => {
  // `HTMLMediaElement.volume` is clamped to 1 by the specification, so anything above 100% has
  // to leave the element and go through Web Audio. The two things worth pinning are that the
  // gain actually reaches the graph, and that the element is muted once it does -- otherwise
  // the peer is audible twice, once boosted and once not.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);
  const guestId = await selfId(guest);

  await expect
    .poll(() => host.locator('#audio-sinks audio').count(), { timeout: 20_000 })
    .toBeGreaterThan(0);

  await openMicMenu(host);
  const slider = host.getByTestId(`peer-volume-${guestId}`);
  await expect(slider).toBeVisible();
  await expect(host.getByTestId(`peer-volume-value-${guestId}`)).toHaveText('100%');

  // Nothing is built until a slider moves: an AudioContext for every call would be a real cost
  // paid by everyone who never touches this.
  expect(await host.evaluate(() => window.__app.mixer().active)).toBe(false);

  await slider.fill('50');
  await slider.dispatchEvent('input');
  const quiet = await host.evaluate((id) => window.__app.audioSinks()[id], guestId);
  expect(quiet.volume).toBe(0.5);
  expect(quiet.outputVia).toBe('element');
  expect(await host.evaluate(() => window.__app.mixer().active)).toBe(false);

  await slider.fill('300');
  await slider.dispatchEvent('input');

  await expect(host.getByTestId(`peer-volume-value-${guestId}`)).toHaveText('300%');
  await expect
    .poll(() => host.evaluate((id) => window.__app.audioSinks()[id]?.gain ?? null, guestId), {
      timeout: 10_000,
      message: 'the gain should reach the playback graph',
    })
    .toBe(3);

  const sink = await host.evaluate((id) => window.__app.audioSinks()[id], guestId);
  expect(sink.outputVia, 'above 100% the element cannot carry it').toBe('webaudio');
  expect(sink.muted, 'the element is silenced so nobody is heard twice').toBe(true);
  expect(await host.evaluate(() => window.__app.mixer().active)).toBe(true);

  // And it survives the menu being rebuilt, which happens on every stats tick.
  await host.waitForTimeout(2500);
  await expect(host.getByTestId(`peer-volume-${guestId}`)).toHaveValue('300');
  expect(await host.evaluate(() => window.__app.peerVolumes())).toEqual({ [guestId]: 3 });

  await host.getByTestId('mic-incoming-mute').check();
  await host.getByTestId('mic-incoming-mute').uncheck();
  expect(await host.evaluate((id) => window.__app.audioSinks()[id].muted, guestId)).toBe(true);
  expect(await host.getByTestId('mixer-output').evaluate((audio) => audio.muted)).toBe(false);

  await slider.fill('80');
  await slider.dispatchEvent('input');
  const restored = await host.evaluate((id) => window.__app.audioSinks()[id], guestId);
  expect(restored.outputVia).toBe('element');
  expect(restored.volume).toBe(0.8);
  expect(restored.muted).toBe(false);

  await hostCtx.close();
  await guestCtx.close();
});

test('the speaker picker routes every remote element at once', async ({ browser }) => {
  // Asserted through the recorded sinkId rather than by listening: setSinkId in headless
  // Chromium reports success without any audible consequence, so "did it play out of the right
  // speaker" is not a question this suite can ask. What it can pin is that the choice reaches
  // every element, present and future, which is where the bug would be.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  await expect
    .poll(() => host.locator('#audio-sinks audio').count(), { timeout: 20_000 })
    .toBeGreaterThan(0);

  await openMicMenu(host);
  const supported = await host.evaluate(() => 'setSinkId' in HTMLMediaElement.prototype);
  if (!supported) {
    await expect(host.getByTestId('speaker-unsupported')).toBeVisible();
    await hostCtx.close();
    await guestCtx.close();
    return;
  }

  await expect
    .poll(() => host.locator('[data-testid^="speaker-device-"]').count(), {
      timeout: 10_000,
      message: 'the menu should list at least one output device',
    })
    .toBeGreaterThan(0);

  await host.locator('[data-testid^="speaker-device-"]').first().click();
  await expect
    .poll(() => host.evaluate(() => window.__app.speakerDevice()), { timeout: 5_000 })
    .not.toBe(null);

  const chosen = await host.evaluate(() => window.__app.speakerDevice());
  // Every element, not just the first: the loop is the whole point.
  await expect
    .poll(
      () =>
        host.evaluate(() =>
          [...document.querySelectorAll('#audio-sinks audio')].map((a) => a.sinkId ?? ''),
        ),
      { timeout: 10_000 },
    )
    .toEqual(expect.arrayContaining([chosen]));

  // And it is remembered for the tab, so a reload does not send the call back to the laptop
  // speakers without saying so.
  const stored = await host.evaluate(() => JSON.parse(sessionStorage.getItem('streamer:audio') ?? '{}'));
  expect(stored.speakerDeviceId).toBe(chosen);

  await hostCtx.close();
  await guestCtx.close();
});

test('a banner takes one strip of the page, not the stage', async ({ browser }) => {
  // The regression this pins: `.room` declared three grid rows for four children. While the
  // banner was hidden it was not placed at all and the layout looked right; the moment one
  // appeared it landed on the `1fr` row, grew to the whole remaining viewport, and squeezed the
  // entire stage and roster into the control bar's 72px. A banner is a strip. Assert the size,
  // because "it looked fine in the screenshot with no banner" is exactly how this shipped.
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await ctx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  const bodyHeight = () => host.locator('.room__body').evaluate((el) => el.getBoundingClientRect().height);
  const before = await bodyHeight();
  expect(before, 'the room body should own most of the viewport to begin with').toBeGreaterThan(200);

  await openMicMenu(host);
  await host.getByTestId('mic-incoming-mute').check();
  await expect(host.getByTestId('room-banner')).toBeVisible();

  const bannerHeight = await host.locator('#room-banner').evaluate((el) => el.getBoundingClientRect().height);
  expect(bannerHeight, 'a banner is a strip, not a panel').toBeLessThan(80);
  expect(bannerHeight).toBeGreaterThan(0);

  const after = await bodyHeight();
  expect(after, 'the stage should lose only the banner strip').toBeGreaterThan(before - bannerHeight - 4);

  await ctx.close();
  await guestCtx.close();
});

test('Copy diagnostics shows a JSON blob with the expected shape', async ({ browser }) => {
  // The dump is what a support conversation runs on. Its shape is the contract: a person
  // debugging later needs the environment, the mic the browser opened, the meter, every remote
  // element's playback state, each peer's transceivers and a timeline -- in one paste.
  const hostCtx = await browser.newContext({
    permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
  });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  await host.getByTestId('stats-toggle').click();
  await host.getByTestId('stats-copy-diagnostics').click();

  const dialog = host.getByTestId('text-dialog');
  await expect(dialog).toBeVisible();
  const raw = await host.getByTestId('text-dialog-area').inputValue();
  expect(raw.length, 'the dialog should show the blob, whether or not the clipboard worked').toBeGreaterThan(0);

  let parsed;
  expect(() => {
    parsed = JSON.parse(raw);
  }, 'the diagnostics text must be valid JSON').not.toThrow();

  for (const key of ['env', 'room', 'self', 'mic', 'lobby', 'meter', 'audio', 'peers', 'audioTimeline', 'log']) {
    expect(parsed, `diagnostics should carry "${key}"`).toHaveProperty(key);
  }
  expect(parsed.format).toBe('streamer-diagnostics/1');
  expect(typeof parsed.audio.sinks, 'audio.sinks is a peerId -> element state map').toBe('object');
  expect(parsed.audio.sinks).not.toBeNull();
  expect(Array.isArray(parsed.peers)).toBe(true);
  expect(parsed.peers.length).toBeGreaterThan(0);

  const tx = parsed.peers[0].transceivers;
  expect(Array.isArray(tx), 'each peer carries its transceiver snapshot').toBe(true);
  const roles = tx.map((t) => t.role).sort();
  expect(roles).toEqual(['mic', 'shareAudio', 'video']);
  expect(Array.isArray(parsed.log)).toBe(true);

  // The same accessor the page exposes for the console must agree with the dialog.
  const viaApp = JSON.parse(await host.evaluate(() => window.__app.diagnostics()));
  expect(viaApp.self.id).toBe(parsed.self.id);

  await host.getByTestId('text-dialog-close').click();
  await expect(dialog).toBeHidden();

  await hostCtx.close();
  await guestCtx.close();
});

test('a blocked remote audio element is reported and recoverable by a click', async ({ browser }) => {
  // Autoplay policy: the browser accepts the stream, decodes it, and refuses to play it until a
  // gesture. From the other end this is indistinguishable from a dead microphone, which is why
  // a refused play() is no longer swallowed: it becomes a banner whose button is the gesture.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  // Refuse every play() on the guest until the test flips the flag, then behave normally.
  await guest.addInitScript(() => {
    const realPlay = HTMLMediaElement.prototype.play;
    window.__allowPlay = false;
    HTMLMediaElement.prototype.play = function play(...args) {
      if (window.__allowPlay) return realPlay.apply(this, args);
      return Promise.reject(new DOMException('play() blocked by test', 'NotAllowedError'));
    };
  });

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(guest, 1);
  const hostId = await selfId(host);

  await expect(guest.getByTestId('room-banner')).toHaveText(/blocked until you click/i, { timeout: 20_000 });
  await expect(guest.getByTestId('room-banner-action')).toBeVisible();

  // The stats panel records the refusal by name, so it can be told apart from silence.
  await expect
    .poll(() => guest.evaluate((id) => window.__app.audioSinks()[id]?.playError ?? null, hostId), {
      timeout: 10_000,
    })
    .toBe('NotAllowedError');

  await guest.evaluate(() => {
    window.__allowPlay = true;
  });
  await guest.getByTestId('room-banner-action').click();

  await expect
    .poll(() => guest.evaluate((id) => window.__app.audioSinks()[id]?.paused ?? null, hostId), {
      timeout: 10_000,
      message: 'the click should get the element playing',
    })
    .toBe(false);
  // `?? 'missing'` would turn a cleared (null) playError into 'missing' -- the sink and the
  // error are asked about separately on purpose.
  await expect
    .poll(
      () =>
        guest.evaluate((id) => {
          const sink = window.__app.audioSinks()[id];
          return sink ? sink.playError : 'missing';
        }, hostId),
      { timeout: 10_000 },
    )
    .toBeNull();
  await expect(guest.getByTestId('room-banner')).not.toHaveText(/blocked until you click/i);

  await hostCtx.close();
  await guestCtx.close();
});

test('the Audio check walks its steps', async ({ browser }) => {
  // The guided check is the ladder from the docs, in a dialog, in both languages. Each step
  // must show its own evidence: a live meter on step 1, the self-hearing verdict on step 2, the
  // sending status on step 3, and a summary at the end.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);

  await openMicMenu(host);
  await host.getByTestId('mic-audio-check').click();

  const dialog = host.getByTestId('audio-check');
  await expect(dialog).toBeVisible();
  await expect(host.getByTestId('audio-check-step-title')).toContainText('Say something');

  // Step 1: the bar moves on its own with the fake tone.
  await expect
    .poll(() => host.getByTestId('audio-check-meter').evaluate((el) => parseFloat(el.style.width) || 0), {
      timeout: 10_000,
      message: 'the live meter should respond to the microphone',
    })
    .toBeGreaterThan(0);
  await expect(host.getByTestId('audio-check-device')).toBeVisible();

  // Step 2: "yes, I still hear myself while muted" points at Windows, not at this app.
  await host.getByTestId('audio-check-next').click();
  await expect(host.getByTestId('audio-check-step-title')).toContainText('Mute and keep talking');
  await host.getByTestId('audio-check-yes').click();
  await expect(host.getByTestId('audio-check-step2-answer')).toContainText('Listen to this device');

  // Step 3: the sending status, measured rather than assumed.
  await host.getByTestId('audio-check-next').click();
  await expect(host.getByTestId('audio-check-step-title')).toContainText('Unmute and talk');
  await expect(host.getByTestId('audio-check-step3')).toContainText('Sending', { timeout: 10_000 });

  // Step 4: what arrives from them.
  await host.getByTestId('audio-check-next').click();
  await expect(host.getByTestId('audio-check-step4')).toBeVisible();

  // Summary.
  await host.getByTestId('audio-check-next').click();
  await expect(host.getByTestId('audio-check-summary')).toBeVisible();
  await expect(host.getByTestId('audio-check-copy')).toBeVisible();

  await host.getByTestId('audio-check-close').click();
  await expect(dialog).toHaveCount(0);

  await hostCtx.close();
  await guestCtx.close();
});

test('the release-microphone test re-acquires and keeps the sender attached', async ({ browser }) => {
  // Releasing the capture for three seconds distinguishes Windows 'Listen' (persists) from a
  // headset's sidetone (stops while nothing holds the mic). The dangerous part is the return
  // trip: the new track must land back on the sender, or the test would leave the person silent
  // to everyone -- the very bug the diagnostics were built to catch.
  const hostCtx = await browser.newContext({ permissions: ['microphone'] });
  const guestCtx = await browser.newContext({ permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);
  const guestId = await selfId(guest);

  const micSender = async () => (await senders(host, guestId)).find((s) => s.role === 'mic') ?? null;

  await expect
    .poll(async () => (await micSender())?.hasTrack ?? false, { timeout: 15_000 })
    .toBe(true);
  const before = await host.evaluate(() => window.__app.micTrackId());
  expect(before).toBeTruthy();

  await openMicMenu(host);
  await host.getByTestId('mic-release-test').click();

  // It really lets go: the sender loses its track while released.
  await expect
    .poll(async () => (await micSender())?.hasTrack ?? null, {
      timeout: 5_000,
      message: 'the mic sender should be empty while the microphone is released',
    })
    .toBe(false);

  // And comes back, as a NEW track, attached to the same sender.
  await expect
    .poll(async () => (await micSender())?.hasTrack ?? false, {
      timeout: 6_000,
      message: 'the microphone should be re-acquired and re-attached within a few seconds',
    })
    .toBe(true);
  const after = await host.evaluate(() => window.__app.micTrackId());
  expect(after).toBeTruthy();
  expect(after, 'the re-acquired track must be a fresh capture, not the stopped one').not.toBe(before);
  expect((await micSender()).trackId).toBe(after);

  // Muted on arrival, and the release must not have quietly unmuted anyone.
  expect(await host.evaluate(() => window.__app.micMuted())).toBe(true);
  expect(await host.evaluate(() => window.__app.micTrackEnabled())).toBe(false);

  await hostCtx.close();
  await guestCtx.close();
});
