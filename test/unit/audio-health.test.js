import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH,
  SEVERITY,
  HOLD_MS,
  SILENT_LEVEL,
  createHealthTracker,
  deriveAudioHealth,
} from '../../public/js/media/audio-health.js';
import { SPEAKING_THRESHOLD } from '../../public/js/media/level-meter.js';

const SPEECH = 0.3; // clearly above SPEAKING_THRESHOLD
const QUIET = 0.03; // above SILENT_LEVEL, below SPEAKING_THRESHOLD

/**
 * A connected peer that carries our microphone and, optionally, reports what it hears.
 *
 * `micRms` is OUR microphone as that connection's encoder saw it -- the second witness the
 * silence rule needs. It defaults to null (not measured), which is why a peer built with the
 * bare helper cannot on its own convict the microphone of silence.
 */
const peer = (over = {}) => ({
  id: 'p1',
  name: 'Bob',
  pcState: 'connected',
  hasMicSender: true,
  micRms: null,
  hearsMe: null,
  ...over,
});

/** A peer whose encoder agrees with a silent meter: the pair that makes CAPTURE_SILENT possible. */
const encoderSilent = (over = {}) => peer({ micRms: 0, ...over });

const hears = (level, at, playing) => ({ level, at, ...(playing === undefined ? {} : { playing }) });

/** Run the same snapshot at each of the given times and return the last verdict. */
function runAt(snapshot, times, tracker = createHealthTracker()) {
  let out;
  for (const t of times) out = deriveAudioHealth(snapshot, tracker, t);
  return out;
}

const LONG = 60_000; // longer than every hold in HOLD_MS

/** Minimal snapshot per code. Each is mergeable with the others for the precedence tests. */
const CASES = {
  [HEALTH.MIC_ERROR]: { self: { micError: 'NotAllowedError', micAvailable: false } },
  [HEALTH.ENGINE_SUSPENDED]: { meter: { contextState: 'suspended', level: SPEECH } },
  [HEALTH.TRACK_ENDED]: { meter: { contextState: 'running', reason: 'track-ended', level: SPEECH } },
  [HEALTH.SOURCE_MUTED]: { self: { micSourceMuted: true }, meter: { contextState: 'running', level: SPEECH } },
  [HEALTH.CAPTURE_SILENT]: {
    self: { micMuted: false, lobbyPeak: 0.4 },
    meter: { contextState: 'running', level: 0 },
    peers: [encoderSilent()],
  },
  [HEALTH.NOT_ATTACHED]: {
    meter: { contextState: 'running', level: SPEECH },
    peers: [peer({ id: 'd', name: 'Dana', hasMicSender: false })],
  },
  [HEALTH.UNHEARD_PLAYBACK]: {
    self: { micMuted: false },
    meter: { contextState: 'running', level: SPEECH },
    peers: [peer({ id: 'u', name: 'Uma', hearsMe: hears(0, LONG, false) })],
  },
  [HEALTH.UNHEARD_TRANSPORT]: {
    self: { micMuted: false },
    meter: { contextState: 'running', level: SPEECH },
    peers: [peer({ id: 'u', name: 'Uma', hearsMe: hears(0, LONG, true) })],
  },
  [HEALTH.TALKING_WHILE_MUTED]: { self: { micMuted: true }, meter: { contextState: 'running', level: SPEECH } },
  [HEALTH.HEARD]: {
    self: { micMuted: false },
    meter: { contextState: 'running', level: SPEECH },
    peers: [peer({ id: 'h', name: 'Hana', hearsMe: hears(0.2, LONG) })],
  },
};

/** Shallow merge; fields in b win. */
const merge = (a, b) => ({
  self: { ...(a.self ?? {}), ...(b.self ?? {}) },
  meter: a.meter || b.meter ? { ...(a.meter ?? {}), ...(b.meter ?? {}) } : null,
  peers: [...(a.peers ?? []), ...(b.peers ?? [])],
});

test('constants agree with the level meter', () => {
  assert.ok(SILENT_LEVEL < SPEAKING_THRESHOLD);
  assert.ok(QUIET > SILENT_LEVEL && QUIET < SPEAKING_THRESHOLD);
  assert.ok(SPEECH > SPEAKING_THRESHOLD);
  assert.ok(LONG > Math.max(...Object.values(HOLD_MS)));
});

for (const [code, snapshot] of Object.entries(CASES)) {
  test(`the minimal snapshot for ${code} yields ${code} with its severity once held long enough`, () => {
    const out = runAt(snapshot, [0, LONG]);
    assert.equal(out.code, code);
    assert.equal(out.severity, SEVERITY[code]);
  });
}

test('an empty snapshot is OK with no severity and reports the first verdict as changed', () => {
  const tracker = createHealthTracker();
  const first = deriveAudioHealth({}, tracker, 0);
  assert.deepEqual(first, { code: HEALTH.OK, severity: null, params: {}, changed: true });
  const second = deriveAudioHealth({}, tracker, 100);
  assert.equal(second.changed, false);
});

test('MIC_ERROR needs both an error and an unavailable microphone', () => {
  assert.equal(runAt({ self: { micError: 'x', micAvailable: true } }, [0]).code, HEALTH.OK);
  assert.equal(runAt({ self: { micAvailable: false } }, [0]).code, HEALTH.OK);
  const out = runAt({ self: { micError: 'boom', micAvailable: false } }, [0]);
  assert.equal(out.code, HEALTH.MIC_ERROR);
  assert.deepEqual(out.params, { error: 'boom' });
});

test('ENGINE_SUSPENDED fires immediately for any non-running context state of a live meter', () => {
  assert.equal(runAt({ meter: { contextState: 'interrupted' } }, [0]).code, HEALTH.ENGINE_SUSPENDED);
  assert.equal(runAt({ meter: { contextState: 'running', level: SPEECH } }, [0]).code, HEALTH.OK);
});

test('TRACK_ENDED and SOURCE_MUTED carry the microphone label', () => {
  const self = { micLabel: 'USB Mic' };
  const ended = runAt({ self, meter: { dead: true } }, [0]);
  assert.equal(ended.code, HEALTH.TRACK_ENDED);
  assert.deepEqual(ended.params, { label: 'USB Mic' });

  const muted = runAt({ self, meter: { reason: 'source-muted', level: SPEECH } }, [0]);
  assert.equal(muted.code, HEALTH.SOURCE_MUTED);
  assert.deepEqual(muted.params, { label: 'USB Mic' });

  assert.equal(runAt({ self, meter: { health: 'source-muted', level: SPEECH } }, [0]).code, HEALTH.SOURCE_MUTED);
});

test('CAPTURE_SILENT requires HOLD_MS.CAPTURE_SILENT of unmuted silence', () => {
  const snap = CASES[HEALTH.CAPTURE_SILENT];
  const tracker = createHealthTracker();
  assert.equal(deriveAudioHealth(snap, tracker, 0).code, HEALTH.OK);
  assert.equal(deriveAudioHealth(snap, tracker, HOLD_MS.CAPTURE_SILENT - 1).code, HEALTH.OK);
  const out = deriveAudioHealth(snap, tracker, HOLD_MS.CAPTURE_SILENT);
  assert.equal(out.code, HEALTH.CAPTURE_SILENT);
  assert.equal(out.severity, 'warn');
  assert.deepEqual(out.params, { label: '', lobbyWorked: true });
});

test('CAPTURE_SILENT reports lobbyWorked=false when the lobby never saw speech', () => {
  const out = runAt({ self: { micMuted: false }, meter: { level: 0 }, peers: [encoderSilent()] }, [0, LONG]);
  assert.equal(out.code, HEALTH.CAPTURE_SILENT);
  assert.equal(out.params.lobbyWorked, false);
});

test('the silence timer restarts when sound is detected in between', () => {
  const tracker = createHealthTracker();
  const silent = { self: { micMuted: false }, meter: { level: 0 }, peers: [encoderSilent()] };
  deriveAudioHealth(silent, tracker, 0);
  deriveAudioHealth({ self: { micMuted: false }, meter: { level: QUIET }, peers: [encoderSilent()] }, tracker, 4000);
  deriveAudioHealth(silent, tracker, 5000);
  assert.equal(deriveAudioHealth(silent, tracker, 5000 + HOLD_MS.CAPTURE_SILENT - 1).code, HEALTH.OK);
  assert.equal(deriveAudioHealth(silent, tracker, 5000 + HOLD_MS.CAPTURE_SILENT).code, HEALTH.CAPTURE_SILENT);
});

test('a muted user is never CAPTURE_SILENT', () => {
  const out = runAt({ self: { micMuted: true }, meter: { level: 0 }, peers: [encoderSilent()] }, [0, LONG, 2 * LONG]);
  assert.equal(out.code, HEALTH.OK);
});

test('an unavailable microphone is not CAPTURE_SILENT either', () => {
  const snap = { self: { micMuted: false, micAvailable: false }, meter: { level: 0 }, peers: [encoderSilent()] };
  assert.equal(runAt(snap, [0, LONG]).code, HEALTH.OK);
});

test('a silent meter alone is not enough: the encoder has to agree', () => {
  // The meter watches a CLONE of the microphone. A clone that dies -- which is what Windows
  // does under a second consumer of the same endpoint -- reads a flat zero while the track
  // being sent is fine, and this used to be the whole basis of the verdict.
  const meterOnly = { self: { micMuted: false }, meter: { level: 0 }, peers: [peer()] };
  assert.equal(runAt(meterOnly, [0, LONG, 2 * LONG]).code, HEALTH.OK);

  const contradicted = { self: { micMuted: false }, meter: { level: 0 }, peers: [peer({ micRms: 0.2 })] };
  assert.equal(runAt(contradicted, [0, LONG, 2 * LONG]).code, HEALTH.OK);
});

test('alone in the room, silence raises nothing: there is no encoder to corroborate it', () => {
  const alone = { self: { micMuted: false }, meter: { level: 0 }, peers: [] };
  assert.equal(runAt(alone, [0, LONG, 2 * LONG]).code, HEALTH.OK);
});

test('a missing meter reads as unknown, not as silence', () => {
  // `meter: null` is what a device switch leaves behind for a moment, and what a meter that
  // failed to build leaves behind for good.
  const noMeter = { self: { micMuted: false }, peers: [encoderSilent()] };
  assert.equal(runAt(noMeter, [0, LONG, 2 * LONG]).code, HEALTH.OK);
});

test('CAPTURE_SILENT is suppressed when a fresh peer report says it hears us', () => {
  const snap = {
    self: { micMuted: false },
    meter: { level: 0 },
    peers: [peer({ hearsMe: hears(SILENT_LEVEL, LONG) })],
  };
  const out = runAt(snap, [0, LONG]);
  // The local meter is silent so we never "spoke"; nothing else applies, but a peer hears us.
  assert.equal(out.code, HEALTH.HEARD);
  assert.deepEqual(out.params, { name: 'Bob', level: SILENT_LEVEL });
});

test('a peer report that is barely too quiet does not suppress CAPTURE_SILENT', () => {
  const snap = {
    self: { micMuted: false },
    meter: { level: 0 },
    peers: [encoderSilent({ hearsMe: hears(SILENT_LEVEL / 2, LONG) })],
  };
  assert.equal(runAt(snap, [0, LONG]).code, HEALTH.CAPTURE_SILENT);
});

test('being heard recently suppresses CAPTURE_SILENT through the pauses that follow', () => {
  // The regression this exists for: a peer's report says what they heard in the LAST SECOND,
  // so it empties every time you stop talking to listen. Without the latch the banner appeared
  // in the middle of a working conversation.
  const tracker = createHealthTracker();
  const heard = {
    self: { micMuted: false },
    meter: { level: 0 },
    peers: [encoderSilent({ hearsMe: hears(0.2, 0) })],
  };
  deriveAudioHealth(heard, tracker, 0);

  // From now on nobody reports hearing anything -- an ordinary listening turn.
  const quiet = (at) => ({
    self: { micMuted: false },
    meter: { level: 0 },
    peers: [encoderSilent({ hearsMe: hears(0, at) })],
  });
  const inPause = HOLD_MS.CAPTURE_SILENT + 1000;
  assert.ok(inPause < HOLD_MS.HEARD_RECENT, 'the pause is inside the latch, which is the point');
  assert.equal(deriveAudioHealth(quiet(inPause), tracker, inPause).code, HEALTH.OK);

  // Past the latch with still nothing heard, the verdict is allowed through again.
  const past = HOLD_MS.HEARD_RECENT + 1;
  assert.equal(deriveAudioHealth(quiet(past), tracker, past).code, HEALTH.CAPTURE_SILENT);
});

test('a stale hearsMe report neither suppresses CAPTURE_SILENT nor counts as HEARD', () => {
  const at = LONG - HOLD_MS.REPORT_FRESH - 1;
  const silentSnap = { self: { micMuted: false }, meter: { level: 0 }, peers: [encoderSilent({ hearsMe: hears(0.5, at) })] };
  assert.equal(runAt(silentSnap, [0, LONG]).code, HEALTH.CAPTURE_SILENT);

  const talkingSnap = { self: { micMuted: false }, meter: { level: SPEECH }, peers: [peer({ hearsMe: hears(0.5, at) })] };
  assert.equal(runAt(talkingSnap, [0, LONG]).code, HEALTH.OK);
});

test('a stale silent report does not make us UNHEARD', () => {
  const at = LONG - HOLD_MS.REPORT_FRESH - 1;
  const snap = { self: { micMuted: false }, meter: { level: SPEECH }, peers: [peer({ hearsMe: hears(0, at, false) })] };
  assert.equal(runAt(snap, [0, LONG]).code, HEALTH.OK);
});

test('a report exactly HOLD_MS.REPORT_FRESH old is still fresh', () => {
  const snap = {
    self: { micMuted: false },
    meter: { level: SPEECH },
    peers: [peer({ hearsMe: hears(0.5, LONG - HOLD_MS.REPORT_FRESH) })],
  };
  assert.equal(runAt(snap, [LONG]).code, HEALTH.HEARD);
});

test('NOT_ATTACHED waits HOLD_MS.NOT_ATTACHED and names the peer without our sender', () => {
  const snap = CASES[HEALTH.NOT_ATTACHED];
  const tracker = createHealthTracker();
  assert.equal(deriveAudioHealth(snap, tracker, 0).code, HEALTH.OK);
  assert.equal(deriveAudioHealth(snap, tracker, HOLD_MS.NOT_ATTACHED - 1).code, HEALTH.OK);
  const out = deriveAudioHealth(snap, tracker, HOLD_MS.NOT_ATTACHED);
  assert.equal(out.code, HEALTH.NOT_ATTACHED);
  assert.deepEqual(out.params, { name: 'Dana' });
});

test('a peer that is not connected cannot be NOT_ATTACHED', () => {
  const snap = { meter: { level: SPEECH }, peers: [peer({ pcState: 'connecting', hasMicSender: false })] };
  assert.equal(runAt(snap, [0, LONG]).code, HEALTH.OK);
});

test('UNHEARD_PLAYBACK when the peer reports playing===false, else UNHEARD_TRANSPORT', () => {
  const tracker = createHealthTracker();
  const playback = CASES[HEALTH.UNHEARD_PLAYBACK];
  assert.equal(deriveAudioHealth(playback, tracker, 0).code, HEALTH.OK);
  assert.equal(deriveAudioHealth(playback, tracker, HOLD_MS.UNHEARD - 1).code, HEALTH.OK);
  const out = deriveAudioHealth(playback, tracker, HOLD_MS.UNHEARD);
  assert.equal(out.code, HEALTH.UNHEARD_PLAYBACK);
  assert.deepEqual(out.params, { name: 'Uma' });

  const transport = runAt(CASES[HEALTH.UNHEARD_TRANSPORT], [0, HOLD_MS.UNHEARD]);
  assert.equal(transport.code, HEALTH.UNHEARD_TRANSPORT);

  const noPlayingField = {
    self: { micMuted: false },
    meter: { level: SPEECH },
    peers: [peer({ hearsMe: hears(0, LONG) })],
  };
  assert.equal(runAt(noPlayingField, [0, HOLD_MS.UNHEARD]).code, HEALTH.UNHEARD_TRANSPORT);
});

test('UNHEARD only applies while we have spoken recently', () => {
  // Quiet but not silent: no CAPTURE_SILENT, and never above the speaking threshold.
  const snap = { self: { micMuted: false }, meter: { level: QUIET }, peers: [peer({ hearsMe: hears(0, LONG, false) })] };
  assert.equal(runAt(snap, [0, LONG]).code, HEALTH.OK);
});

test('UNHEARD lapses once the last speech is older than HOLD_MS.SPEAKING_RECENT', () => {
  const tracker = createHealthTracker();
  const talking = CASES[HEALTH.UNHEARD_TRANSPORT];
  deriveAudioHealth(talking, tracker, 0);
  assert.equal(deriveAudioHealth(talking, tracker, HOLD_MS.UNHEARD).code, HEALTH.UNHEARD_TRANSPORT);

  const quiet = { ...talking, meter: { level: QUIET } };
  const still = HOLD_MS.UNHEARD + HOLD_MS.SPEAKING_RECENT;
  assert.equal(deriveAudioHealth(quiet, tracker, still).code, HEALTH.UNHEARD_TRANSPORT, 'still within recent speech');
  // Past the speaking window and past the SHOW hold: back to OK.
  const later = still + Math.max(1, HOLD_MS.SHOW);
  assert.equal(deriveAudioHealth(quiet, tracker, later).code, HEALTH.OK);
});

test('a muted user is never UNHEARD', () => {
  const snap = { self: { micMuted: true }, meter: { level: QUIET }, peers: [peer({ hearsMe: hears(0, LONG, false) })] };
  assert.equal(runAt(snap, [0, LONG]).code, HEALTH.OK);
});

test('one peer hearing us cancels another peer not hearing us', () => {
  const snap = {
    self: { micMuted: false },
    meter: { level: SPEECH },
    peers: [
      peer({ id: 'a', name: 'Deaf', hearsMe: hears(0, LONG, false) }),
      peer({ id: 'b', name: 'Hears', hearsMe: hears(0.3, LONG, true) }),
    ],
  };
  const out = runAt(snap, [0, LONG]);
  assert.equal(out.code, HEALTH.HEARD);
  assert.equal(out.params.name, 'Hears');
});

test('TALKING_WHILE_MUTED waits HOLD_MS.TALKING_WHILE_MUTED of speech while muted', () => {
  const snap = CASES[HEALTH.TALKING_WHILE_MUTED];
  const tracker = createHealthTracker();
  assert.equal(deriveAudioHealth(snap, tracker, 0).code, HEALTH.OK);
  assert.equal(deriveAudioHealth(snap, tracker, HOLD_MS.TALKING_WHILE_MUTED - 1).code, HEALTH.OK);
  const out = deriveAudioHealth(snap, tracker, HOLD_MS.TALKING_WHILE_MUTED);
  assert.equal(out.code, HEALTH.TALKING_WHILE_MUTED);
  assert.equal(out.severity, 'warn');
});

test('HEARD is immediate and names the peer and its level', () => {
  const out = runAt(CASES[HEALTH.HEARD], [0]);
  assert.equal(out.code, HEALTH.HEARD);
  assert.equal(out.severity, 'ok');
  assert.deepEqual(out.params, { name: 'Hana', level: 0.2 });
});

test('HEARD is not shown to a muted user', () => {
  const snap = merge(CASES[HEALTH.HEARD], { self: { micMuted: true }, meter: { level: QUIET } });
  assert.equal(runAt(snap, [0, LONG]).code, HEALTH.OK);
});

// Precedence: each pair (winner, loser) merged into one snapshot yields the winner.
const PRECEDENCE = [
  [HEALTH.MIC_ERROR, HEALTH.ENGINE_SUSPENDED],
  [HEALTH.MIC_ERROR, HEALTH.HEARD],
  [HEALTH.ENGINE_SUSPENDED, HEALTH.TRACK_ENDED],
  [HEALTH.ENGINE_SUSPENDED, HEALTH.SOURCE_MUTED],
  [HEALTH.TRACK_ENDED, HEALTH.SOURCE_MUTED],
  [HEALTH.TRACK_ENDED, HEALTH.NOT_ATTACHED],
  [HEALTH.SOURCE_MUTED, HEALTH.CAPTURE_SILENT],
  [HEALTH.SOURCE_MUTED, HEALTH.HEARD],
  [HEALTH.CAPTURE_SILENT, HEALTH.NOT_ATTACHED],
  [HEALTH.NOT_ATTACHED, HEALTH.UNHEARD_PLAYBACK],
  [HEALTH.NOT_ATTACHED, HEALTH.UNHEARD_TRANSPORT],
  [HEALTH.NOT_ATTACHED, HEALTH.TALKING_WHILE_MUTED],
  [HEALTH.NOT_ATTACHED, HEALTH.HEARD],
];

for (const [winner, loser] of PRECEDENCE) {
  test(`${winner} beats ${loser}`, () => {
    // Sanity: the loser alone produces itself under the same schedule.
    assert.equal(runAt(CASES[loser], [0, LONG]).code, loser);
    assert.equal(runAt(merge(CASES[loser], CASES[winner]), [0, LONG]).code, winner);
  });
}

test('UNHEARD_* beats TALKING_WHILE_MUTED and HEARD by construction: they are mutually exclusive', () => {
  // UNHEARD requires an unmuted user with no peer hearing them; TALKING_WHILE_MUTED requires a
  // muted user and HEARD requires a peer that hears. The order of the rules is therefore only
  // observable through NOT_ATTACHED, which is covered above.
  const unheardThenMuted = merge(CASES[HEALTH.UNHEARD_TRANSPORT], { self: { micMuted: true } }); // later wins
  assert.equal(runAt(unheardThenMuted, [0, LONG]).code, HEALTH.TALKING_WHILE_MUTED);
});

test('the SHOW hold keeps a warn verdict for HOLD_MS.SHOW after the condition clears, unchanged', () => {
  const tracker = createHealthTracker();
  const silent = CASES[HEALTH.CAPTURE_SILENT];
  deriveAudioHealth(silent, tracker, 0);
  const shown = deriveAudioHealth(silent, tracker, HOLD_MS.CAPTURE_SILENT);
  assert.equal(shown.code, HEALTH.CAPTURE_SILENT);
  assert.equal(shown.changed, true);

  const t0 = HOLD_MS.CAPTURE_SILENT;
  const talking = { self: { micMuted: false }, meter: { level: SPEECH } };
  const held = deriveAudioHealth(talking, tracker, t0 + HOLD_MS.SHOW - 1);
  assert.equal(held.code, HEALTH.CAPTURE_SILENT);
  assert.equal(held.severity, 'warn');
  assert.deepEqual(held.params, shown.params);
  assert.equal(held.changed, false);

  const cleared = deriveAudioHealth(talking, tracker, t0 + HOLD_MS.SHOW);
  assert.equal(cleared.code, HEALTH.OK);
  assert.equal(cleared.severity, null);
  assert.equal(cleared.changed, true);
  assert.equal(deriveAudioHealth(talking, tracker, t0 + HOLD_MS.SHOW + 1).changed, false);
});

test('the SHOW hold keeps a danger verdict when a less severe one arrives', () => {
  const tracker = createHealthTracker();
  deriveAudioHealth(CASES[HEALTH.TRACK_ENDED], tracker, 0);
  const out = deriveAudioHealth(CASES[HEALTH.ENGINE_SUSPENDED], tracker, HOLD_MS.SHOW - 1);
  assert.equal(out.code, HEALTH.TRACK_ENDED);
  assert.equal(out.changed, false);
  const later = deriveAudioHealth(CASES[HEALTH.ENGINE_SUSPENDED], tracker, HOLD_MS.SHOW);
  assert.equal(later.code, HEALTH.ENGINE_SUSPENDED);
  assert.equal(later.changed, true);
});

test('the SHOW hold keeps the current verdict against one of equal severity', () => {
  const tracker = createHealthTracker();
  deriveAudioHealth(CASES[HEALTH.MIC_ERROR], tracker, 0);
  const out = deriveAudioHealth(CASES[HEALTH.TRACK_ENDED], tracker, 1);
  assert.equal(out.code, HEALTH.MIC_ERROR);
  assert.equal(out.changed, false);
});

test('a more severe verdict replaces a held one immediately', () => {
  const tracker = createHealthTracker();
  const silent = CASES[HEALTH.CAPTURE_SILENT];
  deriveAudioHealth(silent, tracker, 0);
  assert.equal(deriveAudioHealth(silent, tracker, HOLD_MS.CAPTURE_SILENT).code, HEALTH.CAPTURE_SILENT);
  const out = deriveAudioHealth(CASES[HEALTH.MIC_ERROR], tracker, HOLD_MS.CAPTURE_SILENT + 1);
  assert.equal(out.code, HEALTH.MIC_ERROR);
  assert.equal(out.severity, 'danger');
  assert.equal(out.changed, true);
  assert.deepEqual(out.params, { error: 'NotAllowedError' });
});

test('the hold is measured from when the verdict was first shown, not from its last repeat', () => {
  const tracker = createHealthTracker();
  deriveAudioHealth(CASES[HEALTH.TRACK_ENDED], tracker, 0);
  deriveAudioHealth(CASES[HEALTH.TRACK_ENDED], tracker, HOLD_MS.SHOW - 1);
  const out = deriveAudioHealth({}, tracker, HOLD_MS.SHOW);
  assert.equal(out.code, HEALTH.OK);
  assert.equal(out.changed, true);
});

test('changed is true only when the shown code differs from the previous shown code', () => {
  const tracker = createHealthTracker();
  const a = deriveAudioHealth(CASES[HEALTH.HEARD], tracker, 0);
  const b = deriveAudioHealth(CASES[HEALTH.HEARD], tracker, 1);
  const c = deriveAudioHealth({ ...CASES[HEALTH.HEARD], peers: [peer({ name: 'Other', hearsMe: hears(0.9, 2) })] }, tracker, 2);
  assert.equal(a.changed, true);
  assert.equal(b.changed, false);
  assert.equal(c.changed, false, 'same code with different params is not a change');
  assert.deepEqual(c.params, { name: 'Other', level: 0.9 });
});
