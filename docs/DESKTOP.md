# The desktop app

One Windows application that can either host a room or join one. It is the same web client
inside — the app loads `https://<host>:<port>/r/<id>` exactly as a browser would — plus the three
things a browser cannot do.

## What it changes

| | Browser | Desktop app |
|---|---|---|
| Certificate | Install `certs/ca.crt`, or click through a warning every time | Nothing. The invite carries the fingerprint |
| Screen picker | Chrome's dialog, with a "share audio" checkbox people miss | The app's own picker, with a **Share system audio** checkbox that is on by default |
| System audio | Only if you remember the checkbox, and only for tabs | Windows loopback of the whole render mix — everything the PC plays, **including this app's playback of the call** — as a track separate from the microphone |
| Starting a room | A terminal, and `node src/index.js` | A button |

What it does **not** change: reaching your machine from another network. That still needs a public
address and an open port. See [NETWORK.md](NETWORK.md), which comes first for a reason.

## Running it

```
npm install
npm run app          # development
npm run build        # installer + portable .exe into dist/
npm run build:dir    # unpacked build, no installer — faster while iterating
```

## The invite links

Hosting produces two links for every address the machine has. They are not interchangeable.

```
streamer://join?h=192.168.1.34:8443&r=<roomId>&fp=<sha256>   ← for the app
https://192.168.1.34:8443/r/<roomId>                          ← for a browser
```

The app link carries the SHA-256 of this machine's TLS certificate. The joining app trusts that
one certificate for that one host and refuses anything else, so there is no CA to install and no
warning to dismiss.

**This is stricter than the browser flow, not a shortcut around it.** Clicking "Advanced →
Proceed" in a browser accepts whatever certificate is presented and gives you no way to notice it
changed later. A pinned digest accepts one key and refuses every other — a swapped certificate
becomes a refusal with an explanation, not a dialog you have been trained to dismiss.

Nothing is written to disk to make this work. The fingerprint lives in the link, so the
zero-storage rule holds: quit the app and it remembers nothing.

If a chat client mangles the `streamer://` link into plain text, paste it into the Join box — that
works too. So does a plain `https://` room link, but it carries no fingerprint, so you will get the
ordinary certificate warning. The Join box says which one you pasted before you press anything.

## Certificates

Generated on first host, into `%APPDATA%\Streamer\certs\`, never into the installation directory —
which is read-only once installed.

They are produced in-process rather than by shelling out to `openssl`. That used to be the case,
and it meant hosting silently required Git for Windows to be installed. Since any participant can
now host, that is not a constraint this app can ship with.

Existing installations that still have EC certificates from the OpenSSL era keep working. If the
certificate ever needs reissuing, the old CA cannot sign the new leaf, so a fresh pair is created
and browser participants re-accept `ca.crt` once. App participants never notice.

## Sharing a screen

The picker lists screens and windows with live thumbnails. On Windows it also offers **Share
system audio**, a checkbox that is ticked by default, because "nobody could hear the video I was
sharing" is the single most common complaint about screen sharing and it is caused by the
checkbox Chrome's dialog hides.

What that checkbox captures deserves saying plainly. It is a WASAPI loopback of the default
render endpoint (Electron's `audio: 'loopback'`): **the whole mix this PC plays, including this
app's own playback of the other participants.** Their voices go back out to them inside the
shared audio track, and they hear themselves echoed — only while you are sharing
(electron/electron#27337). The picker says so next to the checkbox. Two honest fixes:

- **Untick "Share system audio"** for a voice-only session, or one where people complain of echo.
  The microphone is a separate track and keeps working.
- **Headphones** on everyone, so that what comes back is at least not re-captured by
  microphones. Unticking is the one that removes the call from the shared track.

Two things that do *not* fix it: Electron's `loopbackWithMute` would silence the sharer's own
speakers instead of excluding this app's output, and Chromium's `restrictOwnAudio` does not
apply to the Electron loopback path (the web client requests it only in a browser, where it is
honoured when supported). Echo cancellation does not help either — see below.

Muting your microphone does not silence what you are sharing. They are different tracks on
different senders, and the mute control only ever touches the microphone. That separation is
enforced by a test.

macOS and Linux cannot capture system audio this way. The checkbox is not shown there and the
picker says so rather than sharing silently.

## Reaching the room from another network

Two options in the room panel. They solve different situations and the first one solves more of
them.

### The tunnel (works on any network)

**Open a public link over Cloudflare.** `cloudflared` dials *out* from your machine and Cloudflare
hands back a public `https://<random>.trycloudflare.com` address that points at your room.

This is the option that works on a network you do not administer — guest Wi-Fi, a hotel, an office.
There is no router to configure and, because nothing listens on the public internet, **no inbound
firewall rule is needed at all**. Windows Firewall and any third-party antivirus firewall are
simply not involved, which removes the single most time-consuming failure this project has hit.

Two more things come free with it:

- **No certificate warning.** Cloudflare terminates TLS with a real, publicly trusted certificate.
  Nothing to install, nothing to click through, no fingerprint to compare — so a browser
  participant has as easy a time as an app one.
- **Media still never touches Cloudflare.** Only signalling goes through the tunnel: a few
  kilobytes of SDP and ICE. Audio and video remain peer-to-peer.

Install it once, without administrator rights:

```
# save to %LOCALAPPDATA%\Streamer\cloudflared.exe — the app looks there first
https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe

# or, if you have admin:
winget install Cloudflare.cloudflared
```

**The address changes every time you switch the tunnel on.** A stable one needs a domain you own,
which costs money; re-sending the link each session is the free version. The panel lists the
tunnel link first and tags it *anywhere — send this one abroad*, because burying it under
`localhost` and a `10.x` address is how the wrong link gets copied.

The tunnel is shut down when you stop hosting or quit. If it dies on its own, the panel says so
rather than continuing to advertise an address that no longer resolves.

### UPnP (only on your own router)

Asks the router to forward the port. Off by default, because quietly reconfiguring somebody's
router is not something an app should do on launch. It reports what happened:

- **Port open** — with the external address the router gave.
- **Port open, but behind carrier-grade NAT** — the router mapped the port and then reported a
  private address as its own external address. The mapping is real and still useless; only your
  ISP can change that.
- **Failed** — with the reason. Most often UPnP is switched off in the router.

On guest or office Wi-Fi there is no router to ask, so use the tunnel instead. The mapping is
removed when you stop hosting or quit.

## When someone cannot connect

Work through it in this order. The two halves fail for unrelated reasons and fixing the wrong one
costs days.

**1. Can they reach the machine at all?** If the app says "Could not reach `<host>:<port>`", the
page never loaded and no screen sharing was attempted. Check the port is forwarded and the address
is right.

**2. Windows Firewall.** The installer adds an inbound rule. If you run from source with
`npm run app`, no installer ran, so allow it when Windows asks.

**3. A third-party firewall.** This is the one that wastes the most time. Avast, Kaspersky and
Norton each filter inbound connections independently of Windows Firewall, so the Windows rule can
be perfectly correct while nothing gets through. On this project's own machine, Avast was the
cause after Windows Firewall had been verified correct and the router ruled out. Allow the app
there separately.

**4. Only then, the peer connection.** If the room loads and people appear in the list but no
video arrives, that is a different problem — ICE, not reachability. `docs/NETWORK.md` covers it.

## The SmartScreen warning

The installer is unsigned, so Windows shows **"Windows protected your PC"**. Click **More info**,
then **Run anyway**.

This is not something the app can suppress. A code-signing certificate costs a few hundred dollars
a year from a certificate authority, and for a private tool shared with a handful of friends that
is a real cost with no security benefit for people who already trust where the file came from —
they are getting it directly from you, not from a download site.

## Testing

```
npm run test:desktop   # Playwright driving the real Electron app
npm test               # everything: lint, unit, certificates, browser E2E, desktop E2E
```

The desktop suite launches real app instances — two of them, for the join test — and asserts on
real behaviour: a pinned invite connects with no warning, a **tampered fingerprint is refused**,
the picker produces a live track, quitting releases the port, and a packaged build writes its
certificates to userData rather than the installation directory.

## Two things worth knowing if you work on this

**The main process is an ES module, so `app.whenReady()` must not be awaited at the top level.**
Electron waits for the entry module to finish evaluating before it emits `ready`, so a top-level
`await app.whenReady()` deadlocks: the module waits for the event, the event waits for the module.
The app then starts, opens no window, prints nothing, and exits with status 0. Use
`app.whenReady().then(...)`.

**The preload exposes different things depending on where the page came from.** The room page is
served by whoever is hosting — possibly a friend's machine — and gets one boolean,
`window.__DESKTOP__`. Only local `file://` pages get the control surface. Widening that would make
this app's security depend on every host behaving well.

## Knowing whether your microphone works

A call was lost to this exact question: a host on this app whose voice never reached the guest,
who heard his own voice even while muted, and whose level bar never moved. The bar never moved
because the only in-room meter lived inside the fullscreen overlay. That is fixed in several
places, each covering a different failure.

**Before you join.** The lobby opens the microphone with the same constraints the room uses,
shows a level meter, the name of the device that was actually opened, and a microphone
`<select>` to pick another one. The live stream is handed to the room on Join rather than
stopped and re-acquired, so what worked in the lobby is what the room sends. A blocked or missing
microphone is reported there, which is the one moment it can be fixed without an audience
waiting.

**The always-visible bar.** A level bar sits inside the Mute button, in your own tile, and in the
fullscreen overlay. It is green when the microphone is live, amber when muted (the meter runs on
a clone of the track, so it keeps moving while you are muted — that is how you tell a muted mic
from a dead one), and red when the track has ended or the meter is dead. A one-line verdict above
the Mute button says what is wrong when something is: *no sound — check the Windows mic mute ▴*, *received, not
playing there*, and so on. Everything it says is in Arabic and English.

**The mic menu.** The caret next to Mute opens: the device list (showing which physical
microphone Windows' reserved *default* and *communications* entries actually map to — on Windows
*default* is the console endpoint, often **not** the headset, which is the Default Communication
Device); Echo cancellation / Noise suppression / Auto gain checkboxes that re-acquire the
microphone; **Record 3 s and play it back** (with Save recording) — if it recorded silence, this
microphone delivers no sound to the app; **Mute incoming audio (test)**; **Release microphone
for 3 s**; **Audio check**; and **Copy diagnostics**.

**During the call, in Stats.** The **Sending mic** row is what the encoder was actually given,
per person, read from `media-source` audio level and energy rather than byte counts. It has
three states:

- **not being sent** — the microphone is not attached to that connection at all. That is an app
  fault; press Copy diagnostics and report it.
- **muted, sending silence** — see below.
- a bitrate followed by either **speech detected · level n** or **SILENT (mic open, no sound)**.
  The second one is the case that used to be invisible: the microphone opened without error and
  packets are flowing, but nothing is in them. Usually the Windows default device is not the
  headset, a hardware mute switch is on, or Settings › System › Sound › Volume mixer has a
  different input device set for this app.

Alongside it: **Their mic** and **Their shared audio** (what is arriving from them, by track
role), **Playback** (whether the `<audio>` element for them is playing, paused, or *blocked* — a
blocked one also shows a "click to enable audio" banner and is retried on your next click),
**Directions** (each transceiver's direction and current direction), and **They hear you** — the
other side reports once a second, over a data channel, the level it is receiving from you and the
state of its player, so each tile can say *can hear you (0.x)*, *cannot hear you*, or *receiving
but not playing*. **Request their diagnostics** pulls the other side's whole dump into yours.

**Bytes prove nothing.** Muting does **not** stop audio packets. Mute here is
`track.enabled = false`, which keeps the RTP session up and sends silence — measured at around
14 kbps — so unmuting is instant with no encoder ramp, and it is exactly why a separate
`mute-state` message has to exist. A muted mic and a silent mic both show ~14 kbps, which is why
Stats reports level and speech rather than pretending the number means anything.

**The Audio check.** A guided five-step wizard from the mic menu or Stats: say something (the bar
should move, and it names the device that was opened); mute and keep talking — *do you still hear
yourself?*; unmute and talk for five seconds while it measures what leaves the machine and what
the other side reports; ask them to talk; a summary with Copy diagnostics.

Step two answers the question that lost the call. **If you hear your own voice while muted, it
is not this app.** It sends nothing while muted and never plays your microphone back to you. It
is Windows **Listen to this device** (Control Panel › Sound › Recording › your mic › Properties ›
Listen), headset or driver sidetone (Realtek input monitoring, SteelSeries Sonar, Logitech G Hub,
iCUE, Voicemeeter, NVIDIA Broadcast), or Bluetooth HFP sidetone that engages whenever any app
holds the microphone — the *Release microphone for 3 s* test shows that one: the voice goes away
while the mic is released and returns when it reopens. Confirm by closing the app entirely; the
voice persists. If you answer *no*, the echo only happens while you are unmuted, so it is coming
back from the other side — and if they are sharing from this desktop app, that is the system
audio loopback above: ask them to untick **Share system audio**, or use headphones.

**Echo cancellation does not fix local self-hearing.** `echoCancellation` stays on in
`config.default.json` because two laptops on speakers need it, but AEC processes only the signal
you *send*. It cannot stop you hearing yourself through Windows or a headset, and it does nothing
for a microphone that delivers silence. The one microphone problem that produces an outright
error is Settings › Privacy & security › Microphone › *Let desktop apps access your microphone*
switched off, which makes `getUserMedia` fail and is reported as the microphone could not be
opened.

**Copy diagnostics** puts a JSON dump on the clipboard and in a selectable dialog: environment,
room, the microphone's label and settings, devices, meter state, playback sinks, per-peer stats
and reports, a timeline of audio events and the last log lines. Every audio log line starts with
`audio:` or `audio-check:`.

## Windows microphone mute check

The most common microphone failure. Mute the microphone in Windows — the F-row key with the
microphone icon whose light stays on while muted, or Settings › System › Sound › Input › your
device › mute — and the app still opens it without an error: packets flow, and every sample is
zero. Measured on the laptop that hit it, the processed signal sat at one 16-bit LSB of peak
(≈ 3e-5); a live but quiet room with noise suppression reads two or three times that, and speech
a thousand times.

The page does see this one. Chromium polls the endpoint's mute state once a second (measured on
Electron 33 / Chrome 130, real device): a track opened while the endpoint is muted reports
`muted: true` from its first tick, muting a live endpoint sets `muted: true` and fires `mute`
within about a second, and unmuting fires `unmute`. The lobby and the room read that flag off the
original track and name the Windows mute first — the short in-room hint is *مفيش صوت — اتأكد إن
ويندوز مش كاتم المايك ▴* / *no sound — check the Windows mic mute ▴*. What no page can see is an
APO or hardware gate that delivers real near-zero samples with `muted: false` (measured
processed peak 6e-5 to 1e-4, against 0.1 to 0.2 for speech); for that one the lobby's
silent-after-6-seconds escalation stays as the fallback. The desktop app adds a **second
line of defence**: the main process asks Windows directly, which gives a definitive read, catches
an input volume of 0 (as silent as a mute, and invisible to the track), lists *every* active
microphone rather than the one Chromium opened, and can clear the mute flag with one click — the
one thing the page has no API for.

**What is checked.** The default *capture* endpoint for the console role — the device Chromium
opens as "default" — through Core Audio (`IMMDeviceEnumerator` › `IAudioEndpointVolume`):
its friendly name, its mute flag, and its master volume as a 0–100 integer. Alongside it, every
active capture endpoint (`EnumAudioEndpoints` eCapture / `DEVICE_STATE_ACTIVE`, at most 32) with
the same three fields and `isDefault`, true for exactly one of them — the one whose id matches
the console default. No administrator rights. This is not the privacy gate (Settings › Privacy &
security › Microphone), which is a different failure: that one makes `getUserMedia` fail
outright and is reported by the page.

**When the dialog appears.** The first time the permission handler *grants* a `media` request
on a page load — the lobby's `getUserMedia` — one check runs (once per page load, never two at
once; never under `STREAMER_DESKTOP_TEST=1`). Lobby and room are one document and Join adopts
the lobby stream, so the later `getUserMedia` calls of the same page — a device switch in the
mic menu, a processing toggle, the release-for-3-s test — do not re-open the box mid-call; the
next full navigation (the next room visit) checks again. If the default endpoint is **muted or
its volume is 0**, a warning box opens on that window, Arabic line first then English. Muted:
*The Windows default microphone (name) is muted — if this app is using it, nobody will hear
you*, naming the endpoint and its volume, with the two ways to unmute — the mic-mute key (its
LED is on while muted) and Settings › System › Sound › Input › the device › unmute — and an
**Unmute now** button that clears the flag through the same helper and reads the state back; if
it is still muted, or the helper failed, a short error box says so and points back at the key
and Settings. Volume 0: *The Windows default microphone (name) input volume is 0 — if this app
is using it, nobody will hear you*, and the detail says the input volume is 0 and must be raised in
Settings › System › Sound › Input › the device; there is no Unmute button, because there is no
flag to clear (a device that is both muted and at 0 gets the muted headline, both lines, and the
button). Either way the detail ends with: *if a different microphone was picked inside the app,
check that one in Settings* — the check reads the Windows default, and the app's mic menu may
have opened another. **Ignore** closes it. *Don't ask again while the app is open* is a
session-only flag: it lives in a variable, nothing is persisted, and the next launch asks again.

**The Debug menu item.** Press Alt, then Debug › **Windows microphone status…** (Windows only)
reads on demand and shows the default device's name / muted / volume, a note when the volume is
0, and then every active microphone, one per line — name, muted or not, volume — with the
default marked ★. An **Unmute** button appears when the default is muted. The status is also
read and logged once, right after the app starts, so a `desktop.log` from a bug report begins
with the answer.

**The helper.** `desktop/win/mic-endpoint.ps1`, run as
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path> -Command get`
(or `unmute`), with a 15-second timeout and no window. It prints exactly one line of ASCII JSON:

```
{"name":"Microphone Array (Intel® Smart Sound Technology for Digital Microphones)","muted":true,"volume":85,"endpoints":[{"name":"Microphone Array (Intel® Smart Sound Technology for Digital Microphones)","muted":true,"volume":85,"isDefault":true},{"name":"Headset Microphone (Jabra)","muted":false,"volume":60,"isDefault":false}]}
```

(non-ASCII characters are `\u`-escaped on the wire) or, with exit code 1, `{"error":"<message>"}`
— for example when there is no capture device at all. `unmute` clears the flag on the default
endpoint only and takes no further argument. Nothing from the app is ever interpolated into the
script or its arguments beyond that one fixed word. `desktop/mic-status.js` parses the line
strictly (`parseMicStatus`: exactly those four keys, a boolean, an integer in range, one line,
and an `endpoints` array of 1–32 entries each holding exactly `name`/`muted`/`volume`/`isDefault`
with the right types) and turns anything else into `null`; it never throws. PowerShell is always
run by its absolute path under `%SystemRoot%` — never the bare name, which `execFile` would look
up in the working directory first; if `SystemRoot` is unset or the executable is missing, the
read resolves `null` and the log says why. The script ships as a plain file — the bundle is not
an asar archive — and `asarUnpack` in `electron-builder.yml` keeps it one if that ever changes.

**What is logged**, one line each in `desktop.log`: `mic-status` (the status including the
endpoint list, `endpoints: n`, or the error, and how long the helper took), `mic-mute-dialog`
(which button was chosen, whether the problem was `muted` or `volume-zero`, and whether the
don't-ask-again box was ticked, or that the dialog was skipped because it was), and
`mic-unmute` (the status after clearing the flag, or the error). Never the audio, never anything
that identifies the machine beyond the endpoints' names.

## Fullscreen

The video fills the screen from the **Fullscreen** button, by **double-clicking the video**, or by
pressing **F**. Escape leaves.

The stage container goes fullscreen rather than the `<video>` element, because fullscreening the
element itself replaces everything with a bare video surface — losing the sharer label and every
control with it. A small overlay appears inside fullscreen with mute, the level meter, and an exit
button, and fades out after a few seconds of no mouse movement.

## Debug menu and logs

The menu bar is auto-hidden; **press Alt** to reveal it, and a **Debug** menu is there.

**Open log folder** opens `<userData>\logs\` — `%APPDATA%\Streamer\logs\` on an installed
build — which holds `desktop.log`, the main-process log. One line per event: ISO timestamp,
event name, JSON detail; never SDP and never addresses. What lands there:

- `permission` — every permission decision the app makes (`media`, `display-capture`,
  `clipboard-sanitized-write`, `fullscreen`), with the origin and whether it was trusted and
  granted. A denied `media` request is indistinguishable from a broken microphone from inside
  the page, so this is where to check first.
- `display-capture` — which source was picked, whether it was a screen or a window, and whether
  system audio was `loopback` or `none`.
- `internals-page-failed` — when one of the pages below could not load (`code`, `description`).
- `internals-page-blank` — when one of the pages below loaded but rendered no text; the window
  also shows an info box saying the page rendered blank in this Electron build and pointing at
  Copy diagnostics.
- `mic-status`, `mic-mute-dialog`, `mic-unmute` — the Windows microphone mute check above: what
  Windows said about the default microphone and every active one (`endpoints: n`), what was
  chosen in the warning box and whether it was about the mute flag or a volume of 0, and what
  clearing the flag gave back.

The renderer's own `audio:` lines are not in this file; they are in Copy diagnostics.

The Debug items, in menu order: **Open log folder**; **Open WebRTC internals**; **Open media
internals (capture devices)**; and, on Windows only, **Windows microphone status…**.

**Open WebRTC internals** and **Open media internals (capture devices)** open
`chrome://webrtc-internals` and `chrome://media-internals` in a sandboxed window. Media internals
lists the exact capture device and parameters Chromium opened, which no renderer API exposes.
**They may render blank in some Electron versions**; a load failure is logged as
`internals-page-failed`, and a page that loads with no text is logged as `internals-page-blank`
and announced in an info box rather than being promised, so if you get an empty window,
`desktop.log` says why.

**Windows microphone status…** (Windows only) reads the default microphone's mute flag and
volume from Windows, lists every active microphone with the default marked ★, and offers to
unmute the default when it is muted; see *Windows microphone mute check* above.

The renderer console is under **View › Toggle Developer Tools**; the standard File/Edit/View/Window
menus are kept alongside Debug, so Reload and zoom keep their shortcuts.

## Updates

The Home screen shows which version is running and checks GitHub for a newer one at launch.

**Nothing downloads on its own.** This app gets used mid-call, and an update that quietly fetches
80 MB and then wants to restart would drop everyone in the room. When one is available you get a
**Download** button, and then **Restart and install** when it is ready.

A check that cannot run — no internet, a rate limit, no release published yet, or running from
source — says so plainly and leaves the app completely usable. It never reports "up to date"
when the truth is that nothing could be checked; those are different claims, and conflating them
stops you looking for the real reason.

Publishing a release:

```
GH_TOKEN=<token with repo scope>  npx electron-builder --win --publish always
```

The token lives in the build environment only and never enters the installer. Bump `version` in
`package.json` first, or nothing is ever offered.

**The build your friend already has cannot update itself** — it predates this and knows nothing
about GitHub, so the first new version still has to be handed over once. After that it is a button.
