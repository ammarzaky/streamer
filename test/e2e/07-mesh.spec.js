import { test, expect } from '@playwright/test';
import {
  createRoom,
  joinRoom,
  share,
  selfId,
  waitConnected,
  assertLiveVideo,
  selectedCandidatePair,
  stats,
} from './helpers/app.js';

test.describe.configure({ mode: 'serial' });

test('three peers form a full mesh with no server relay', async ({ browser }) => {
  test.slow();

  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  const [a, b, c] = await Promise.all(contexts.map((ctx) => ctx.newPage()));

  const roomUrl = await createRoom(a, 'A');
  await joinRoom(b, roomUrl, 'B');
  await joinRoom(c, roomUrl, 'C');

  // N-1 connections each is what makes it a mesh rather than a star through the server.
  for (const page of [a, b, c]) await waitConnected(page, 2, 45_000);

  const ids = await Promise.all([a, b, c].map(selfId));

  for (const page of [a, b, c]) {
    await expect(page.getByTestId('participants-count')).toHaveText('3');
  }

  // One sharer at a time, so exactly one peer sends video -- asserting outbound video on
  // every pair would contradict the product's own rule.
  await share(a);
  await assertLiveVideo(b, ids[0]);
  await assertLiveVideo(c, ids[0]);

  // Every pair carries media directly, and none of it is relayed.
  for (const [index, page] of [a, b, c].entries()) {
    for (const [otherIndex, otherId] of ids.entries()) {
      if (index === otherIndex) continue;

      const selected = await selectedCandidatePair(page, otherId);
      expect(selected, `pair ${index}->${otherIndex} should be connected`).not.toBeNull();
      expect(selected.local.candidateType).not.toBe('relay');
      expect(selected.remote.candidateType).not.toBe('relay');

      // Audio flows on every pair regardless of who is sharing.
      const reports = await stats(page, otherId);
      const outboundAudio = reports.find((s) => s.type === 'outbound-rtp' && s.kind === 'audio');
      expect(outboundAudio, `audio should be sent ${index}->${otherIndex}`).toBeTruthy();
    }
  }

  // Only the sharer sends video.
  for (const [index, page] of [b, c].entries()) {
    const targetId = ids[index === 0 ? 2 : 1];
    const reports = await stats(page, targetId);
    const outboundVideo = reports.find(
      (s) => s.type === 'outbound-rtp' && s.kind === 'video' && s.bytesSent > 5000,
    );
    expect(outboundVideo, 'a non-sharer must not be sending video').toBeFalsy();
  }

  for (const ctx of contexts) await ctx.close();
});

test('a peer leaving a three-way call is cleaned up everywhere', async ({ browser }) => {
  test.slow();

  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  const [a, b, c] = await Promise.all(contexts.map((ctx) => ctx.newPage()));

  const roomUrl = await createRoom(a, 'A');
  await joinRoom(b, roomUrl, 'B');
  await joinRoom(c, roomUrl, 'C');
  for (const page of [a, b, c]) await waitConnected(page, 2, 45_000);

  const cId = await selfId(c);
  await contexts[2].close();

  for (const page of [a, b]) {
    await expect(page.getByTestId(`participant-${cId}`)).toBeHidden({ timeout: 25_000 });
    await expect(page.getByTestId('participants-count')).toHaveText('2');
    await waitConnected(page, 1, 25_000);
  }

  await contexts[0].close();
  await contexts[1].close();
});
