import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveAudio, MIC_SPEECH_RMS, SPEECH_HOLD_SEC } from '../../public/js/stats/stats-collector.js';

/** Fabricated getStats reports. Field names match what browsers actually return. */
/** deriveAudio with a mic track attached by default: the sole-report fallback needs one, and
 *  most tests here fabricate a single outbound stream whose source track is 't'. */
const derive = (values, opts = {}) => deriveAudio(values, { micTrackId: 't', ...opts });

const source = (id, trackIdentifier, extra = {}) => ({
  type: 'media-source',
  kind: 'audio',
  id,
  trackIdentifier,
  ...extra,
});
const outbound = (id, mediaSourceId, extra = {}) => ({
  type: 'outbound-rtp',
  kind: 'audio',
  id,
  mediaSourceId,
  packetsSent: 0,
  bytesSent: 0,
  ...extra,
});
const inbound = (id, extra = {}) => ({ type: 'inbound-rtp', kind: 'audio', id, ...extra });
const remoteInbound = (extra = {}) => ({ type: 'remote-inbound-rtp', kind: 'audio', id: 'RI1', ...extra });

/** Something that is not audio, to make sure it is ignored. */
const videoNoise = () => [
  { type: 'outbound-rtp', kind: 'video', id: 'OV', bytesSent: 999 },
  { type: 'inbound-rtp', kind: 'video', id: 'IV', bytesReceived: 999 },
  { type: 'media-source', kind: 'video', id: 'SV', trackIdentifier: 'mic-track' },
  { type: 'candidate-pair', id: 'CP' },
];

const loud = { audioLevel: 0.5, totalAudioEnergy: 10, totalSamplesDuration: 10 };

test('exports a speech threshold on the 0..1 RMS scale', () => {
  assert.ok(MIC_SPEECH_RMS > 0 && MIC_SPEECH_RMS < 1);
});

test('the microphone is matched by track identifier when two outbound audio streams exist', () => {
  const values = [
    ...videoNoise(),
    source('S-share', 'share-track', { audioLevel: 0.9, totalAudioEnergy: 50, totalSamplesDuration: 10 }),
    source('S-mic', 'mic-track', { audioLevel: 0.02, totalAudioEnergy: 1, totalSamplesDuration: 10 }),
    outbound('O-share', 'S-share', { packetsSent: 500, bytesSent: 50000 }),
    outbound('O-mic', 'S-mic', { packetsSent: 100, bytesSent: 8000 }),
  ];
  const out = derive(values, { micTrackId: 'mic-track' });
  assert.equal(out.mic.hasSender, true);
  assert.equal(out.mic.level, 0.02);
  assert.deepEqual(out.cumulative, {
    micEnergy: 1,
    micDuration: 10,
    micPackets: 100,
    micBytes: 8000,
    // audioLevel 0.02 is above MIC_SPEECH_RMS, so this sample carries speech and the quiet
    // counter is at zero.
    micQuietSec: 0,
    in: {},
  });
});

test('with two outbound audio streams and no matching track id, nothing is guessed', () => {
  const values = [
    source('S1', 'a', loud),
    source('S2', 'b', loud),
    outbound('O1', 'S1', { packetsSent: 1 }),
    outbound('O2', 'S2', { packetsSent: 2 }),
  ];
  const out = derive(values, { micTrackId: 'unknown' });
  assert.equal(out.mic.hasSender, false);
  assert.equal(out.mic.level, null);
  assert.equal(out.cumulative.micPackets, null);
  assert.equal(out.cumulative.micBytes, 0);
});

test('a sole outbound audio report is taken as the microphone only when a mic track is attached', () => {
  // With a mic track attached and the report otherwise unidentifiable, the one report is it.
  const values = [source('S1', 'whatever', loud), outbound('O1', 'S1', { packetsSent: 7, bytesSent: 70 })];
  const withMic = derive(values, { micTrackId: 'some-track' });
  assert.equal(withMic.mic.hasSender, true);
  assert.equal(withMic.mic.level, 0.5);
  assert.equal(withMic.cumulative.micPackets, 7);
  assert.equal(withMic.cumulative.micBytes, 70);

  // With NO mic track, a lone audio report is the shared system audio, not the microphone --
  // reporting it as the mic would show a film's bitrate as "speech detected".
  const withoutMic = derive(values, { micTrackId: null });
  assert.equal(withoutMic.mic.hasSender, false);
  assert.equal(withoutMic.mic.level, null);
});

test('an outbound report whose mid maps to the mic role wins over the track-id match', () => {
  const values = [
    source('S1', 'mic-track', loud),
    { type: 'outbound-rtp', kind: 'audio', id: 'O1', mid: '1', mediaSourceId: 'S1', packetsSent: 1, bytesSent: 10 },
    { type: 'outbound-rtp', kind: 'audio', id: 'O2', mid: '0', packetsSent: 9, bytesSent: 90 },
  ];
  const out = derive(values, { micTrackId: 'mic-track', roleByMid: { 0: 'mic', 1: 'shareAudio' } });
  assert.equal(out.cumulative.micPackets, 9, 'the m-line role is authoritative');
});

test('hasSender is false when there is no outbound audio at all', () => {
  const out = derive(videoNoise(), { micTrackId: 'mic-track' });
  assert.equal(out.mic.hasSender, false);
  assert.equal(out.mic.level, null);
  assert.equal(out.mic.rms, null);
  assert.equal(out.mic.speech, null);
  assert.equal(out.hasInboundAudio, false);
  assert.equal(out.inboundAudioBytes, 0);
  assert.equal(out.remoteAudioLoss, null);
  assert.deepEqual(out.audioIn, {});
});

test('the first call has no interval, so rms and rates are null and speech falls back to audioLevel', () => {
  const values = [source('S1', 't', loud), outbound('O1', 'S1')];
  const out = derive(values, { prev: null, dtSec: null });
  assert.equal(out.mic.rms, null);
  assert.equal(out.mic.energyPerSec, null);
  assert.equal(out.mic.packetsPerSec, null);
  assert.equal(out.mic.speech, true, 'audioLevel 0.5 is speech');

  const quiet = derive([source('S1', 't', { ...loud, audioLevel: 0.001 }), outbound('O1', 'S1')]);
  assert.equal(quiet.mic.speech, false);

  const unknown = derive([
    source('S1', 't', { totalAudioEnergy: 1, totalSamplesDuration: 1 }),
    outbound('O1', 'S1'),
  ]);
  assert.equal(unknown.mic.speech, null, 'no audioLevel and no interval means "cannot tell"');
});

test('the second call computes interval rms, energy per second and packets per second', () => {
  const first = derive([
    source('S1', 't', { audioLevel: 0.3, totalAudioEnergy: 1, totalSamplesDuration: 10 }),
    outbound('O1', 'S1', { packetsSent: 100, bytesSent: 1000 }),
  ]);
  const second = derive(
    [
      source('S1', 't', { audioLevel: 0.3, totalAudioEnergy: 1.08, totalSamplesDuration: 12 }),
      outbound('O1', 'S1', { packetsSent: 200, bytesSent: 2000 }),
    ],
    { prev: first.cumulative, dtSec: 2 },
  );
  // dE = 0.08 over dD = 2 s -> mean square 0.04 -> rms 0.2
  assert.ok(Math.abs(second.mic.rms - 0.2) < 1e-12, `rms ${second.mic.rms}`);
  assert.ok(Math.abs(second.mic.energyPerSec - 0.04) < 1e-12);
  assert.equal(second.mic.packetsPerSec, 50);
  assert.equal(second.mic.speech, true);
});

test('interval rms is capped at 1 and never negative when counters go backwards', () => {
  const prev = { micEnergy: 5, micDuration: 1, micPackets: 10, micBytes: 0, in: {} };
  const up = derive(
    [source('S1', 't', { totalAudioEnergy: 500, totalSamplesDuration: 2 }), outbound('O1', 'S1', { packetsSent: 20 })],
    { prev, dtSec: 1 },
  );
  assert.equal(up.mic.rms, 1);
  const back = derive(
    [source('S1', 't', { totalAudioEnergy: 1, totalSamplesDuration: 2 }), outbound('O1', 'S1', { packetsSent: 3 })],
    { prev, dtSec: 1 },
  );
  assert.equal(back.mic.rms, 0);
  assert.equal(back.mic.energyPerSec, 0);
  assert.equal(back.mic.packetsPerSec, 0);
});

test('rising energy between calls means speech, flat energy means not speech', () => {
  const prev = { micEnergy: 1, micDuration: 10, micPackets: 0, micBytes: 0, in: {} };
  const rising = derive(
    [source('S1', 't', { audioLevel: 0.0001, totalAudioEnergy: 1.5, totalSamplesDuration: 11 }), outbound('O1', 'S1')],
    { prev, dtSec: 1 },
  );
  assert.equal(rising.mic.speech, true, 'interval rms wins over a stale instantaneous level');

  const flat = derive(
    [source('S1', 't', { audioLevel: 0.9, totalAudioEnergy: 1, totalSamplesDuration: 11 }), outbound('O1', 'S1')],
    { prev, dtSec: 1 },
  );
  assert.equal(flat.mic.rms, 0);
  assert.equal(flat.mic.speech, false, 'interval rms wins over a stale instantaneous level');
});

test('speech is held across an ordinary pause and released once the pause is long enough', () => {
  // Energy that stops rising is a person who stopped talking to listen. Reported raw, the panel
  // flipped to "SILENT (mic open, no sound)" a second into every listening turn.
  const speaking = (n) => [
    source('S1', 't', { totalAudioEnergy: n * 0.5, totalSamplesDuration: n }),
    outbound('O1', 'S1'),
  ];
  const paused = (energy, duration) => [
    source('S1', 't', { totalAudioEnergy: energy, totalSamplesDuration: duration }),
    outbound('O1', 'S1'),
  ];

  let out = derive(speaking(1));
  out = derive(speaking(2), { prev: out.cumulative, dtSec: 1 });
  assert.equal(out.mic.speech, true, 'rising energy is speech');

  // Nine seconds of nothing: still counted as speaking, because a pause is not a fault.
  const held = 0.5 * 2;
  for (let second = 1; second <= SPEECH_HOLD_SEC - 1; second += 1) {
    out = derive(paused(held, 2 + second), { prev: out.cumulative, dtSec: 1 });
    assert.equal(out.mic.speech, true, `still held at ${second}s`);
  }

  out = derive(paused(held, 2 + SPEECH_HOLD_SEC), { prev: out.cumulative, dtSec: 1 });
  assert.equal(out.mic.speech, false, 'past the hold, silence is reported');
  assert.equal(out.mic.quietSec, SPEECH_HOLD_SEC);
});

test('a browser that reports no audioLevel and no energies yields null level, rms and speech, never false', () => {
  const values = [source('S1', 't'), outbound('O1', 'S1', { packetsSent: 5 })];
  const first = derive(values);
  assert.equal(first.mic.level, null);
  assert.equal(first.mic.rms, null);
  assert.equal(first.mic.speech, null);
  assert.deepEqual(first.cumulative, {
    micEnergy: null,
    micDuration: null,
    micPackets: 5,
    micBytes: 0,
    micQuietSec: SPEECH_HOLD_SEC,
    in: {},
  });

  const second = derive(values, { prev: first.cumulative, dtSec: 1 });
  assert.equal(second.mic.level, null);
  assert.equal(second.mic.rms, null);
  assert.equal(second.mic.speech, null);
  assert.equal(second.mic.energyPerSec, null);
  assert.equal(second.mic.packetsPerSec, 0);
});

test('an unchanged duration between calls gives null rms rather than a division by zero', () => {
  const prev = { micEnergy: 1, micDuration: 10, micPackets: 0, micBytes: 0, in: {} };
  const out = derive(
    [source('S1', 't', { totalAudioEnergy: 2, totalSamplesDuration: 10 }), outbound('O1', 'S1')],
    { prev, dtSec: 1 },
  );
  assert.equal(out.mic.rms, null);
  assert.equal(out.mic.speech, null);
});

test('inbound audio is keyed by the role mapped from its mid', () => {
  const values = [
    inbound('I0', {
      mid: '0',
      audioLevel: 0.4,
      totalAudioEnergy: 3,
      totalSamplesDuration: 10,
      packetsReceived: 10,
      concealedSamples: 5,
      bytesReceived: 100,
      jitter: 0.0123,
      packetsLost: 2,
    }),
    inbound('I1', { mid: '2', audioLevel: 0.001, bytesReceived: 50 }),
  ];
  const out = derive(values, { roleByMid: { 0: 'mic', 2: 'share' } });
  assert.deepEqual(Object.keys(out.audioIn).sort(), ['mic', 'share']);
  assert.equal(out.hasInboundAudio, true);
  assert.equal(out.inboundAudioBytes, 150);
  assert.deepEqual(out.audioIn.mic, {
    mid: '0',
    bps: null,
    level: 0.4,
    rms: null,
    energyPerSec: null,
    packetsPerSec: null,
    concealedPerSec: null,
    jitterMs: 12,
    packetsLost: 2,
    speech: true,
  });
  assert.equal(out.audioIn.share.speech, false);
  assert.equal(out.audioIn.share.jitterMs, null);
  assert.equal(out.audioIn.share.packetsLost, null);
  assert.deepEqual(out.cumulative.in, {
    mic: { energy: 3, duration: 10, packets: 10, concealed: 5, bytes: 100 },
    share: { energy: null, duration: null, packets: null, concealed: null, bytes: 50 },
  });
});

test('a sole inbound audio stream whose mid is not mapped is taken as the microphone', () => {
  const out = derive([inbound('I0', { mid: '3', audioLevel: 0.2 })], { roleByMid: {} });
  assert.deepEqual(Object.keys(out.audioIn), ['mic']);
  assert.equal(out.audioIn.mic.mid, '3');
});

test('several unmapped inbound audio streams are keyed by their mid', () => {
  const out = derive([inbound('I0', { mid: '1' }), inbound('I1', { mid: '4' })], { roleByMid: {} });
  assert.deepEqual(Object.keys(out.audioIn).sort(), ['mid:1', 'mid:4']);
  assert.equal(out.audioIn['mid:4'].mid, '4');
  assert.equal(out.audioIn['mid:4'].speech, null);
});

test('a mapped mid wins over the sole-stream fallback', () => {
  const out = derive([inbound('I0', { mid: '5' })], { roleByMid: { 5: 'share' } });
  assert.deepEqual(Object.keys(out.audioIn), ['share']);
});

test('inbound rates are computed against the previous snapshot for the same role', () => {
  const first = derive(
    [
      inbound('I0', {
        mid: '0',
        totalAudioEnergy: 1,
        totalSamplesDuration: 10,
        packetsReceived: 100,
        concealedSamples: 480,
        bytesReceived: 1000,
      }),
    ],
    { roleByMid: { 0: 'mic' } },
  );
  const second = derive(
    [
      inbound('I0', {
        mid: '0',
        totalAudioEnergy: 1.5,
        totalSamplesDuration: 12,
        packetsReceived: 150,
        concealedSamples: 960,
        bytesReceived: 3000,
        jitter: 0.0305,
      }),
    ],
    { roleByMid: { 0: 'mic' }, prev: first.cumulative, dtSec: 2 },
  );
  const rx = second.audioIn.mic;
  assert.equal(rx.bps, 8000);
  assert.ok(Math.abs(rx.rms - 0.5) < 1e-12, `rms ${rx.rms}`);
  assert.equal(rx.energyPerSec, 0.25);
  assert.equal(rx.packetsPerSec, 25);
  assert.equal(rx.concealedPerSec, 240);
  assert.equal(rx.jitterMs, 31, 'jitter is rounded to whole milliseconds');
  assert.equal(rx.speech, true);
});

test('a role absent from the previous snapshot starts over with null rates', () => {
  const prev = {
    micEnergy: null,
    micDuration: null,
    micPackets: null,
    micBytes: 0,
    in: { share: { energy: 1, duration: 1, packets: 1, concealed: 0, bytes: 1 } },
  };
  const out = derive([inbound('I0', { mid: '0', bytesReceived: 500, packetsReceived: 9 })], {
    roleByMid: { 0: 'mic' },
    prev,
    dtSec: 1,
  });
  assert.equal(out.audioIn.mic.bps, null);
  assert.equal(out.audioIn.mic.packetsPerSec, null);
  assert.equal(out.audioIn.mic.concealedPerSec, null);
  assert.deepEqual(Object.keys(out.cumulative.in), ['mic'], 'the snapshot only carries roles seen in this report');
});

test('remote-inbound-rtp audio becomes the remoteAudioLoss fields, rounded to milliseconds', () => {
  const full = derive([remoteInbound({ packetsLost: 4, jitter: 0.0016, roundTripTime: 0.0455, fractionLost: 0.03 })]);
  assert.deepEqual(full.remoteAudioLoss, { packetsLost: 4, jitterMs: 2, roundTripMs: 46, fractionLost: 0.03 });

  const sparse = derive([remoteInbound()]);
  assert.deepEqual(sparse.remoteAudioLoss, { packetsLost: null, jitterMs: null, roundTripMs: null, fractionLost: null });

  const video = derive([{ type: 'remote-inbound-rtp', kind: 'video', id: 'RV', packetsLost: 9 }]);
  assert.equal(video.remoteAudioLoss, null);
});

test('the cumulative snapshot can be fed straight back in as prev on the next call', () => {
  const report = (n) => [
    source('S1', 't', { totalAudioEnergy: n, totalSamplesDuration: n * 10 }),
    outbound('O1', 'S1', { packetsSent: n * 50, bytesSent: n * 1000 }),
    inbound('I0', {
      mid: '0',
      totalAudioEnergy: n * 2,
      totalSamplesDuration: n * 10,
      packetsReceived: n * 50,
      concealedSamples: n,
      bytesReceived: n * 100,
    }),
  ];
  let prev = null;
  let out = null;
  for (let n = 1; n <= 3; n += 1) {
    out = derive(report(n), { roleByMid: { 0: 'mic' }, prev, dtSec: 1 });
    assert.deepEqual(Object.keys(out.cumulative).sort(), [
      'in',
      'micBytes',
      'micDuration',
      'micEnergy',
      'micPackets',
      'micQuietSec',
    ]);
    prev = out.cumulative;
  }
  assert.equal(out.mic.packetsPerSec, 50);
  assert.ok(Math.abs(out.mic.rms - Math.sqrt(0.1)) < 1e-12);
  assert.equal(out.audioIn.mic.packetsPerSec, 50);
  assert.equal(out.audioIn.mic.concealedPerSec, 1);
  assert.equal(out.audioIn.mic.bps, 800);
});

test('a non-positive or missing dtSec disables every rate but leaves rms alone', () => {
  const prev = {
    micEnergy: 1,
    micDuration: 10,
    micPackets: 0,
    micBytes: 0,
    in: { mic: { energy: 0, duration: 0, packets: 0, concealed: 0, bytes: 0 } },
  };
  const values = [
    source('S1', 't', { totalAudioEnergy: 2, totalSamplesDuration: 11 }),
    outbound('O1', 'S1', { packetsSent: 50 }),
    inbound('I0', {
      mid: '0',
      totalAudioEnergy: 1,
      totalSamplesDuration: 1,
      packetsReceived: 5,
      concealedSamples: 5,
      bytesReceived: 5,
    }),
  ];
  for (const dtSec of [0, -1, null, undefined, NaN, Infinity]) {
    const out = derive(values, { roleByMid: { 0: 'mic' }, prev, dtSec });
    assert.equal(out.mic.energyPerSec, null, `dtSec=${dtSec}`);
    assert.equal(out.mic.packetsPerSec, null, `dtSec=${dtSec}`);
    assert.equal(out.mic.rms, 1, 'rms comes from the report durations, not dtSec');
    assert.equal(out.audioIn.mic.bps, null, `dtSec=${dtSec}`);
    assert.equal(out.audioIn.mic.packetsPerSec, null, `dtSec=${dtSec}`);
    assert.equal(out.audioIn.mic.concealedPerSec, null, `dtSec=${dtSec}`);
    assert.equal(out.audioIn.mic.rms, 1);
  }
});

test('calling with no options at all works', () => {
  const out = derive([]);
  assert.equal(out.mic.hasSender, false);
  assert.deepEqual(out.audioIn, {});
});
