import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { parseMicStatus, readMicStatus, helperPath, MAX_ENDPOINTS } from '../../desktop/mic-status.js';

// ---------------------------------------------------------------------------
// The parser: one exact shape in, anything else rejected
// ---------------------------------------------------------------------------

const ep = (name, muted, volume, isDefault) => ({ name, muted, volume, isDefault });
/** A valid status line: the default endpoint at the top level and in the list, plus any extras. */
const line = (name, muted, volume, extras = []) =>
  JSON.stringify({ name, muted, volume, endpoints: [ep(name, muted, volume, true), ...extras] });

test('the exact status line is accepted, key order aside', () => {
  assert.deepEqual(parseMicStatus(line('Microphone Array', true, 85) + '\r\n'), {
    name: 'Microphone Array',
    muted: true,
    volume: 85,
    endpoints: [ep('Microphone Array', true, 85, true)],
  });
  assert.deepEqual(
    parseMicStatus('{"endpoints":[{"isDefault":true,"volume":0,"muted":false,"name":""}],"volume":0,"muted":false,"name":""}'),
    { name: '', muted: false, volume: 0, endpoints: [ep('', false, 0, true)] },
  );
  assert.deepEqual(parseMicStatus(line('x', false, 100)), {
    name: 'x',
    muted: false,
    volume: 100,
    endpoints: [ep('x', false, 100, true)],
  });
});

test('every active endpoint comes through, in the helper order, with the default marked', () => {
  const headset = ep('Headset Microphone (Jabra)', true, 40, false);
  const webcam = ep('Microphone (HD Webcam)', false, 0, false);
  const parsed = parseMicStatus(line('Microphone Array', false, 87, [headset, webcam]));
  assert.deepEqual(parsed.endpoints, [ep('Microphone Array', false, 87, true), headset, webcam]);
  assert.equal(parsed.endpoints.filter((entry) => entry.isDefault).length, 1);

  // The cap the helper enforces is the cap the parser accepts: 32 fits, 33 does not.
  const many = (count) => Array.from({ length: count }, (_, i) => ep(`Mic ${i}`, false, 50, false));
  assert.equal(parseMicStatus(line('d', false, 1, many(MAX_ENDPOINTS - 1)))?.endpoints.length, MAX_ENDPOINTS);
  assert.equal(parseMicStatus(line('d', false, 1, many(MAX_ENDPOINTS))), null);
});

test('the helper escapes non-ASCII in names, and the parser gives the characters back', () => {
  // The real endpoint name on the machine that hit the bug carries a registered-trademark sign.
  const name = 'Microphone Array (Intel\\u00ae Smart Sound Technology)';
  const text =
    `{"name":"${name}","muted":true,"volume":85,` +
    `"endpoints":[{"name":"${name}","muted":true,"volume":85,"isDefault":true}]}`;
  const parsed = parseMicStatus(text);
  assert.equal(parsed?.name, 'Microphone Array (Intel® Smart Sound Technology)');
  assert.equal(parsed?.endpoints[0].name, 'Microphone Array (Intel® Smart Sound Technology)');
});

test("the helper's own error line is passed through as an error", () => {
  assert.deepEqual(parseMicStatus('{"error":"no default capture device"}'), { error: 'no default capture device' });
  // An empty error message is not an error worth showing.
  assert.equal(parseMicStatus('{"error":""}'), null);
  assert.equal(parseMicStatus('{"error":42}'), null);
});

test('everything malformed is rejected rather than half-read', () => {
  const ok = line('x', true, 85);
  const withEndpoints = (endpoints) => JSON.stringify({ name: 'x', muted: true, volume: 85, endpoints });
  const junk = [
    '', // empty
    '   \r\n', // whitespace only
    null,
    undefined,
    42,
    { name: 'x', muted: true, volume: 1, endpoints: [ep('x', true, 1, true)] }, // an object, not text
    'muted=False volume=85%', // the old scratchpad format
    `${ok}\n${ok}`, // two lines
    '{"name":"x","muted":true,"volume":85}', // the pre-endpoints shape
    ok.replace('"endpoints"', '"extra":1,"endpoints"'), // extra key
    withEndpoints([ep('x', true, 85, true)]).replace('"volume":85,"endpoints"', '"endpoints"'), // missing key
    ok.replace('"muted":true,"volume":85,"endpoints"', '"muted":"true","volume":85,"endpoints"'), // non-boolean muted
    ok.replace('"muted":true,"volume":85,"endpoints"', '"muted":1,"volume":85,"endpoints"'), // non-boolean muted
    ok.replace('"volume":85,"endpoints"', '"volume":101,"endpoints"'), // volume out of range
    ok.replace('"volume":85,"endpoints"', '"volume":-1,"endpoints"'), // volume out of range
    ok.replace('"volume":85,"endpoints"', '"volume":85.5,"endpoints"'), // volume not an integer
    ok.replace('"volume":85,"endpoints"', '"volume":"85","endpoints"'), // volume not a number
    ok.replace('{"name":"x"', '{"name":5'), // name not a string
    ok.replace('"endpoints"', '"error":"e","endpoints"'), // both shapes at once
    `[${ok}]`, // an array
    '"just a string"',
    'null',
    ok.slice(0, -1), // truncated
    // The endpoints list, strictly.
    withEndpoints([]), // empty
    withEndpoints({}), // not an array
    withEndpoints('x'), // not an array
    withEndpoints(null),
    withEndpoints([null]),
    withEndpoints(['x']),
    withEndpoints([[]]),
    withEndpoints([{ name: 'x', muted: true, volume: 85 }]), // missing isDefault
    withEndpoints([{ ...ep('x', true, 85, true), id: 'y' }]), // extra key
    withEndpoints([ep('x', true, 85, 'true')]), // isDefault not a boolean
    withEndpoints([ep('x', true, 85, 1)]), // isDefault not a boolean
    withEndpoints([ep('x', 'true', 85, true)]), // muted not a boolean
    withEndpoints([ep(7, true, 85, true)]), // name not a string
    withEndpoints([ep('x', true, 101, true)]), // volume out of range
    withEndpoints([ep('x', true, -1, true)]), // volume out of range
    withEndpoints([ep('x', true, 85.5, true)]), // volume not an integer
    withEndpoints([ep('x', true, '85', true)]), // volume not a number
    withEndpoints([ep('x', true, 85, true), ep('y', false, 3)]), // one good entry, one short
  ];
  for (const text of junk) {
    assert.equal(parseMicStatus(text), null, `should reject ${JSON.stringify(text)}`);
  }
});

// ---------------------------------------------------------------------------
// The helper itself, on Windows only
// ---------------------------------------------------------------------------

const onWindows = process.platform === 'win32';

test('the helper script ships next to the module', () => {
  assert.ok(helperPath().endsWith('mic-endpoint.ps1'));
  assert.ok(existsSync(helperPath()), `missing ${helperPath()}`);
});

test('the real helper answers -Command get with one line of JSON', { skip: !onWindows && 'Windows only' }, async () => {
  // Runs the script the way the main process does. Only `get` is ever run here: a test must not
  // change the mute state of the machine it runs on.
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = await new Promise((resolve) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath(), '-Command', 'get'],
      { timeout: 15_000, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });

  const lines = run.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, `expected one line, got: ${run.stdout}`);
  assert.match(lines[0], /^[\x20-\x7e]+$/, `expected ASCII-only output, got: ${run.stdout}`);
  const parsed = parseMicStatus(run.stdout);
  assert.ok(parsed, `unparseable helper output: ${run.stdout} ${run.stderr}`);

  if ('error' in parsed) {
    // A machine with no capture device at all -- CI, typically. That is a legitimate answer, and
    // it must come with the failure exit code so the main process never mistakes it for a status.
    assert.equal(run.code, 1);
    return;
  }
  assert.equal(run.code, 0);
  assert.equal(typeof parsed.name, 'string');
  assert.equal(typeof parsed.muted, 'boolean');
  assert.ok(Number.isInteger(parsed.volume) && parsed.volume >= 0 && parsed.volume <= 100);

  // Every active capture endpoint is listed, and the console default is among them exactly once,
  // carrying the same numbers as the top level.
  assert.ok(parsed.endpoints.length > 0, 'a machine with a default capture device has at least that endpoint');
  const defaults = parsed.endpoints.filter((entry) => entry.isDefault);
  assert.equal(defaults.length, 1, `expected exactly one default, got: ${run.stdout}`);
  assert.deepEqual(defaults[0], ep(parsed.name, parsed.muted, parsed.volume, true));
});

test('readMicStatus never throws and returns the status or null', { skip: !onWindows && 'Windows only' }, async () => {
  const status = await readMicStatus();
  if (status === null) return; // no capture device on this machine; logged, not thrown
  assert.deepEqual(Object.keys(status).sort(), ['endpoints', 'muted', 'name', 'volume']);
  assert.equal(typeof status.muted, 'boolean');
  assert.ok(Array.isArray(status.endpoints) && status.endpoints.length > 0);
});

test('readMicStatus resolves null off Windows', { skip: onWindows && 'the null path only exists off Windows' }, async () => {
  assert.equal(await readMicStatus(), null);
});
