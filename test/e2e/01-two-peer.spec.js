import { test, expect } from '@playwright/test';
import {
  createRoom,
  joinRoom,
  share,
  selfId,
  waitConnected,
  assertLiveVideo,
  selectedCandidatePair,
} from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

test('two peers connect and real media flows directly @smoke', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const roomUrl = await createRoom(host, 'Host');
  await joinRoom(guest, roomUrl, 'Guest');

  await waitConnected(host, 1);
  await waitConnected(guest, 1);

  await share(host);

  const hostId = await selfId(host);
  const guestId = await selfId(guest);

  // The guest receives real, moving video -- not one frozen frame.
  await assertLiveVideo(guest, hostId);

  // And it is peer-to-peer. A relay candidate would mean media is passing through a TURN
  // server, which is the one thing this architecture exists to avoid.
  for (const [page, peerId] of [
    [host, guestId],
    [guest, hostId],
  ]) {
    const selected = await selectedCandidatePair(page, peerId);
    expect(selected, 'a candidate pair should be selected').not.toBeNull();
    expect(selected.local.candidateType).not.toBe('relay');
    expect(selected.remote.candidateType).not.toBe('relay');
  }

  // Both rosters agree.
  await expect(host.getByTestId('participants-count')).toHaveText('2');
  await expect(guest.getByTestId('participants-count')).toHaveText('2');
  await expect(guest.getByTestId(`participant-${hostId}`)).toContainText('Host');
  await expect(host.getByTestId(`participant-${guestId}`)).toContainText('Guest');

  await hostCtx.close();
  await guestCtx.close();
});

test('the room link is shareable and carries no host token', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await ctx.newPage();

  const roomUrl = await createRoom(host, 'Host');

  // The host token lives in the URL fragment so it survives a reload without this app storing
  // anything -- but it must be stripped from the address bar, because sharing a screen or a
  // browser window renders the address bar live to every participant.
  expect(roomUrl, 'the host token must not remain in the URL').not.toContain('#');

  const displayed = await host.getByTestId('share-link').getAttribute('title');
  expect(displayed).not.toContain('#');
  expect(displayed).toMatch(/\/r\/[A-Za-z0-9_-]{8,}$/);

  await ctx.close();
});
