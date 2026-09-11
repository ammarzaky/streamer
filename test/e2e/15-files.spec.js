import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRoom, joinRoom, waitConnected, share, assertVideoElementPlaying } from './helpers/app.js';

test('file transfer alongside video is exact, consented, downloadable and cancellable', async ({ browser }) => {
  test.setTimeout(120000);
  const aCtx = await browser.newContext(); const bCtx = await browser.newContext();
  try {
    const a = await aCtx.newPage(); const b = await bCtx.newPage();
    const url = await createRoom(a, 'Alice'); await joinRoom(b, url, 'Bob');
    await waitConnected(a, 1); await share(a);
    await expect(a.getByTestId('chat-attach')).toBeEnabled();
    const bytes = Buffer.from(Uint8Array.from({ length: 256001 }, (_, i) => i % 251));
    const name = 'ملف.bin';
    await a.getByTestId('chat-file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
    const incoming = b.getByTestId('file-card').filter({ hasText: name });
    const outgoing = a.getByTestId('file-card').filter({ hasText: name });
    await expect(incoming.getByTestId('file-state')).toContainText('Offered');
    await expect(incoming.getByTestId('file-download')).toBeHidden();
    await incoming.getByTestId('file-accept').click();
    await expect(incoming.getByTestId('file-state')).toContainText('Receiving');
    await assertVideoElementPlaying(b);
    await expect(incoming.getByTestId('file-state')).toContainText('Received', { timeout: 30000 });
    await expect(outgoing.getByTestId('file-state')).toContainText('Sent');
    const downloadEvent = b.waitForEvent('download');
    await incoming.getByTestId('file-download').click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(name);
    expect(await readFile(await download.path())).toEqual(bytes);
    await a.getByTestId('chat-file').setInputFiles({ name: 'cancel.bin', mimeType: 'application/octet-stream', buffer: bytes });
    const cancelled = b.getByTestId('file-card').filter({ hasText: 'cancel.bin' });
    await cancelled.getByTestId('file-accept').click();
    await expect(cancelled.getByTestId('file-state')).toContainText('Receiving');
    await cancelled.getByTestId('file-cancel').click();
    await expect(a.getByTestId('file-card').filter({ hasText: 'cancel.bin' }).getByTestId('file-state')).toContainText('Cancelled');
    await expect(cancelled.getByTestId('file-download')).toBeHidden();
    await a.screenshot({ path: 'test-results/files-desktop.png' });
    await b.setViewportSize({ width: 390, height: 844 });
    await expect(b.getByTestId('chat-attach')).toBeInViewport({ ratio: 1 });
    await b.getByTestId('chat-attach').click({ trial: true });
    await expect(b.getByTestId('chat-send')).toBeInViewport();
    await b.screenshot({ path: 'test-results/files-mobile.png' });
  } finally { await aCtx.close(); await bCtx.close(); }
});

test('a joiner offers files to both other participants, each accepts independently', async ({ browser }) => {
  test.setTimeout(120000);
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  try {
    const [a, b, c] = await Promise.all(contexts.map((ctx) => ctx.newPage()));
    const url = await createRoom(a, 'Alice');
    await joinRoom(b, url, 'Bob'); await joinRoom(c, url, 'Carol');
    for (const page of [a, b, c]) await waitConnected(page, 2);
    await expect(b.getByTestId('chat-attach')).toBeEnabled();
    await b.getByTestId('chat-file').setInputFiles({ name: 'group.txt', mimeType: 'text/plain', buffer: Buffer.from('hello group') });
    await expect(b.getByTestId('file-card')).toHaveCount(2);
    await a.getByTestId('file-cancel').click();
    await c.getByTestId('file-accept').click();
    await expect(c.getByTestId('file-state')).toContainText('Received');
    await expect(b.getByTestId('file-card').filter({ hasText: 'Alice' })).toContainText('Cancelled');
    await expect(b.getByTestId('file-card').filter({ hasText: 'Carol' })).toContainText('Sent');
  } finally { for (const ctx of contexts) await ctx.close(); }
});
