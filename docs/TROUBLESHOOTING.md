# Troubleshooting

Symptom first, because that is what you have.

---

## The page will not load

### "This site can't be reached" / nothing happens

**You typed the address without `https://`.** A bare `192.168.1.34:8443` is treated as `http://`
by every browser, and a TLS port cannot answer a plaintext request — the connection is dropped
with no hint that the address was right and only the scheme was wrong. The server now detects
this and redirects, so it should just work; if you are on an older build, type `https://`.

**On the same network:** the Windows Firewall prompt was denied, or was allowed only for Public
networks. Re-run `npm start` and allow it for **Private**. Confirm the server is actually
running and check the address with `npm run links`.

**Still nothing, and the address is definitely right?** Check your antivirus. Avast, Kaspersky and
Norton run their own firewall alongside Windows Firewall, and allowing the app in one does nothing
for the other — this is the single most time-consuming false lead in this whole document, because
every Windows-side check passes while nothing gets through. Disable the antivirus firewall for two
minutes to confirm, then add a permanent rule there.

**From another network:** this is connection 1 in [NETWORK.md](NETWORK.md), and it has nothing
to do with WebRTC. Port 8443 is not reachable from outside. Check this *before* investigating
anything about video, because until the page loads no peer connection is even attempted.

### A certificate warning

Expected in a **browser**. See [CERTIFICATES.md](CERTIFICATES.md). Verify the fingerprint with
`npm run links`, then click through — or install `certs/ca.crt` on the device to stop seeing it.

In the **desktop app** you should never see one: the invite link carries the fingerprint. If you
do, you were sent an `https://` link rather than a `streamer://` one — ask for the app link.

### The app says it refused to connect because the certificate did not match

Not the same thing as a warning, and not something to click past — the app reached the machine and
declined to trust it. Usually the host reissued their certificate (a new LAN IP will do it) and
your link is stale, so ask for a fresh one. If a link you trust keeps doing this, stop and find
out why the certificate is changing before going further.

### Nothing happens when I open a `streamer://` link

Chat clients often strip or mangle custom protocol links. Copy the text and paste it into the
app's Join box instead — it accepts a pasted link, and tells you what it parsed before you press
Join.

### "Screen sharing needs a secure connection"

The page is on `http://`. Use `https://`. The capture APIs do not exist at all outside a secure
context, which is why this is a blocking message rather than a warning.

---

## The page loads but nothing works

### "Can't reach the server. Check that it's running…"

The page loaded but the WebSocket did not open. Almost always one of:

1. **The certificate was never accepted for this exact address.** A rejected WebSocket
   handshake produces no interstitial and no diagnosable error — the browser simply closes it.
   Open the same address in a tab, accept the warning, and reload.
2. **The page and the socket are different origins.** Always use the address `npm run links`
   prints; do not mix `localhost` and the LAN IP.
3. **The server stopped.**

### "This room doesn't exist, or it has already ended"

Rooms are in memory only. Restarting the server ends every room. Ask for a new link.

### "This room is full"

Four participants by default. If someone's connection dropped without a clean exit, their slot
is released within about 35 seconds — the app clears stale slots before refusing anyone, so
waiting briefly and retrying works. Raise `rooms.maxParticipants` if you genuinely need more,
bearing in mind the cost grows with every participant.

---

## Video and audio problems

### "Couldn't connect directly to this person"

The server is reachable but a direct path between the two browsers is not. This is connection 2
in [NETWORK.md](NETWORK.md).

On the same network this should not happen; check for client isolation (guest Wi-Fi networks
often block devices from seeing each other). Across networks it may be CGNAT, symmetric NAT, or
a firewall that blocks UDP — in which case a direct connection is genuinely impossible and only
a TURN relay would help. That is a deliberate choice, not a default, because it routes your
media through a third party.

### The video is blurry, or the frame rate is low

Open the stats panel and read **Limited by**:

| Value | Meaning | What helps |
|---|---|---|
| **This device (CPU)** | Encoding is the bottleneck | Lower the preset; share one window instead of a whole monitor; close other applications |
| **Upload speed** | Your uplink is the bottleneck | Lower the preset, and set `uploadBudgetKbps` to your real upload speed |
| **Upload shared across peers** | Your budget divided by the number of people | Fewer participants, a lower preset, or a higher budget if your line supports it |
| **Nothing** | Not limited | The source itself may be low resolution |

Remember the app shows **Target** and **Actual** separately. A gap is information, not a bug —
asking for 1080p60 is a request to the operating system and then to the encoder, and neither
guarantees it.

### The quality drops on its own

That is the intended behaviour, and it is what keeps a call alive rather than letting it
collapse. A toast says why. Turn it off with `"media": { "autoAdapt": false }` if you would
rather it stayed put and degraded on its own terms.

### The picture went soft after switching what I share

Chrome's "Share this tab instead" swaps the source while keeping the same track, and the app
re-reads the new dimensions on the next stats tick. Give it a second. If it persists, stop and
restart the share.

### Nobody can hear me

Work down this ladder in order. Each step uses something the app shows you; stop at the first
one that fails, because everything below it is downstream of it.

1. **The microphone is muted in Windows.** By far the most common cause, and the app sees it:
   Windows still opens the device, but the browser marks the track muted within a second of
   the key being pressed (and from the first moment if it was already down). The join screen
   says so at once — the line under the level bar turns red, names the device, and reads
   *"Windows has muted "…" — press the microphone-mute key in the F row (its light is on while
   muted; F9 on ASUS laptops) or open Settings › System › Sound › Input › "…" and unmute it"*;
   no six-second wait. Inside the room the same thing is the red hint above Mute, *"Windows
   muted "…" — mic-mute key / Sound › Input › unmute"*, plus a banner. Press the
   **microphone-mute key** on the keyboard (an F-row key with a microphone icon; its light is on
   while muted), or open **Settings › System › Sound › Input › your microphone** and unmute it:
   the bar starts moving and the line clears by itself, nothing to reload. If the line is amber
   instead (*"No sound has reached the app … for 6 seconds"* / *"no sound — check the Windows
   mic mute ▴"*), the browser sees the device as unmuted but it delivers nothing: a mute applied
   below the endpoint by the driver or a headset switch, or the input volume at 0 — check the
   same Sound › Input page, then the headset. In the desktop app, **Debug › "Windows microphone
   status…"** reads the real Windows mute state of the capture device and can unmute it from
   there.
2. **The Mute button.** You start muted on purpose. Unmute.
3. **The lobby bar.** Before you join, the join screen opens the microphone with the same
   settings the room will use and shows a level bar plus the name of the device it actually
   opened. Talk. A red line saying Windows has muted the device is step 1, and it clears the
   moment you unmute. If the bar does not move for six seconds with no red line, the line turns
   amber and still points at the Windows mute first (step 1); after that, use the microphone
   **select** under it and try the others. On Windows the "System default" entry is the *console* device, which
   is frequently not your headset — the headset is usually the *Default communications device*,
   listed separately. A hardware mute switch on the headset shows up here as a flat bar too.
   If the device goes away while the join screen is open (headset unplugged, another app
   seized it) the line turns red and says *"No microphone found"* rather than blaming the
   mute key; plug it back in and the check restarts by itself.
   If the lobby says *"The microphone could not be opened"*: another app holds it, or Windows
   refused it — **Settings › Privacy & security › Microphone › "Let desktop apps access your
   microphone"** (this makes the request fail outright on Windows; it does not deliver
   silence), and **Settings › System › Sound › Volume mixer › this app › Input device**.
4. **The bar inside the Mute button.** The room adopts the lobby's stream rather than
   re-opening the device, and the bar keeps running while you are in the room. Green and moving
   while you talk means your voice is reaching the app. The one-line hint above the button is
   the app's verdict (e.g. *"Windows muted "…" — mic-mute key / Sound › Input › unmute"*,
   *"no sound — check the Windows mic mute ▴"*, *"mic stopped"*). Open the **mic menu** (the
   caret next to Mute) to switch device or toggle echo
   cancellation / noise suppression / gain control — changing those re-opens the microphone,
   and the menu shows what the browser actually applied.
5. **Stats › "Sending mic".** Open the stats panel. This row reads what the *encoder was given*,
   not bytes on the wire, and has three states:
   - `not being sent` — no microphone track is attached to that connection at all (the hint
     says *"mic not attached"*; that is an app fault — copy diagnostics and report it);
   - `<rate> — muted, sending silence` — you are muted;
   - `<rate> · speech detected · level n` versus `<rate> · SILENT (mic open, no sound)` — the
     second is the classic Windows failure: the device is open and delivering nothing. Go back
     to steps 1–3: the Windows mute first, then the headset.
   **Bitrate proves nothing.** A muted or silent microphone still sends ~14 kbps of encoded
   silence, so a healthy-looking kbps figure is not evidence that anyone can hear you.
6. **Self test.** Mic menu › **Record 3 s and play it back**. It records from the exact track the
   room is sending and reports the peak level. *"Recorded silence"* means the microphone
   delivers nothing to the app, regardless of what any other program shows. **Save recording**
   keeps the clip for a bug report.
7. **The friend's side.** Each peer's tile shows *"can hear you (0.x)"*, *"cannot hear you"* or
   *"receiving but not playing"*, fed by a once-a-second report from their app of what it
   receives from you and whether its `<audio>` element is playing. The same appears as **They
   hear you** in Stats. *Receiving but not playing* means their browser blocked playback until
   they click — they see a "click to enable audio" banner, and the app retries on their next
   click. Their own Stats have **Their mic** / **Their shared audio** / **Playback** for the
   reverse direction, and **Directions** shows each transceiver's negotiated direction if you
   suspect the offer itself is wrong.
8. **Audio check / Copy diagnostics.** Mic menu › **Audio check** walks through all of the above
   in five guided steps and ends with a summary you can copy. **Copy diagnostics** puts the
   whole dump (devices, applied settings, meter state, per-peer stats and their reports, the
   audio timeline, the log) on the clipboard and in a selectable dialog; **Request their
   diagnostics** in Stats pulls the same dump from a peer over the data channel and folds it in.

### I hear my own voice, even when muted

This is never the app. While muted it sends nothing, and at no point does it play your own
microphone back to you — the Audio check shows the proof (`track.enabled=false`, zero audio
elements carrying your mic). What you hear is monitoring done by Windows or by your headset:

- **Windows "Listen to this device"**: Control Panel › **Sound › Recording › your microphone ›
  Properties › Listen › untick "Listen to this device"**.
- **Sidetone / mic monitoring** in headset or driver software: Realtek "Input monitoring",
  SteelSeries Sonar, Logitech G Hub, Corsair iCUE, Voicemeeter, NVIDIA Broadcast.
- **Bluetooth (HFP)** and some USB headsets turn sidetone on only while *some* app holds the
  microphone, which is why it seems to start when you join a call.

Confirm it in the app before touching settings:

1. Mic menu › **Mute incoming audio (test)**. Nothing from the room is played at all. If you
   still hear yourself, the sound is not coming from this app.
2. Mic menu › **Release microphone for 3 s**. If your voice disappears while the device is
   released and returns when it re-opens, it is sidetone that engages whenever the microphone
   is held — look in the headset software.
3. Close the app entirely and talk. The voice will still be there.

Echo cancellation cannot help: it only shapes the signal that is *sent*, it cannot stop your
own machine playing you back locally, and it does nothing for a silent capture. Leave it on.

### I hear myself only while my friend shares from the desktop app

Then it is coming back from their side. The desktop picker's **Share system audio** box
(default on, Windows only) captures the entire system mix through Windows loopback — including
that app's own playback of you and everyone else — so whatever you say goes out again inside
their shared audio. This is a platform limitation (electron/electron#27337), not something echo
cancellation or the app can filter out. Ask them to untick **Share system audio**, or have
everyone use headphones. Step 2 of the Audio check ("No, I do not hear myself while muted")
points to exactly this.

### The level bar

There are three, all fed by the same meter, which runs on a clone of the microphone track so it
keeps working while you are muted:

- on the join screen, next to the microphone select (a device Windows has muted turns the line
  red and the bar amber at once; six seconds without any sound from an unmuted device turns the
  line amber — see *Nobody can hear me*, step 1);
- **inside the Mute button** and in your own tile, always visible in the room;
- in the fullscreen overlay (previously the only one, which is why in-room silence went
  unnoticed for so long).

Colours: **green** — live and moving with your voice; **amber** — you are muted but the
microphone is working (the bar still moves; nothing is sent), or, on the join screen, Windows
has the device muted; **red** — dead: the track ended, the device was unplugged or seized. The
hint above Mute says which. If the hint says *"click the page"*, the browser has suspended the
meter's audio engine until a user gesture; any click resumes it.

### Muting my mic silenced the video I'm sharing

It should not, and there is a test asserting it does not. The microphone and the audio of a
shared window are separate tracks. If you see this, the shared audio was probably never
captured: the picker has a separate "share audio" checkbox, and it is off by default for some
surface types.

### I can't hear the audio of what someone is sharing

They may not have ticked "share audio" in the picker. Sharing a **tab** offers it most
reliably; whole-screen audio is not available on every platform.

---

## Sharing

### The Share button says "Take over"

Someone else is sharing. One person shares at a time. Taking over stops theirs.

### My share stopped by itself

Either someone took over, or the browser's own "Stop sharing" control was used. Both show a
message saying which.

### Nothing happens when I click Share

The picker was probably dismissed, which is treated as a normal action rather than an error. On
macOS, check **System Settings → Privacy & Security → Screen Recording** for your browser.

---

## Host and session

### I reloaded and I'm not the host any more

You have about 30 seconds to come back before the role passes to the longest-present
participant. The token that restores it lives in that tab's `sessionStorage`, so it works for a
reload but not if you closed the tab or opened the link in a different browser.

### There is no "End" button

Only the host has it. If the host left, the role passes to whoever has been there longest.

---

## Getting more detail

**In the app:** mic menu › **Copy diagnostics** (also the last step of **Audio check**). It
copies a JSON dump to the clipboard and shows it in a selectable dialog: environment, room, your
mic (label and the settings the browser actually applied), the lobby result, meter state,
devices and audio sinks, self-test result, every peer's stats, what they report hearing from you,
transceiver directions, any diagnostics they sent back, a 120-entry audio timeline and the last
800 log lines. Connection details are redacted. The lines this feature adds start with `audio:`
or `audio-check:`; the two acquisition failures that precede them are `mic-check: unavailable`
(lobby) and `media: getUserMedia failed` (room).

**In the console**, the same numbers are always available read-only:

```js
window.__app.audio()        // devices, meter, health, sinks
window.__app.micSettings()  // label + getSettings() of the track being sent
window.__app.micLevel(); window.__app.meterState(); window.__app.devices()
window.__app.transceivers(); window.__app.peerReports(); window.__app.audioTimeline()
copy(window.__app.diagnostics())   // the full dump
```

**Desktop app:** hold **Alt** to reveal the menu bar; the **Debug** menu has *Open log folder*
(the main-process log at `<userData>/logs/desktop.log` — permission decisions and
display-capture choices), *Open WebRTC internals*, *Open media internals (capture devices)*
and, on Windows, *Windows microphone status…* (reads the capture endpoint's real mute state via
Core Audio and can unmute it). Developer Tools are under the standard **View** menu. The
internals pages render blank in some Electron versions; failures are logged.

The server logs to stdout only — never to a file, and never SDP or ICE candidates. For more:

```bash
STREAMER_LOG_LEVEL=debug npm start
```

`chrome://webrtc-internals` (Chrome/Edge) shows every peer connection in complete detail and is
the right tool for anything genuinely puzzling about media.
