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

Check the microphone button — **you start muted on purpose**, so that joining a call never puts
you live before you have said anything. If it is unmuted and still silent, check the browser's
site permissions and that no other application has exclusive hold of the microphone.

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

Open the browser console. The client keeps a rolling diagnostic log, redacted of connection
details:

```js
copy(window.__app?.diagnostics?.() ?? 'not in a room')
```

The server logs to stdout only — never to a file, and never SDP or ICE candidates. For more:

```bash
STREAMER_LOG_LEVEL=debug npm start
```

`chrome://webrtc-internals` (Chrome/Edge) shows every peer connection in complete detail and is
the right tool for anything genuinely puzzling about media.
