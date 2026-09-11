# Audio diagnostics reference

This is the reference for everything the room shows, logs and copies about audio. It exists because three reports of "nobody can hear me" could not be resolved from bitrates alone: a muted microphone and a microphone that delivers digital silence both produce ~14 kbps of Opus. Every readout below measures **sound**, not bytes, and every verdict names the thing to change.

The five root causes these tools were built to expose:

1. **Hearing your own voice while muted is never this app.** The app sends nothing while muted and never plays your microphone back to you. It is Windows *Listen to this device* (Sound > Recording > mic > Properties > Listen), headset/driver sidetone (Realtek input monitoring, SteelSeries Sonar, Logitech G Hub, iCUE, Voicemeeter, NVIDIA Broadcast), or Bluetooth HFP sidetone that engages whenever any app holds the mic. Confirm by closing the app: the voice persists. Echo cancellation cannot fix it, it only affects the signal that is sent.
2. **A microphone that is open but silent.** Most often the capture device is **muted in Windows** (the keyboard's mic-mute key, or Sound > Input > device > mute): `getUserMedia` still succeeds, but Chromium mirrors the endpoint mute onto `track.muted` within a second, so the page sees it and names it at once — lobby state `os-muted`, room verdict `SOURCE_MUTED` (see *The lobby check* in section 1). What the page cannot see by any flag is a capture gated below the endpoint (an APO or hardware mute, input volume 0) that delivers real near-zero samples with `muted: false`; for that the six-second `silent` / eight-second `CAPTURE_SILENT` fallbacks exist. Otherwise: Windows' default (console) device is not the headset (the Default *Communication* Device), a hardware mute switch, Settings > System > Sound > Volume mixer > per-app input device, or Settings > Privacy & security > Microphone > *Let desktop apps access your microphone* (that last one makes `getUserMedia` fail outright, shown as "could not be opened").
3. The old in-room level meter existed only inside the fullscreen overlay, so nobody saw the bar not moving.
4. Bytes and kbps prove nothing; the readouts below use `totalAudioEnergy`.
5. Echo only during system-audio sharing may be digital loopback on older versions: update the sharing participant to 1.5.1+, or untick *Share system audio*. Headphones do not remove digital loopback.

Sources of truth: `public/js/media/audio-health.js`, `public/js/stats/stats-collector.js`, `public/js/rtc/diag-channel.js`, `public/js/main-room.js`, `public/js/ui/audio-strings.js`, `public/js/ui/room-view.js`, `public/js/media/level-meter.js`.

---

## 1. The level bars

There are three bars in the room (inside the Mute button, in the self tile, in the fullscreen overlay) plus one on the lobby and one in each of Audio check steps 1–3. All are painted by the same function from the same meter. The meter runs on a **clone** of the mic track that stays enabled while muted, on a `setInterval` (not `requestAnimationFrame`, so a hidden window does not freeze it).

Width is `sqrt(level) * 130 %` (capped at 100) so speech is visible; a dead meter is drawn at 0.

| Colour | CSS class | Meaning | What it proves |
|---|---|---|---|
| Green (`--ok`) | `.meter__fill` | Live, unmuted. | The device the browser opened delivers sound when the bar moves. |
| Amber (`--warn`) | `.meter__fill--muted` | You are muted and the bar is moving. | You are talking and nobody can hear you. The clone still carries sound; the sent track does not. |
| Red (`--danger`) | `.meter__fill--dead` | The meter is dead: the track or its clone ended. | Nothing will ever arrive from this track; re-acquire or pick another device. |

A flat green bar while you speak is the "capture silent" case (root cause 2). A flat bar can also be a suspended AudioContext; that is reported separately as meter health `suspended` and verdict `ENGINE_SUSPENDED`.

Meter health (`level-meter.js`, `meterHealth()`), reported via `onState` and `state()`:

| health | Rule |
|---|---|
| `dead` | `dead` flag, or track/clone `readyState === 'ended'` |
| `source-muted` | track or clone `muted === true`: the capture endpoint is muted in Windows (Chromium polls the OS mute state once a second and mirrors it onto the track) |
| `suspended` | AudioContext state is not `running` |
| `running` | otherwise |

Thresholds: `SPEAKING_THRESHOLD = 0.05` (level-meter.js) means "speech"; `SILENT_LEVEL = 0.01` (audio-health.js) and `MIC_SPEECH_RMS = 0.01` (stats-collector.js) mean "no sound". Room tone with noise suppression sits at 0.001-0.004.

### The lobby check (`mic-check.js`)

`startMicCheck()` opens the device with the room's constraint builder and runs the same meter on it. Its `state` appears in `__app.lobby()`, the `lobby` dump section and the `audio: lobby result` log line:

| state | Rule |
|---|---|
| `checking` | `getUserMedia` pending. |
| `hearing` | a level above `SPEAKING_THRESHOLD` (0.05) has been seen; latched, so pauses between words do not flip it back. |
| `os-muted` | acquired and **the track's `muted` flag is true**: the capture endpoint is muted in Windows. Outranks everything but `failed`, including the `hearing` latch. Read at acquisition and on the track's `mute`/`unmute` events (re-evaluated immediately, not on the next meter tick). The line turns red (`field__hint--danger`) and shows `LOBBY.osMutedDevice` (mic-mute key in the F row, F9 on ASUS; Settings › System › Sound › Input › unmute); the bar is amber (`meter__fill--muted`); Create/Join stays enabled. `audio: lobby mic os-muted` is logged on entering, `audio: lobby mic os-unmuted` on leaving. The silence budget does not run while muted and restarts from the unmute. |
| `quiet` | acquired, not `muted`; nothing above 0.05 yet, and either less than `LOBBY_SILENT_MS` (6000 ms) since acquisition or the last `unmute`, or something above `SILENT_LEVEL` (0.01) was seen since then, or the meter's AudioContext is not `running`. The "say something" line. |
| `silent` | acquired, track live and **not** `muted`, meter running, and **no level above `SILENT_LEVEL` for `LOBBY_SILENT_MS`** since acquisition or the last `unmute`. The fallback for a capture gated below the endpoint (`muted: false`, near-zero samples). The lobby line turns amber (`field__hint--warn`) and shows `LOBBY.silentDevice`, which still names the Windows mute first; `audio: lobby mic silent` is logged once per check. Create/Join stays enabled. |
| `failed` | `getUserMedia` threw (`code` is the mapped error), **or the track fired `ended` after acquisition** (unplugged, seized — `MIC_NOT_FOUND`). Red (`field__hint--danger`), bar dead. A dead meter's final zero is never taken as a reading, so an unplug can never escalate to `silent`; if only the meter's clone ended while the track stayed live, the meter is rebuilt on the same track instead (at most three times), and a meter that could not be built at all (no AudioContext) leaves the open device in `quiet` with an idle bar. A `devicechange` after a `MIC_NOT_FOUND` failure restarts the check, so plugging the device back in recovers without a reload. |

The rule is `lobbyMicState({ everHeard, soundSeen, msSinceUnmuted, trackMuted, contextState })`, pure and unit-tested in `test/unit/mic-check.test.js`; precedence `os-muted` > `hearing` > `quiet` > `silent`, with `failed` decided outside it. `msSinceUnmuted` is measured from acquisition for a track that started unmuted and from the last `unmute` otherwise; `soundSeen` is reset on unmute too. The check reads `muted` from the **original** track (the one the room receives), not the meter's clone: the clone follows the source in Chromium, but the original is the one that carries the flag a test can stub.

**The measured signature of the Windows mute** (Electron 33 / Chrome 130, a real device: `IAudioEndpointVolume` mute on "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)", toggled by the ASUS F9 key and by Settings › System › Sound › Input › the device):

- `getUserMedia` **succeeds** while the endpoint is muted, and the track it returns has `muted: true` from its first tick. The lobby reports `os-muted` at acquisition, before the meter has said anything.
- Muting the endpoint while a track is live sets `track.muted = true` and fires `mute` within ~0.5–1 s: Chromium polls the OS mute state once a second (`services/audio/input_controller.cc`). Unmuting fires `unmute` and `muted` goes back to false. The lobby line, the room hint and the verdict follow the events, not a timer.
- So `track.muted` is a definitive OS-mute signal. Earlier notes claiming the page cannot see the OS mute were measured on a different path and are wrong.
- What remains invisible by any flag: a capture gated below the endpoint (an APO or hardware mute, or input volume 0) delivers real near-zero samples with `muted: false` — processed-path peak ≈ 3.3e-5 (one 16-bit LSB), rms ≈ 8e-6 — and a live but quiet microphone with NS+AGC reads peak 6e-5–1e-4, rms ≈ 1.5e-5, the same order of magnitude. Speech on that path reads rms 0.005–0.012, peak 0.1–0.2; the app's smoothed meter level then sits at 0.3–0.4. That is what `silent` (6 s) and `CAPTURE_SILENT` (8 s) are for, and why their copy still names the Windows mute first. The desktop app can read the endpoint's real state independently (Core Audio via PowerShell, no admin needed): Debug › "Windows microphone status…".
- This is a different failure from the privacy gate (Settings › Privacy & security › Microphone), which makes `getUserMedia` **fail** and is covered by `MIC_ERROR`.

After join the same flag is `SOURCE_MUTED` (section 3, immediate, ranked above `CAPTURE_SILENT`), and the same fallback is `CAPTURE_SILENT` (8 s hold); its copy is ordered the same way: Windows mute, then the headset switch, then another device.

---

## 2. Stats panel rows

Per peer, in the stats panel (`room-view.js`, `renderStats`). Values are English; the same figures appear bilingual in the Audio check.

| Row | Source | Values | Meaning / action |
|---|---|---|---|
| **Sending mic** | `stats.hasMicSender`, `micSendBps`, local `micMuted`, `micSpeech` | `not being sent` (red) | No `outbound-rtp` audio report for the mic sender. The mic is not attached to this connection: an app fault. Copy diagnostics. |
| | | `<rate> — muted, sending silence` (amber) | Mute is `track.enabled = false`; the RTP session keeps sending ~14 kbps. Expected. |
| | | `<rate> · speech detected · level n` (green) | `media-source.totalAudioEnergy` grew this interval: the encoder was given sound. Your side is fine. |
| | | `<rate> · SILENT (mic open, no sound)` (red) | Unmuted, sender attached, encoder given silence. Root cause 2: pick the headset in the mic menu, check its mute switch, Sound > Input. |
| | | `<rate>` alone | `micSpeech === null`: the browser reports no energy (Safari). Unknown, not silent. |
| **They hear you** | the peer's 1 Hz `diag` report (`peer.hearsMe`) | `can hear you (0.xx)` (green) | Their `inbound-rtp` RMS for our mic m-line is >= 0.01. Proof from the far side. |
| | | `cannot hear you — your mic is silent to them` (red) | Report is fresh, their level < 0.01 while our local level > 0.05. Transport or capture problem; compare with *Sending mic*. |
| | | `receiving but not playing (they need to click)` (red) | Their `<audio>` element is paused or `play()` was rejected. Ask them to click their page. |
| | | `muted incoming audio (test)` (amber) | They turned on *Mute incoming audio (test)*. |
| | | `muted, sending silence` | You are muted; nothing to judge. |
| | | `level 0.xx` / `—` | Fresh report but no speech recently, or no report in the last 8 s (`REPORT_STALE_MS`). |
| **Receiving audio** | `audioRecvBps` | bitrate | Sum of all inbound audio bytes. Bytes only; see the next two rows. |
| **Their mic** | `audioIn.mic` (inbound-rtp on the m-line the mesh tagged `mic`) | `hearing them (0.xx)` (green) / `silent` / bitrate / `—` | Sound decoded from their microphone. `silent` with a bitrate means their side is the one with root cause 2. |
| **Their shared audio** | `audioIn.shareAudio` | same | Their system/tab audio share. If you hear yourself only while this is non-silent: loopback echo, root cause 5. |
| **Playback** | `audio.sinks[peerId]` (the `<audio>` element) | `playing` / `paused` / `blocked (<error>)` (red) / `muted incoming audio (test)` / `no audio element` | `blocked` is the autoplay policy: a banner offers "Enable audio" and the next click retries. `no audio element` means no remote track was ever attached. |
| **Directions** | `transceivers` | `mic sendrecv/sendrecv · shareAudio sendrecv/sendrecv · video sendrecv/sendrecv` | `direction/currentDirection` per role. A `currentDirection` of `recvonly` or `inactive` on `mic` means our sender is not negotiated. |
| **Sending video / Receiving / Resolution / Frames / Dropped / Connection / Round trip / Packet loss** | video and transport stats | | Unchanged from before; not audio. |

Buttons: **Audio check** (opens the wizard, section 5), **Copy diagnostics** (section 6), **Request their diagnostics** per peer (section 9).

Per-peer tile line (`hearLine`): `can hear you (0.xx)` / `cannot hear you — your mic is silent to them` (only while your local level > 0.05) / `receiving but not playing` / `muted incoming audio (test)`; nothing while you are muted or the report is stale.

---

## 3. Verdict codes (`audio-health.js`)

`deriveAudioHealth(snapshot, tracker, now)` is pure and runs once a second. First matching rule wins; a shown verdict is held `HOLD_MS.SHOW = 3000` ms unless something more severe arrives. The verdict appears as a one-line hint above the Mute button (`AUDIO_HINT`), as a **one-line** banner carrying the same `AUDIO_HINT` copy with an *Audio check* action and a dismiss × (a dismissal is remembered per code+device in `main-room.js`, so the next tick does not put it back), and is logged as `audio: verdict` when it changes. Three codes raise neither banner nor hint (`SILENT_VERDICTS` in `main-room.js`): `OK`, `HEARD`, and `CAPTURE_SILENT` — the last because it rests on the level meter, the meter reads a *clone* of the microphone, and a clone that dies on Windows is indistinguishable from a dead microphone; it was raised mid-conversation often enough to lose the right to interrupt. It still reaches the stats panel, the Audio check summary and the dump. The long `AUDIO_HEALTH` prose is used only by the Audio check summary and the `TRACK_ENDED` toast.

Hold times (`HOLD_MS`): `CAPTURE_SILENT` 8000, `NOT_ATTACHED` 5000, `UNHEARD` 4000, `TALKING_WHILE_MUTED` 2000, `SHOW` 3000, `REPORT_FRESH` 8000 (older peer reports are ignored), `SPEAKING_RECENT` 2500 (you count as speaking for this long after level > 0.05), `HEARD_RECENT` 30000 (a peer who reported hearing you within this window suppresses `CAPTURE_SILENT` — their report describes only the last second, so without the latch the suppression evaporated in every conversational pause).

| Code | Severity | Rule | Hint | What to do |
|---|---|---|---|---|
| `MIC_ERROR` | danger | `self.micError` set and `micAvailable === false` | mic unavailable | `getUserMedia` failed. On Windows the usual cause is Privacy & security > Microphone > *Let desktop apps access your microphone* off, or the device in exclusive use. The error line names the code. |
| `ENGINE_SUSPENDED` | warn | meter `contextState !== 'running'` and not dead | click the page | Autoplay policy suspended the AudioContext; the meter is frozen, the mic may be fine. Click anywhere; the meter retries on the gesture. |
| `TRACK_ENDED` | danger | meter `dead` or `reason === 'track-ended'` | mic stopped | The device was unplugged or seized. Reconnect it or choose another in the mic menu. |
| `SOURCE_MUTED` | danger | `self.micSourceMuted` (the track's `muted` flag, read at acquisition and on `mute`/`unmute`) or meter health `source-muted` | Windows muted "&lt;label&gt;" — mic-mute key / Sound › Input › unmute | The capture endpoint is muted in Windows; Chromium mirrored it onto the track within a second. Press the keyboard's mic-mute key or unmute it under Settings › System › Sound › Input. Immediate, no hold; clears by itself on `unmute`. Outranks `CAPTURE_SILENT`. |
| `CAPTURE_SILENT` | warn (panel and Audio check only — no banner, no hint) | unmuted, mic available, not `SOURCE_MUTED`, **both** the meter level **and** the encoder's own `micRms` (`media-source.totalAudioEnergy`, via `peers[].micRms`) below 0.01 for 8 s, **and nobody has reported hearing us in the last 30 s** (`HEARD_RECENT`). A missing meter is *unknown*, not silent; with no peer connected there is no encoder witness, so it cannot fire alone in a room | no sound — check the Windows mic mute ▴ | Root cause 2's fallback: `muted: false` but near-zero samples (a mute applied below the endpoint). The copy names the Windows mute first (mic-mute key, Sound > Input), the headset switch second, another device last. `params.lobbyWorked` is true when the lobby peak exceeded 0.05: then the device is fine and something changed when the room re-opened it (a different default, an app grabbing it). |
| `NOT_ATTACHED` | danger | a connected peer's stats have `hasMicSender === false` for 5 s | mic not attached | App fault (no outbound-rtp for the mic). Copy diagnostics and report; mute/unmute re-attaches. |
| `UNHEARD_PLAYBACK` | danger | unmuted, spoke in the last 2.5 s, a fresh report shows level < 0.01 and `playing === false`, for 4 s, nobody else hears us | received, not playing there | Their `<audio>` is blocked. Ask them to click their page. |
| `UNHEARD_TRANSPORT` | danger | same, but their `playing` is not `false` | your voice is not arriving | Sound leaves here (compare *Sending mic*) but their decoder gets silence. Copy diagnostics on both sides; align the timelines (section 10). |
| `TALKING_WHILE_MUTED` | warn | muted and level > 0.05 for 2 s | you are muted | Unmute. |
| `HEARD` | ok | unmuted and a fresh report has level >= 0.01 | `<name> hears you` | Everything is working; `params.level` is their measured level. |
| `OK` | null | none of the above | (empty) | Nothing to say. |

Precedence note: a peer report that hears us outranks a local meter reading zero, because a broken clone is not a broken microphone.

Everything here is bilingual (Arabic first, then English) via `audio-strings.js`; `bi()` joins the pair for single-line contexts.

---

## 4. The mic menu (caret next to Mute)

| Item | What it does | What its result proves |
|---|---|---|
| **Microphone** list (`In use: <label>`) | Every `audioinput` from `enumerateDevices`, with `System default — …` and `Default communications device — …` prefixed on Chromium's reserved ids. Choosing one calls `restartMic({deviceId})`: new track acquired, `replaceTrack` on every peer, then the old track is stopped. Logs `audio: device chosen`, `audio: mic switched`. | On Windows *System default* is the console-role endpoint and is often **not** the headset. If the bar starts moving after picking the headset, root cause 2 is confirmed. |
| **Speaker** list | Every `audiooutput` from `enumerateDevices`, labelled by the same rules as the input list. Choosing one calls `setSinkId` on every remote `<audio>` element and on the mixer's output, and remembers it in `sessionStorage` under `streamer:audio`. Logs `audio: output device set`. Where the browser has no `setSinkId` (Firefox without a flag, Safari) the list is replaced by a line saying so. | Proves whether the call is coming out of the device you think it is. Note the desktop app needs the `speaker-selection` permission in `desktop/main.js` for this to work at all -- without it Chromium rejects silently. |
| **Volume per participant** (0-500%) | A slider each. 100% leaves that person on the plain `<audio>` element exactly as before; any other value moves them onto a Web Audio chain -- `source -> gain -> limiter -> shared destination` -- and mutes their element so they are not heard twice. Built lazily, per peer, and never torn down again for the session. Remembered by participant NAME, so a reconnect does not lose it. Logs `audio: peer volume`. | `HTMLMediaElement.volume` is capped at 1 by the specification, so anything above 100% *must* leave the element; `audioSinks()[id].outputVia` says which path a peer is actually on. The limiter is why 500% is loud rather than crunchy. |
| **Audio processing**: Echo cancellation (AEC), Noise suppression, Automatic gain control | Re-acquires the mic with the new constraints; the checkboxes show `track.getSettings()` after acquisition, i.e. what the browser actually applied. Logs `audio: processing change requested`. | AEC affects only the sent signal. It cannot stop you hearing yourself locally and does nothing for a silent capture. |
| **Record 3 s and play it back** (+ **Save recording**) | `MediaRecorder` on the live room track, then plays the blob through an `<audio>` element. Reports peak level. Logs `audio: self-test start/phase/result`. | "Recorded silence" means this device delivers nothing to the app. Hearing yourself proves the room track works end to end on this machine. Playback refused means the autoplay policy; click and retry. |
| **Mute incoming audio (test)** | Sets `muted = true` on every remote `<audio>` element; shows a banner while on; reported to peers as `incomingMutedForTest`. Logs `audio: incoming test-mute`. | If you still hear your own voice with this on, the sound is not coming from this app (root cause 1). |
| **Release microphone for 3 s** | Stops the mic track for 3 s, then re-acquires. Logs `audio: release-mic test start/end`. | If the self-voice disappears while released and returns when re-opened, it is sidetone that engages whenever any app opens the mic (Bluetooth HFP, USB headset software). |
| **Audio check** | Opens the wizard (section 5). | |
| **Copy diagnostics** | Builds the dump (section 6), copies it, shows it in a selectable dialog. | |

Note the proof the menu cannot give: nothing in this app routes your microphone to your speakers. The Audio check step 2 prints `audio elements carrying your mic: 0` for that reason.

---

## 5. The Audio check wizard

Opened from the mic menu, the stats panel, or any verdict banner. Five steps; steps 1, 2 (on answer), 3 and the summary log an `audio-check:` line, step 4 does not.

| Step | Shown | Logged |
|---|---|---|
| **1 — Say something** | Live bar, `Microphone: <label>`, a device `<select>`. After the peak exceeds 0.05: "The bar moves — this microphone delivers your voice." After 4 s without: "The bar is flat … pick your headset from the list below or check its mute switch." | `audio-check: step 1 {peak, label}` |
| **2 — Mute and keep talking** | Live bar (amber while muted). Proof line: `track.enabled=<bool> · audio elements carrying your mic: 0 · incoming audio elements: <n>`. Question: do you still hear yourself? **Yes** -> root cause 1 instructions (Control Panel > Sound > Recording > mic > Properties > Listen > untick; headset software sidetone/mic monitoring; confirm by closing the app). **No** -> it only happens while unmuted, so it comes back from the friend's side; if they share from the desktop app, ask them to untick *Share system audio* or both use headphones. Extra button: *Release the microphone for 3 s*. | `audio-check: hears self while muted {hearsSelf, micMuted}` |
| **3 — Unmute and talk for five seconds** | `Sending: <status>` (same values as the *Sending mic* row) and one line per peer `<name>: <status>` (same values as *They hear you*). "This measures the sound actually leaving your machine, not just bytes." | `audio-check: step 3 {sending, peers[]}` |
| **4 — Ask the other person to talk** | Per peer: `hearing them (0.xx)` / `silent` / `—`, and `Playback: playing / paused / blocked (<error>) / no audio element`. | |
| **Summary** | The current verdict in both languages, or "No obvious problem on this machine." Button: Copy diagnostics. | `audio-check: summary {code}` |

Also logged: `audio-check: opened`, `audio-check: closed`. Opening the check acquires the mic if it is not open and refreshes the device list (`audio: devices {reason:'audio-check'}`).

---

## 6. Copy diagnostics: the dump layout

`buildDiagnostics()` in `main-room.js` -> `logger.dump()` -> pretty-printed JSON. Never contains SDP or ICE candidates (the logger redacts them). The dialog shows the text even if the clipboard call fails.

Top-level keys, in order, and what to look at first:

| Key | Content | Look at first |
|---|---|---|
| `generatedAt` | ISO timestamp from the logger. | Align with the other side's dump. |
| `format` | `"streamer-diagnostics/1"`. | |
| `env` | `secureContext, browser, mobile, webrtc, userMedia, displayMedia, desktop, protocol, e2e`. | `desktop: true` means the Electron app (loopback share possible). |
| `room` | `id, joinOrder, isHost, participants`. | |
| `self` | `id, micMuted, micAvailable, micError, micSourceMuted, micDevice`. | `micError` (why acquisition failed), `micSourceMuted`, `micDevice.label`. |
| `mic` | `media.micInfo()`: `id, label, readyState, muted, enabled, requestedDeviceId, settings (getSettings()), acquiredAt`. | **`label`**: the device Windows actually opened. `enabled: false` = muted by us; `muted: true` = the endpoint is muted in Windows. `settings.deviceId` vs `requestedDeviceId`. |
| `effectiveAudio` | The constraint flags in force (config `media.audio` + menu overrides). | Whether AEC/NS/AGC were requested. |
| `lobby` | Lobby mic check result: `state, code, label, settings, peak, deviceId, heard, trackMuted, meter`. | `state` is `hearing` / `quiet` / `os-muted` / `silent` / `failed` (section 1); `os-muted` is the Windows endpoint mute, seen on the track; `silent` is six seconds of nothing from a live, unmuted device. `peak > 0.05` means the lobby heard the device; if the room is silent with the same label, something changed on re-open. |
| `meter` | `level-meter.state()`: `contextState, sampleRate, trackReadyState, trackMuted, cloneReadyState, cloneMuted, level, peak, ticks, lastTickAt, dead, reason, uptimeMs, health`. | `health`, `contextState`, `peak`. `ticks` not increasing between two dumps means the meter itself is stuck. |
| `audio` | Store state: `devices` (`inputs[], outputs[], defaultGroup, communicationsGroup, defaultMatchesCommunications`), `meter`, `lobby`, `selfTest` (`state, peak, bytes, error, playbackError`), `sinks` (per peer `<audio>` state: `paused, readyState, networkState, muted, volume, sinkId, gain, outputVia, currentTime, playError, lastEvent, lastEventAt, playAttempts`), `speakerDeviceId`, `speakerSupported`, `volumes` (peerId -> 0..5), `incomingMutedForTest`, `processing`, `health`. | **`devices.defaultMatchesCommunications === false`** on Windows is root cause 2 in one field. `sinks[*].playError` is the autoplay block. `health.code` is the verdict. |
| `peers[]` | Per peer: `id, name, joinOrder, youInitiate, polite, pcState, micMuted, stats` (the full collector sample: `hasMicSender, micSendBps, micAudioLevel, micRms, micSpeech, micPacketsPerSec, audioIn{mic,shareAudio}, remoteAudioLoss, transceivers, connectionType, …`), `hearsMe` (`level, shareLevel, playing, mutedForTest, at`), `report` (their last raw 1 Hz report, section 8), `transceivers`, `diag` (`{diag, dump}` channel readyStates), `remoteDump` (`{at, dump}` if *Request their diagnostics* completed; absent from a dump sent in reply to a request). | `stats.hasMicSender`, `stats.micSpeech`, `hearsMe.level`, `report.sink.playError`, `transceivers[role=mic].currentDirection`. |
| `audioTimeline[]` | The last 120 one-second samples (section 7). | Find the second the numbers diverge. |
| `log[]` | The logger ring buffer: the last 800 lines (`BUFFER_SIZE` in `logger.js`), errors always kept. | Grep for `audio: ` and `audio-check: ` (section 8). |

---

## 7. `audioTimeline` fields

One entry per peer per stats tick (`recordTimeline`), rolling window of `TIMELINE_MAX = 120`.

| Field | Meaning |
|---|---|
| `t` | `Date.now()` wall clock (ms). Use to align with another machine's dump. |
| `p` | `performance.now()` rounded: monotonic, survives clock changes. |
| `self` | Our peer id. |
| `peer` | The peer this sample is about. |
| `muted` | Our mute state at that second. |
| `level` | Local meter level (0..1, 3 decimals), from the clone, so it moves while muted. |
| `micRms` | Interval RMS of what the encoder was given (`media-source.totalAudioEnergy`), or null. |
| `micSpeech` | `true`/`false`/`null` (unknown). |
| `micKbps` | Encoded mic bitrate; ~14 whether or not there is sound. |
| `hasMicSender` | An outbound-rtp for the mic existed. |
| `inMic` | RMS (or level) decoded from their mic. |
| `inShare` | RMS (or level) decoded from their shared audio. |
| `hears` | The level they reported hearing from us (`hearsMe.level`). |
| `theyPlay` | Their `<audio>` for us is playing (`hearsMe.playing`). |
| `sinkPlaying` | Our `<audio>` for them is playing and had no play error. |
| `pc` | Peer connection state. |

Reading a row: `muted:false, level:0.2, micRms:0.15, hears:0.12` is healthy. `level:0.2, micRms:0.15, hears:0` for several rows is transport or their playback; `level:0.001, micRms:0.001` while the person speaks is capture silence; `level:0.2, micRms:0.001` means the meter clone hears sound the sender does not (compare `mic.id` with `transceivers[mic].senderTrackId`).

---

## 8. Log lines and what each proves

All audio lines start with `audio: ` or `audio-check: `. Structured fields in braces.

| Line | Level | Proves |
|---|---|---|
| `audio: lobby mic acquired {label, muted, settings}` | info | The lobby opened this device with these applied constraints. |
| `audio: lobby meter state {…}` | info | Lobby meter health transitions. |
| `audio: lobby meter dead {label, reason, rebuilds}` | warn | The lobby meter died after acquisition. `track-ended` means the device went away (the line turns red, `failed`); `clone-ended` with a live track means only the meter's clone ended and a replacement meter was built. |
| `audio: lobby devices changed after a failed check, retrying` | info | A `devicechange` arrived while the lobby check was `failed` with `MIC_NOT_FOUND`; the check was restarted. |
| `audio: lobby mic os-muted {label}` / `audio: lobby mic os-unmuted {label}` | warn/info | The lobby track's `muted` flag went true / false: the capture endpoint was muted / unmuted in Windows. The line turned red / recovered. Once per transition. |
| `audio: lobby mic track mute|unmute {label, muted}` | info | The raw `mute`/`unmute` event on the lobby track, before the verdict is recomputed. |
| `audio: lobby mic silent {label, msSinceUnmuted, peak, trackMuted}` | warn | Six seconds without a level above 0.01 from a live, unmuted lobby track (counted from acquisition or the last unmute); the lobby line turned amber. Once per check. A mute applied below the endpoint, or a very quiet room (section 1, *The lobby check*). |
| `audio: lobby device unavailable, using default {deviceId, name}` | warn | The chosen device failed; fell back. |
| `audio: lobby devices {…}` / `audio: lobby enumerateDevices failed` | info/warn | Lobby device list. |
| `audio: lobby result {state, code, label, peak, …}` | info | What the lobby concluded at Join; `peak > 0.05` means it heard you. |
| `audio: mic acquired {source, id, label, readyState, muted, enabled, settings, …}` | info | The room's track. `source` says whether the lobby stream was adopted. **Compare `label` with the headset name.** |
| `audio: lobby stream not adopted, re-acquiring {…}` | info | Device or processing differed from the lobby, so the room opened the mic again. |
| `audio: requested device unavailable, falling back to default {…}` | warn | `OverconstrainedError`/`NotFoundError` on the exact deviceId. |
| `audio: mic acquisition failed {code, detail}` | warn | `getUserMedia` rejected: verdict `MIC_ERROR`. On Windows, check the desktop-apps microphone privacy toggle. |
| `audio: stream has no audio track {source}` | warn | Acquired stream without audio. |
| `audio: mic track mute (endpoint muted in Windows) {label}` / `audio: mic track unmute` | warn/info | The browser's `mute`/`unmute` events on the room track: the capture endpoint was muted / unmuted in Windows (Chromium polls it once a second). Verdict `SOURCE_MUTED`, cleared on unmute. |
| `audio: mic track ended {label}` | warn | Device unplugged or seized. Verdict `TRACK_ENDED`. |
| `audio: devices {reason, inputs, outputs, defaultGroup, communicationsGroup, defaultMatchesCommunications, current}` | info | Device inventory after every acquisition, on `devicechange`, and when the check opens. `defaultMatchesCommunications: false` = default is not the headset. |
| `audio: devicechange` | info | A device was plugged/unplugged. |
| `audio: mic released {label}` / `audio: mic restart failed {name, message}` | info/warn | Track stopped; re-acquire failure. |
| `audio: mesh attach failed {…}` | error | The track exists but `replaceTrack` failed on a peer: the `NOT_ATTACHED` path. |
| `audio: transceivers {peerId, after, transceivers}` | info | Directions after each description is applied. |
| `audio: remote track attached {peerId, role, muted}` | info | A remote track was put in an `<audio>`/`<video>`. |
| `audio: remote track mute|unmute|ended {peerId, kind, id}` | info | Remote track events: `mute` on their mic role means their source stopped or they never sent. |
| `audio: play rejected {peerId, name, message}` | warn | `<audio>.play()` rejected (`NotAllowedError` = autoplay policy). Stats *Playback: blocked*, banner shown. |
| `audio: playback blocked {peerId, name}` | warn | The banner was raised. |
| `audio: remote playback resumed {peerId}` | info | A later gesture made `play()` succeed. |
| `audio: remote element error {peerId, code}` | warn | `<audio>` element `error` event. |
| `audio: meter first sound {msSinceAcquire}` | info | The room meter saw level > threshold for the first time. Absent = the room never heard you. |
| `audio: meter state {…}` | info | Meter health transitions (`running`/`suspended`/`source-muted`/`dead`). |
| `audio: no sound for 10 s while unmuted {label, meter, micRms}` | warn | The one line to grep for capture silence; repeats at most every 30 s. |
| `audio: verdict {code, params}` | info | The verdict changed, or the same verdict now names a different device or peer (`params.label` / `params.name`). |
| `audio: device chosen {deviceId, lobby}` / `audio: mic switched {…}` / `audio: mic switch failed {code, message}` | info/warn | Mic menu device changes. |
| `audio: processing change requested {aec/ns/agc patch}` | info | AEC/NS/AGC toggled. |
| `audio: self-test start {label}` / `phase {phase}` / `result {…}` | info | Record-and-play-back test. |
| `audio: incoming test-mute {on}` | info | Mute incoming audio (test) toggled. |
| `audio: release-mic test start {wasMuted}` / `end {reacquired}` | info | Release-for-3-s test. |
| `audio: <name> started|stopped hearing us {level, playing}` | info | Transition in the peer's report (only while we are unmuted). |
| `audio: diagnostics request sent {peerId, sent}` / `requested by peer {peerId}` / `received from peer {peerId, bytes}` / `too large to send {peerId}` | info/warn | The dump request flow (section 9). |
| `audio-check: opened` / `step 1 {peak, label}` / `hears self while muted {hearsSelf, micMuted}` / `step 3 {sending, peers}` / `summary {code}` / `closed` | info | The wizard's answers, so a pasted log contains what the person saw and chose. |

`peer: diag channel open|closed {peerId, kind}` and `peer: diag channels unavailable` are debug/warn lines from `peer.js`.

---

## 9. The diag data channels (`diag-channel.js`, `peer.js`)

Two `RTCDataChannel`s per peer connection, created by the **initiator before `createTransceivers()`** so they ride the first offer and add no transceiver. No signaling message type was added; `public/shared/protocol.js` is unchanged. A browser without data channels still gets a working call and simply cannot report.

| Label | Options | Traffic |
|---|---|---|
| `diag` (`DIAG_LABEL`) | `{ordered: false, maxRetransmits: 0}` | One `report` frame per second per peer, sent from the stats tick. A lost frame is worth less than a late one. |
| `diag-dump` (`DUMP_LABEL`) | `{ordered: true}` (reliable) | `dump-request` and `dump` chunk frames. |

`DIAG_VERSION = 1`. Every frame is a JSON object with `v` and `kind` (`report` | `dump-request` | `dump`). Anything else is dropped.

### Report frame (`buildReport` / `parseReport`)

```json
{
  "v": 1, "kind": "report", "t": 1724999999999,
  "self": {
    "micMuted": false, "micState": "live | source-muted | none",
    "micRms": 0.12, "micLevel": 0.2, "micPacketsPerSec": 50,
    "meter": { "contextState": "running", "dead": false }
  },
  "hearing": {
    "mic":        { "level": 0.1, "rms": 0.11, "packetsPerSec": 50, "concealedPerSec": 0, "trackMuted": null },
    "shareAudio": null
  },
  "sink": { "paused": false, "readyState": 4, "muted": false, "volume": 1, "playError": null },
  "incomingMutedForTest": false
}
```

`hearing.*` is what the sender of the report decodes **from us** (its `audioIn` by role); `sink` is the `<audio>` element it plays us through. The receiver stores it as `peer.report` and derives `peer.hearsMe = {level: hearing.mic.rms ?? level, shareLevel, playing: sink.paused === false && !sink.playError, mutedForTest, at}`.

Untrusted parsing (`parseReport`): non-string, empty, or longer than `MAX_DIAG_BYTES = 2048` -> null; JSON that is not a plain object, wrong `v`, wrong `kind` -> null; every number is clamped to 0..1 or non-negative and becomes null when non-finite; strings are cut at 32 chars; booleans must be booleans. Reports are accepted whether or not one was asked for, but they only ever update that peer's `report`/`hearsMe`.

### Dump request and chunks (`buildDumpRequest`, `chunkDump`, `parseControl`, `createDumpAssembler`)

1. *Request their diagnostics* sends `{"v":1,"kind":"dump-request","id":"d<base36 time>"}` on `diag-dump`. Logged `audio: diagnostics request sent {sent}`; `sent: false` means the channel is not open.
2. The peer builds a **compact** dump (`buildDiagnostics({includeRemote: false, compact: true})`: no indentation, the newest 80 log lines, the last 40 timeline rows, no raw peer reports or nested remote dumps) and splits it into `{"v":1,"kind":"dump","id","i","n","data"}` frames of `DUMP_CHUNK_BYTES = 12000` characters. If even that exceeds `MAX_DUMP_BYTES = 65536` it logs `audio: diagnostics too large to send, sending a stub` and sends `{"format":"streamer-diagnostics/1","error":"too-large"}` instead. The requester waits 15 s (`DUMP_REQUEST_TIMEOUT_MS`); an unanswered request logs `audio: diagnostics request unanswered` and shows a toast asking the other side to use Copy diagnostics themselves.
3. The requester's per-peer assembler collects chunks by `id`; a new `id` or different `n` discards a half-received dump. When `received === n` it joins the parts, refuses the result if it exceeds 64 KB, stores `{at, text}` in `remoteDumps`, logs `audio: diagnostics received from peer {bytes}` and toasts. The next Copy diagnostics embeds it as `peers[].remoteDump.dump` (parsed JSON, or the raw text if it did not parse).

`parseControl` limits: frame longer than `DUMP_CHUNK_BYTES + 512` -> null; `i`/`n` must be integers with `0 <= i < n`, `n >= 1`, `n <= ceil(65536/12000) = 6`; `data` must be a string no longer than 12000. `id` is cut at 32 chars.

---

## 10. `window.__app` accessors

Installed always (read-only; state-changing hooks such as `peers()`, `senders()`, `micTrackEnabled()` exist only under the E2E flag). Open DevTools (desktop: Debug menu, hold Alt) and call:

| Accessor | Returns |
|---|---|
| `__app.selfId()`, `roomId()`, `isHost()` | Identity. |
| `__app.audio()` | The store's `audio` state plus live `sinks` (section 6, `audio`). |
| `__app.micSettings()` | `media.micInfo()`: id, label, readyState, muted, enabled, requestedDeviceId, settings, acquiredAt. |
| `__app.micLevel()` | Current meter level (0..1). |
| `__app.meterState()` | `level-meter.state()` including `health`. |
| `__app.devices()` | `describeDevices()` output. |
| `__app.audioSinks()` | Per-peer `<audio>` element state, including `gain` (0..5) and `outputVia` (`element` \| `webaudio`). |
| `__app.speakerDevice()` | The chosen output device id, or null for the system default. |
| `__app.peerVolumes()` | `{[peerId]: gain}` for everyone whose volume has been adjusted. |
| `__app.mixer()` | The Web Audio graph's own view: `{active, contextState, peers}`. `active: false` means nobody has moved a slider and no AudioContext exists. |
| `__app.transceivers(peerId?)` | Transceiver snapshot for that peer (first peer by default). |
| `__app.lobby()` | The lobby check result. |
| `__app.health()` | Current verdict `{code, severity, params, changed}`. |
| `__app.peerReports()` | `{[peerId]: {hearsMe, report}}`. |
| `__app.audioTimeline()` | A copy of the timeline array. |
| `__app.diagnostics()` | The full dump as a JSON string (same as Copy diagnostics). |
| `__app.peers()`, `connections()`, `share()`, `quality()`, `micMuted()`, `micTrackEnabled()`, `micTrackId()`, `hasDisplayAudio()`, `senders(peerId?)`, `encodings(peerId?)`, `stats(peerId)`, `signalingState(peerId?)`, `signalingStatus()` | The other read-only accessors, also always installed. Only the state-changing hooks (`dropSocket()`, `runSelfTest()`) require the E2E build. |
| `__app.env()` | `environmentSummary()`. |

---

## 11. Reading two dumps side by side

Take Copy diagnostics on both machines within the same minute (or *Request their diagnostics* on one side, which embeds theirs under `peers[].remoteDump`).

1. **Identify the pair.** In dump A, `self.id` is A; find the entry in A's `peers[]` whose `id` equals dump B's `self.id`, and vice versa.
2. **Align the clocks.** `audioTimeline[].t` is wall-clock ms on each machine; expect a fixed offset between the two, and use `p` within one dump for exact spacing. Pick a row in A where `level > 0.05` and `muted === false` (A was speaking), and find B's rows with `t` within about a second.
3. **Follow the sound across the four numbers, in order.** For A speaking to B:
   - A `level` (clone meter): did A's device deliver sound? If not -> A's `mic.label`, `audio.devices.defaultMatchesCommunications`, `lobby.peak`; root cause 2.
   - A `micRms` / `micSpeech`: did A's encoder get it? If `level` moves but `micRms` is ~0 -> A's `mic.id` vs `peers[B].transceivers[mic].senderTrackId`, `hasMicSender`.
   - B `inMic` (in B's timeline, row `peer === A`): did B's decoder produce it? If A sends speech and B decodes silence -> transport; check both `pc`, `peers[].stats.connectionType`, `remoteAudioLoss`, `audioIn.mic.concealedPerSec`.
   - B `sinkPlaying` and B `audio.sinks[A].playError`: did B's element play it? `false`/`NotAllowedError` -> B must click; verdict on A shows `UNHEARD_PLAYBACK`.
   - Cross-check: A's `hears` for that second should equal B's `inMic` (it is B's report of the same number, one hop later).
4. **Self-echo questions.** If A hears themselves: is A `muted: true` while it happens? Then it is not the app (root cause 1). Does B's `inShare` show sound while B shares from the desktop (`env.desktop: true`)? Then it is loopback (root cause 5).
5. **Finish with the logs.** In each `log[]`, read `audio: mic acquired`, `audio: devices`, any `audio: no sound for 10 s while unmuted`, `audio: play rejected`, and the `audio: verdict` sequence; the `audio-check:` lines record what the person saw and answered.
