import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CLIENT_AUDIO_DEFAULTS,
  PROCESSING_KEYS,
  RESERVED_DEVICE_IDS,
  micConstraints,
  sameProcessing,
  pickSettings,
  describeDevices,
  friendlyDeviceLabel,
} from '../../public/js/media/mic-constraints.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, '..', '..', 'config.default.json');
const CONFIG_KEYS = ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'channelCount'];

test('CLIENT_AUDIO_DEFAULTS matches media.audio in config.default.json', () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const audio = config.media.audio;
  const fromConfig = Object.fromEntries(CONFIG_KEYS.map((k) => [k, audio[k]]));
  assert.deepEqual({ ...CLIENT_AUDIO_DEFAULTS }, fromConfig);
  assert.ok(Object.isFrozen(CLIENT_AUDIO_DEFAULTS));
});

test('PROCESSING_KEYS lists the three toggleable flags and not channelCount', () => {
  assert.deepEqual([...PROCESSING_KEYS], ['echoCancellation', 'noiseSuppression', 'autoGainControl']);
});

test('micConstraints with no arguments returns the defaults and no deviceId', () => {
  assert.deepEqual(micConstraints(), { ...CLIENT_AUDIO_DEFAULTS });
  assert.deepEqual(micConstraints(null), { ...CLIENT_AUDIO_DEFAULTS });
  assert.deepEqual(micConstraints(undefined, {}), { ...CLIENT_AUDIO_DEFAULTS });
});

test('micConstraints lets a config override the processing flags and channelCount', () => {
  const out = micConstraints({ echoCancellation: false, autoGainControl: false, channelCount: 2 });
  assert.deepEqual(out, {
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: 2,
  });
});

test('micConstraints ignores config keys that are null or undefined', () => {
  const out = micConstraints({ echoCancellation: null, noiseSuppression: undefined, bogus: 1 });
  assert.deepEqual(out, { ...CLIENT_AUDIO_DEFAULTS });
});

test('micConstraints turns a deviceId into an exact constraint', () => {
  const out = micConstraints({}, { deviceId: 'abc123' });
  assert.deepEqual(out.deviceId, { exact: 'abc123' });
  assert.equal(out.echoCancellation, true);
});

test('micConstraints omits deviceId for empty, null or non-string ids', () => {
  for (const deviceId of ['', null, undefined, 42, {}]) {
    const out = micConstraints({}, { deviceId });
    assert.equal(Object.hasOwn(out, 'deviceId'), false, 'deviceId=' + String(deviceId));
  }
});

test('micConstraints does not mutate the config it was given', () => {
  const cfg = Object.freeze({ echoCancellation: false });
  assert.doesNotThrow(() => micConstraints(cfg, { deviceId: 'x' }));
});

test('sameProcessing treats identical flags as agreeing', () => {
  const s = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };
  assert.equal(sameProcessing(s, { ...s }), true);
});

test('sameProcessing treats a missing flag on either side as agreeing', () => {
  assert.equal(sameProcessing({ echoCancellation: true }, { noiseSuppression: false }), true);
  assert.equal(sameProcessing({}, { echoCancellation: false }), true);
  assert.equal(sameProcessing(null, undefined), true);
  assert.equal(sameProcessing({ echoCancellation: true, autoGainControl: false }, { echoCancellation: true }), true);
});

test('sameProcessing reports a differing boolean as not agreeing', () => {
  assert.equal(sameProcessing({ echoCancellation: true }, { echoCancellation: false }), false);
  assert.equal(sameProcessing({ noiseSuppression: false }, { noiseSuppression: true }), false);
  assert.equal(sameProcessing({ autoGainControl: true }, { autoGainControl: false }), false);
});

test('sameProcessing compares flags by truthiness and ignores non-processing keys', () => {
  assert.equal(sameProcessing({ echoCancellation: 1 }, { echoCancellation: true }), true);
  assert.equal(sameProcessing({ channelCount: 1 }, { channelCount: 2 }), true);
});

test('pickSettings null-fills every field when given nothing', () => {
  const expected = {
    deviceId: null,
    groupId: null,
    sampleRate: null,
    channelCount: null,
    echoCancellation: null,
    noiseSuppression: null,
    autoGainControl: null,
    latency: null,
  };
  assert.deepEqual(pickSettings(), expected);
  assert.deepEqual(pickSettings(null), expected);
  assert.deepEqual(pickSettings({}), expected);
});

test('pickSettings keeps the known fields, preserves false, and drops unknown ones', () => {
  const out = pickSettings({
    deviceId: 'd',
    groupId: 'g',
    sampleRate: 48000,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: true,
    latency: 0.01,
    sampleSize: 16,
  });
  assert.deepEqual(out, {
    deviceId: 'd',
    groupId: 'g',
    sampleRate: 48000,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: null,
    latency: 0.01,
  });
});

test('describeDevices splits inputs from outputs and ignores other kinds', () => {
  const out = describeDevices([
    { kind: 'audioinput', deviceId: 'in1', groupId: 'g1', label: 'Mic' },
    { kind: 'audiooutput', deviceId: 'out1', groupId: 'g1', label: 'Speakers' },
    { kind: 'videoinput', deviceId: 'cam', groupId: 'g2', label: 'Camera' },
  ]);
  assert.deepEqual(out.inputs, [{ deviceId: 'in1', groupId: 'g1', label: 'Mic' }]);
  assert.deepEqual(out.outputs, [{ deviceId: 'out1', groupId: 'g1', label: 'Speakers' }]);
});

test('describeDevices fills missing fields with empty strings', () => {
  const out = describeDevices([{ kind: 'audioinput' }]);
  assert.deepEqual(out.inputs, [{ deviceId: '', groupId: '', label: '' }]);
});

test('describeDevices handles no devices at all', () => {
  const expected = {
    inputs: [],
    outputs: [],
    defaultGroup: null,
    communicationsGroup: null,
    defaultMatchesCommunications: null,
  };
  assert.deepEqual(describeDevices(), expected);
  assert.deepEqual(describeDevices(null), expected);
  assert.deepEqual(describeDevices([]), expected);
});

test('describeDevices reports true when default and communications share a group', () => {
  const out = describeDevices([
    { kind: 'audioinput', deviceId: RESERVED_DEVICE_IDS.DEFAULT, groupId: 'g1', label: 'Default - Headset' },
    { kind: 'audioinput', deviceId: RESERVED_DEVICE_IDS.COMMUNICATIONS, groupId: 'g1', label: 'Communications - Headset' },
    { kind: 'audioinput', deviceId: 'raw', groupId: 'g1', label: 'Headset' },
  ]);
  assert.equal(out.defaultGroup, 'g1');
  assert.equal(out.communicationsGroup, 'g1');
  assert.equal(out.defaultMatchesCommunications, true);
});

test('describeDevices reports false when default and communications are different devices', () => {
  const out = describeDevices([
    { kind: 'audioinput', deviceId: 'default', groupId: 'laptop', label: 'Default - Array Mic' },
    { kind: 'audioinput', deviceId: 'communications', groupId: 'headset', label: 'Communications - Headset' },
  ]);
  assert.equal(out.defaultGroup, 'laptop');
  assert.equal(out.communicationsGroup, 'headset');
  assert.equal(out.defaultMatchesCommunications, false);
});

test('describeDevices reports null when there is no communications device', () => {
  const out = describeDevices([
    { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: 'Default - Mic' },
    { kind: 'audioinput', deviceId: 'raw', groupId: 'g1', label: 'Mic' },
  ]);
  assert.equal(out.defaultGroup, 'g1');
  assert.equal(out.communicationsGroup, null);
  assert.equal(out.defaultMatchesCommunications, null);
});

test('describeDevices reports null when a reserved entry has an empty groupId', () => {
  const out = describeDevices([
    { kind: 'audioinput', deviceId: 'default', groupId: '', label: 'Default' },
    { kind: 'audioinput', deviceId: 'communications', groupId: 'g1', label: 'Comms' },
  ]);
  assert.equal(out.defaultGroup, null);
  assert.equal(out.defaultMatchesCommunications, null);
});

test('describeDevices only resolves reserved ids among inputs, not outputs', () => {
  const out = describeDevices([
    { kind: 'audiooutput', deviceId: 'default', groupId: 'g1', label: 'Default - Speakers' },
  ]);
  assert.equal(out.defaultGroup, null);
  assert.equal(out.defaultMatchesCommunications, null);
});

test('friendlyDeviceLabel strips the Default and Communications prefixes', () => {
  assert.equal(friendlyDeviceLabel({ label: 'Default - Headset (USB)' }), 'Headset (USB)');
  assert.equal(friendlyDeviceLabel({ label: 'Communications - Headset (USB)' }), 'Headset (USB)');
  assert.equal(friendlyDeviceLabel({ label: 'default - Mic' }), 'Mic');
});

test('friendlyDeviceLabel leaves ordinary labels alone', () => {
  assert.equal(friendlyDeviceLabel({ label: 'Headset (USB)' }), 'Headset (USB)');
  assert.equal(friendlyDeviceLabel({ label: 'Default Mic' }), 'Default Mic');
  assert.equal(friendlyDeviceLabel({ label: 'My Default - Mic' }), 'My Default - Mic');
});

test('friendlyDeviceLabel returns an empty string for a missing entry or label', () => {
  assert.equal(friendlyDeviceLabel(null), '');
  assert.equal(friendlyDeviceLabel(undefined), '');
  assert.equal(friendlyDeviceLabel({}), '');
  assert.equal(friendlyDeviceLabel({ label: '' }), '');
});
