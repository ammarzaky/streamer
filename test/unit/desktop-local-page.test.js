import test from 'node:test';
import assert from 'node:assert/strict';

import { isLocalPageUrl } from '../../desktop/local-page.js';

const PREFIX = 'file:///d:/streamer/desktop/ui';

test('on Windows the drive letter case Chromium reports does not matter', () => {
  // The exact mismatch that denied every permission: the process started from `d:/streamer`, so
  // the computed prefix was lower-case, while contents.getURL() reported an upper-case drive.
  assert.equal(isLocalPageUrl('file:///D:/streamer/desktop/ui/home.html', PREFIX, 'win32'), true);
  assert.equal(isLocalPageUrl('file:///d:/streamer/desktop/ui/home.html', PREFIX, 'win32'), true);
  assert.equal(isLocalPageUrl('file:///D:/Streamer/Desktop/UI/host.html', PREFIX, 'win32'), true);
});

test('elsewhere the comparison stays exact', () => {
  assert.equal(isLocalPageUrl('file:///home/me/streamer/desktop/ui/home.html', 'file:///home/me/streamer/desktop/ui', 'linux'), true);
  assert.equal(isLocalPageUrl('file:///home/me/Streamer/desktop/ui/home.html', 'file:///home/me/streamer/desktop/ui', 'linux'), false);
  assert.equal(isLocalPageUrl('file:///Users/me/streamer/desktop/ui/home.html', 'file:///users/me/streamer/desktop/ui', 'darwin'), false);
});

test('the prefix semantics are strict: other origins and other directories are not local', () => {
  for (const url of [
    'https://localhost:8443/r/abc',
    'file:///D:/streamer/public/room.html',
    'file:///D:/other/desktop/ui/home.html',
    'file:///C:/streamer/desktop/ui/home.html',
    'about:blank',
    '',
  ]) {
    assert.equal(isLocalPageUrl(url, PREFIX, 'win32'), false, url);
    assert.equal(isLocalPageUrl(url, PREFIX, 'linux'), false, url);
  }
});

test('garbage inputs are simply not local', () => {
  assert.equal(isLocalPageUrl(undefined, PREFIX, 'win32'), false);
  assert.equal(isLocalPageUrl(null, PREFIX, 'win32'), false);
  assert.equal(isLocalPageUrl('file:///D:/x', undefined, 'win32'), false);
  // An empty prefix would make everything "local"; it is refused outright.
  assert.equal(isLocalPageUrl('file:///D:/x', '', 'win32'), false);
});
