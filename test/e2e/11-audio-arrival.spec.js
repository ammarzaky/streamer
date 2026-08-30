import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, selfId, waitConnected, stats } from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

/**
 * "Can he hear me?" -- answered with sound, not bytes.
 *
 * 03-mute already proves audio BYTES arrive. That is not the same thing: an unmuted sender
 * whose track went silent (a dead capture device, a stalled AudioContext, a transceiver that
 * negotiated recvonly) still ships ~14 kbps of encoded silence, and every byte counter keeps
 * climbing. What actually distinguishes a voice from silence is `totalAudioEnergy` on the
 * receiver's inbound-rtp report: it only grows when decoded samples are non-zero. The fake
 * device is a tone, so with the mic open the energy must climb; if it does not, nobody can hear
 * this person no matter what the roster says.
 */

const ENERGY_WINDOW_MS = 3000;
/** The fake tone is loud (RMS ~0.1-0.3 after processing). 3 s of it accumulates well above
 *  this; 3 s of encoded silence accumulates ~0. */
const MIN_ENERGY_RISE = 0.005;

function newPair(browser) {
  return Promise.all([
    browser.newContext({ permissions: ['microphone'] }),
    browser.newContext({ permissions: ['microphone'] }),
  ]);
}

/**
 * The inbound audio report carrying the far end's microphone.
 *
 * Resolved via the negotiated mid of the receiver's own mic transceiver, because two audio
 * transceivers exist per connection (mic + share audio) and the wrong one is always silent.
 */
async function inboundMicAudio(page, peerId) {
  const [reports, transceivers] = await Promise.all([
    stats(page, peerId),
    page.evaluate((id) => window.__app.transceivers(id), peerId),
  ]);
  const micMid = (transceivers ?? []).find((t) => t.role === 'mic')?.mid ?? null;
  const inbound = (reports ?? []).filter((r) => r.type === 'inbound-rtp' && r.kind === 'audio');
  return (
    (micMid !== null && inbound.find((r) => String(r.mid) === String(micMid))) ??
    (inbound.length === 1 ? inbound[0] : null) ??
    null
  );
}

const inboundEnergy = async (page, peerId) =>
  (await inboundMicAudio(page, peerId))?.totalAudioEnergy ?? 0;

/** Assert that decoded audio at `listener` from `speakerId` carries real sound. */
async function assertSoundArrives(listener, speakerId, who) {
  await expect
    .poll(() => inboundEnergy(listener, speakerId), {
      timeout: 25_000,
      message: `${who}: inbound audio energy should leave zero once the mic is open`,
    })
    .toBeGreaterThan(0);

  const before = await inboundEnergy(listener, speakerId);
  await listener.waitForTimeout(ENERGY_WINDOW_MS);
  const after = await inboundEnergy(listener, speakerId);
  expect(
    after - before,
    `${who}: audio energy must keep rising -- bytes without energy is encoded silence`,
  ).toBeGreaterThan(MIN_ENERGY_RISE);
}

/**
 * Both ends agree, through the UI, about who hears whom.
 *
 * The listener's own getStats say "hearing them"; the speaker's row says "can hear you", which
 * can only come from the listener's report over the diag data channel -- so this also proves
 * the channel round-trips.
 */
async function assertBothPanelsAgree(speaker, listener) {
  await expect(listener.getByTestId('stat-their-mic')).toHaveText(/hearing them/, {
    timeout: 15_000,
  });
  await expect(speaker.getByTestId('stat-they-hear')).toHaveText(/can hear you/, {
    timeout: 15_000,
  });
}

async function openStats(page) {
  await page.getByTestId('stats-toggle').click();
  await expect(page.getByTestId('stat-mic-send')).toBeVisible();
}

async function unmute(page) {
  await page.getByTestId('mic-toggle').click();
  await expect
    .poll(() => page.evaluate(() => window.__app.micMuted()), { timeout: 10_000 })
    .toBe(false);
}

test("the host's voice reaches the guest as sound, not just bytes", async ({ browser }) => {
  const [hostCtx, guestCtx] = await newPair(browser);
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);
  await waitConnected(guest, 1);

  const hostId = await selfId(host);

  await unmute(host);
  await assertSoundArrives(guest, hostId, 'host -> guest');

  await openStats(host);
  await openStats(guest);
  await assertBothPanelsAgree(host, guest);

  await hostCtx.close();
  await guestCtx.close();
});

test('the answering side is heard too, and the creator is heard by the joiner', async ({
  browser,
}) => {
  // The joiner is the ANSWERER: its transceivers are created from the remote offer, and its
  // microphone arrives on its own schedule. 03-mute checks bytes for exactly this race; here
  // the bar is sound, in both directions, from the same session -- because a transceiver that
  // negotiated the wrong direction on one side is invisible from the other.
  const [creatorCtx, joinerCtx] = await newPair(browser);
  const creator = await creatorCtx.newPage();
  const joiner = await joinerCtx.newPage();

  const roomUrl = await createRoom(creator, 'Creator');
  await joinRoom(joiner, roomUrl, 'Joiner');
  await waitConnected(creator, 1);
  await waitConnected(joiner, 1);

  const creatorId = await selfId(creator);
  const joinerId = await selfId(joiner);

  // Joiner speaks first: the direction the original bug lived in.
  await unmute(joiner);
  await assertSoundArrives(creator, joinerId, 'joiner -> creator');

  await openStats(creator);
  await openStats(joiner);
  await assertBothPanelsAgree(joiner, creator);

  // Then the creator, once the second participant is already in the room.
  await unmute(creator);
  await assertSoundArrives(joiner, creatorId, 'creator -> joiner');
  await assertBothPanelsAgree(creator, joiner);

  await creatorCtx.close();
  await joinerCtx.close();
});

test('exactly one offer per peer, and every mic m-line negotiates sendrecv on both sides', async ({
  browser,
}) => {
  // Two failure modes hide behind a 'connected' state. A second, unsolicited offer (glare, or
  // a renegotiation nobody asked for) can flip a transceiver to recvonly; and a transceiver
  // that Chrome created implicitly from the remote offer defaults to recvonly unless the
  // answerer fixes the direction. Either way the sender holds a live track and sends nothing.
  //
  // peer.js logs 'audio: transceivers' after every applied description, tagged with the
  // description type, so the log is the count of negotiations that actually happened.
  const [hostCtx, guestCtx] = await newPair(browser);
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const collect = (page) => {
    const entries = [];
    page.on('console', async (message) => {
      if (!message.text().includes('audio: transceivers')) return;
      try {
        const detail = await message.args()[1]?.jsonValue();
        if (detail) entries.push(detail);
      } catch {
        // The page may be closing; a lost entry only makes the count stricter, never looser.
      }
    });
    return entries;
  };
  const hostLog = collect(host);
  const guestLog = collect(guest);

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);
  await waitConnected(guest, 1);

  const hostId = await selfId(host);
  const guestId = await selfId(guest);

  // Let any late renegotiation show itself before counting.
  await host.waitForTimeout(3000);

  const offersFor = (log, peerId) =>
    log.filter((e) => e.peerId === peerId && e.after === 'offer');
  const answersFor = (log, peerId) =>
    log.filter((e) => e.peerId === peerId && e.after === 'answer');

  // Exactly one offer ever crossed each connection, in one direction only.
  const hostOffers = offersFor(hostLog, guestId).length;
  const guestOffers = offersFor(guestLog, hostId).length;
  expect(hostOffers + guestOffers, 'exactly one offer should have been applied in total').toBe(1);
  expect(
    answersFor(hostLog, guestId).length + answersFor(guestLog, hostId).length,
    'and exactly one answer',
  ).toBe(1);

  // And what was negotiated is what was asked for, on BOTH ends.
  for (const [page, peerId, who] of [
    [host, guestId, 'host'],
    [guest, hostId, 'guest'],
  ]) {
    await expect
      .poll(
        async () => {
          const tx = await page.evaluate((id) => window.__app.transceivers(id), peerId);
          return (tx ?? []).find((t) => t.role === 'mic') ?? null;
        },
        { timeout: 15_000, message: `${who}: the mic transceiver should be negotiated` },
      )
      .toMatchObject({ direction: 'sendrecv', currentDirection: 'sendrecv' });

    const tx = await page.evaluate((id) => window.__app.transceivers(id), peerId);
    for (const t of tx) {
      expect(t.direction, `${who}: ${t.role} direction`).toBe('sendrecv');
      expect(t.currentDirection, `${who}: ${t.role} negotiated direction`).toBe('sendrecv');
    }
  }

  await hostCtx.close();
  await guestCtx.close();
});

test('after a host socket drop and reconnect, audio still arrives and reports resume', async ({
  browser,
}) => {
  // A reconnecting client receives a NEW peer id and the mesh is rebuilt from scratch. The
  // things that can silently go missing on the rebuild are the mic track (attached to the old
  // connection only), the diag channel (opened once, never re-opened) and the meter. The
  // roster looks identical either way, so only sound + the peer's report tell them apart.
  const [hostCtx, guestCtx] = await newPair(browser);
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');
  await waitConnected(host, 1);
  await waitConnected(guest, 1);

  const oldHostId = await selfId(host);
  await unmute(host);
  await assertSoundArrives(guest, oldHostId, 'before the drop');

  await openStats(host);
  await openStats(guest);
  await assertBothPanelsAgree(host, guest);

  // Drop the signaling socket the way a real network failure would.
  expect(await host.evaluate(() => window.__app.dropSocket())).toBe(true);
  await expect(host.getByTestId('room-banner')).toBeVisible({ timeout: 10_000 });

  // The rebuilt mesh: the host has a fresh id and the guest knows it.
  await expect
    .poll(() => selfId(host), { timeout: 30_000, message: 'the host should rejoin under a new id' })
    .not.toBe(oldHostId);
  const newHostId = await selfId(host);

  await expect
    .poll(() => guest.evaluate(() => window.__app.peers().map((p) => p.peerId)), {
      timeout: 30_000,
      message: "the guest should list the host's new id",
    })
    .toContain(newHostId);
  await waitConnected(host, 1, 45_000);
  await waitConnected(guest, 1, 45_000);

  // Mute state is not required to survive a rejoin; make sure the mic is open either way.
  if (await host.evaluate(() => window.__app.micMuted())) await unmute(host);

  await assertSoundArrives(guest, newHostId, 'after the reconnect');

  // The panels re-render for the new peer id, and the diag channel reports flow again.
  await expect(guest.getByTestId('stat-their-mic')).toHaveText(/hearing them/, {
    timeout: 20_000,
  });
  await expect(host.getByTestId('stat-they-hear')).toHaveText(/can hear you/, {
    timeout: 20_000,
  });

  await hostCtx.close();
  await guestCtx.close();
});
