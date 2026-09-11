import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, waitConnected } from './helpers/app.js';

test('room chat supports Arabic, safe text, unread counts, reconnect and narrow layouts', async ({ browser }) => {
  test.setTimeout(90000);
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  try {
    const a = await aCtx.newPage();
    const b = await bCtx.newPage();
    const url = await createRoom(a, 'Alice');
    await joinRoom(b, url, 'Bob');
    await waitConnected(a, 1);
    const text = 'أهلاً 👋 <img src=x onerror=alert(1)>';
    await a.getByTestId('chat-input').fill(text);
    await a.getByTestId('chat-input').press('Enter');
    await expect(b.getByTestId('chat-log')).toContainText(text);
    await expect(b.getByTestId('chat-log').locator('img')).toHaveCount(0);
    await expect(a.getByTestId('chat-input')).toHaveValue('');
    await expect(a.getByTestId('chat-log').locator('.chat__message')).toHaveCount(1);
    await b.getByTestId('chat-toggle').click();
    await a.getByTestId('chat-input').fill('Second message');
    await a.getByTestId('chat-send').click();
    await expect(b.locator('#chat-unread')).toHaveText('1');
    await b.getByTestId('chat-toggle').click();
    await expect(b.locator('#chat-unread')).toBeHidden();
    await b.getByTestId('chat-input').fill('Reply');
    await b.getByTestId('chat-input').press('Shift+Enter');
    await b.getByTestId('chat-input').pressSequentially('line two');
    await b.getByTestId('chat-input').press('Enter');
    await expect(a.getByTestId('chat-log')).toContainText('Reply');
    await bCtx.setOffline(true);
    await b.evaluate(() => window.__app.dropSocket());
    await expect(b.getByTestId('chat-input')).toBeDisabled();
    await bCtx.setOffline(false);
    await expect(b.getByTestId('chat-input')).toBeEnabled({ timeout: 30000 });
    await b.getByTestId('chat-input').fill('Back again');
    await b.getByTestId('chat-send').click();
    await expect(a.getByTestId('chat-log')).toContainText('Back again');
    await b.setViewportSize({ width: 390, height: 844 });
    await expect(b.getByTestId('chat-input')).toBeInViewport();
    await expect(b.getByTestId('chat-send')).toBeInViewport();
    await b.screenshot({ path: 'test-results/chat-mobile.png' });
    await a.screenshot({ path: 'test-results/chat-desktop.png' });
  } finally {
    await aCtx.close();
    await bCtx.close();
  }
});
