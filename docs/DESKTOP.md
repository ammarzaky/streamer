# The desktop app

One Windows application that can either host a room or join one. It is the same web client
inside — the app loads `https://<host>:<port>/r/<id>` exactly as a browser would — plus the three
things a browser cannot do.

## What it changes

| | Browser | Desktop app |
|---|---|---|
| Certificate | Install `certs/ca.crt`, or click through a warning every time | Nothing. The invite carries the fingerprint |
| Screen picker | Chrome's dialog, with a "share audio" checkbox people miss | The app's own picker |
| System audio | Only if you remember the checkbox, and only for tabs | Captured automatically, as a separate track |
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

The picker lists screens and windows with live thumbnails. On Windows the app also captures
**system audio** — whatever the machine is playing — as a track separate from your microphone.

Muting your microphone does not silence what you are sharing. They are different tracks on
different senders, and the mute control only ever touches the microphone. That separation is
enforced by a test.

macOS and Linux cannot capture system audio this way. The picker says so rather than sharing
silently.

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

A call was lost to this exact question, so it is answerable in three places now — each one
covering a different failure.

**Before you join.** The lobby shows a level meter. Speak, and the bar moves. A blocked or
missing microphone is reported there, which is the one moment it can be fixed without an
audience waiting.

**During the call, in Stats.** Two rows that did not exist before:

- **Sending mic** — the audio actually leaving this machine, per person. If it reads
  *not being sent*, the microphone is not attached to that connection at all; that is a fault,
  and it used to be completely invisible from either end.
- **Receiving audio** — what is arriving from them, so the other side can confirm from their own
  screen instead of the two of you comparing guesses.

**A detail worth knowing:** muting does **not** stop audio packets. Mute here is
`track.enabled = false`, which keeps the RTP session up and sends silence — measured at around
14 kbps. That is deliberate: it means unmuting is instant with no encoder ramp, and it is exactly
why a separate `mute-state` message has to exist, since the far end cannot tell you are muted by
looking at traffic. Stats says *muted, sending silence* rather than pretending the number is zero.

## Fullscreen

The video fills the screen from the **Fullscreen** button, by **double-clicking the video**, or by
pressing **F**. Escape leaves.

The stage container goes fullscreen rather than the `<video>` element, because fullscreening the
element itself replaces everything with a bare video surface — losing the sharer label and every
control with it. A small overlay appears inside fullscreen with mute, the level meter, and an exit
button, and fades out after a few seconds of no mouse movement.

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
