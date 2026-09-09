# Streamer

Private screen sharing for a small group. Your machine runs a small server that hosts the page
and introduces browsers to each other; the audio and video then go **directly between those
browsers** and never pass through it.

No accounts, no analytics, no recording, no database.

---

There are two ways to run it: a **desktop app** for Windows, or a **browser** against a server you
start yourself. Both talk to each other — one person can be in the app while another is in Chrome.

## Quick start — desktop app (recommended)

```bash
npm install
npm run app          # run it
npm run build        # or build an installer into dist/
```

Press **Start a room**, then send the link the room panel shows you.

- **On the same network**, the `streamer://` link carries the fingerprint of your server's
  certificate, so the app trusts that one certificate and nothing else — **nothing to install, no
  warning to dismiss.**
- **From anywhere else**, switch on **Open a public link over Cloudflare**. It works on networks
  you do not administer, needs no port forwarding and no firewall rule, and arrives with a real
  certificate. Only signalling goes through Cloudflare; audio and video stay peer-to-peer.

The app also replaces Chrome's screen picker with its own and captures system audio without anyone
having to remember a checkbox.

Full detail, including the SmartScreen warning on the unsigned installer:
[docs/DESKTOP.md](docs/DESKTOP.md).

## Quick start — browser

```bash
npm install
npm start
```

Then open **https://localhost:8443**.

Your browser will warn about the certificate the first time. That is expected — the server
generates its own, because browsers refuse to give any page a microphone or a screen without
HTTPS. See [docs/CERTIFICATES.md](docs/CERTIFICATES.md).

To invite other people on your network:

```bash
npm run links
```

That prints the address to send them, the certificate fingerprint they can check it against,
and what would need to change for someone outside your network to join.

**Neither option changes the networking.** Reaching your machine from another network still needs
a public address and an open port — read [docs/NETWORK.md](docs/NETWORK.md) before assuming
otherwise.

---

## What it does

- **Create a room**, get a link, send it to whoever should be there.
- **Share your screen** — a monitor, a window, or a browser tab, with its audio if you want.
- **One person shares at a time**, with a "take over" confirmation. Taking over genuinely stops
  the previous share rather than just relabelling it.
- **Mute and unmute your microphone.** Muting your mic does *not* silence the audio of whatever
  you are sharing; they are separate.
- **Pick your microphone and see it working.** A microphone picker in the lobby and in the
  room, a level bar that is always visible (inside the Mute button and on your own tile, and it
  keeps moving while you are muted), and an **Audio check** with a plain verdict — "they can
  hear you", "mic open but silent", "playback blocked" — plus a one-click diagnostics dump.
- **Pick your speaker, and set each person's volume from 0 to 500%** — from the caret next to
  Mute, without leaving the room. The boost is real rather than a relabelled slider: above 100%
  the audio leaves the `<audio>` element, which the specification caps at 1, and goes through a
  gain stage with a limiter so that loud does not become distorted. It is entirely local; the
  person you turned up is never told.
- **See who is in the room**, who is muted, who is sharing, and whether each connection is
  healthy.
- **A stats panel** showing bitrate, frame rate, resolution, connection type, and — the useful
  one — what is currently limiting your quality.
- **Up to 4 people** by default, because everyone connects to everyone else.

---

## Quality

The default target is **1080p at 60fps**, and the app adapts downward on its own when the
network or the CPU cannot keep up. You can also pick a preset manually:

| Preset | Bitrate ceiling | Good for |
|---|---|---|
| 480p 30 | 0.8 Mbps | A poor connection |
| 720p 30 | 1.2 Mbps | Reading text, screenshares of documents |
| 720p 60 | 3 Mbps | A balance |
| 1080p 30 | 3.5 Mbps | Sharp text at full size |
| **1080p 60** | **6 Mbps** | **Default** — the ceiling; how it is spent is decided below |

**The preset is a ceiling, not a style.** A shared screen is two different problems wearing one
name. A code editor or a document is a *still* picture: a desktop capturer only emits frames
that changed, so it produces one to three frames per second whatever you pick — and telling the
encoder to protect the frame rate then spends the whole bitrate on frames nobody is producing,
paid for in the sharpness you can actually see. Video or a game is the opposite.

So the app does not make you choose. It watches the *capture's* own frame rate — not the
encoder's, which would be circular — and switches the encoder between "sharpness first" and
"frame rate first" on its own, with hysteresis so a moment of scrolling does not flip it. The
quality menu shows which one is in force under **Content**.

**Treat any preset as a target, not a promise.** Asking for a resolution and frame rate is a
request to your operating system and then to the encoder; neither guarantees the result. The
app shows you the target and what is *actually* being delivered side by side, along with the
reason for any gap:

```
Target  1920x1080 @ 60   Actual  1920×1080 @ 2   Limited by  Nothing   Content  Still picture
```

While someone *else* is sharing, that button shows what you are **receiving** instead. Your own
preset describes a stream you are not sending, and it is never transmitted — so it can say
nothing about the picture on your screen.

### The one number worth correcting

`media.uploadBudgetKbps` in `config.json` defaults to **20000** (20 Mbps), which is a LAN or
fibre figure. It is divided by the number of people you are sending to, so at 4 participants
each gets about 6.7 Mbps — which is what makes the 1080p60 default reachable.

If your actual upload speed is lower, **set it to your real figure.** A budget far above your
real uplink means the app happily saturates your connection before adapting, and a saturated
uplink takes the audio and the signaling connection down with it. This is the single most
useful value to get right.

Bear in mind that when you share, you encode and upload a **separate copy for each other
person**. With three other participants at 1080p60, that is roughly 18 Mbps upstream and three
simultaneous encodes on your machine. On most laptops the CPU runs out before the network does,
which is why automatic step-down is on by default.

---

## Configuration

`config.default.json` documents every option and is not meant to be edited. Create a
`config.json` next to it with just the values you want to change:

```json
{
  "media": { "uploadBudgetKbps": 5000, "defaultPreset": "720p60" },
  "rooms": { "maxParticipants": 3 }
}
```

Secrets belong in environment variables rather than a file you might share:
`STREAMER_PORT`, `STREAMER_MAX_PARTICIPANTS`, `STREAMER_ACCESS_CODE`, `STREAMER_TURN_*`.

---

## Privacy, stated precisely

**What the server sees:** who is in which room, display names, and the connection details
browsers need to find each other. All of it in memory only; nothing is written to disk and
nothing survives a restart.

**What the server never sees:** your screen, your microphone, or any audio or video at all.
That traffic goes browser-to-browser.

**What the app stores in your browser:** at most two items, both in `sessionStorage`, both
per-tab, both gone when you close the tab.

1. A **host token**, so that if you are the host and you reload the page, you get your role
   back instead of handing it to someone else. Deleted when you leave.
2. Your **audio preferences** — which speaker you picked and how loud you set each
   participant — written only if you actually change one of them. Volumes are keyed by
   participant name so a reconnect does not lose them. Nothing here is sent anywhere: the
   people you turned up or down are never told.

No cookies, no `localStorage`, no IndexedDB, no cache. There is an automated test asserting
exactly that, and it fails if a third key appears. The audio diagnostics add nothing to this:
the level meter, device list and verdicts live in page memory only.

**What the audio diagnostics expose:** read-only accessors on `window.__app` (`audio()`,
`micSettings()`, `micLevel()`, `devices()`, `diagnostics()`, …) are always installed, so a
person with the console open can read the same numbers the panel shows. They cannot change
anything; the hooks that can are installed only under the E2E test flag. "Can they hear me"
and "request their diagnostics" travel **peer-to-peer over an RTCDataChannel** on the same
connection as the audio — never through the server, which sees none of it.

**What the desktop app writes to disk:** one small log, `logs/desktop.log` under its user-data
folder, recording permission decisions and screen-picker choices (what was shared, whether
system audio was included). No audio, no video, no content.

**Two caveats worth stating rather than burying:**

1. **STUN servers are a third party.** By default each browser asks Google's public STUN
   servers what its own public address is, which tells them your IP and when you were in a
   call. No content, but not nothing. Set `"iceServers": []` for local-network use, or point it
   at your own server. See [docs/NETWORK.md](docs/NETWORK.md).
2. **Access control is the room link.** Anyone with the link can join while the room exists.
   There is no kick and no ban. Treat the link as the credential it is; to revoke access, end
   the session and start a new room.

---

## Joining from outside your network

**This works on your own network with no setup. Getting in from elsewhere is a separate job,
and no software can promise it will work on every network.**

Two independent things must succeed: the other person must be able to *reach your machine* over
HTTPS at all, and then their browser must be able to open a *direct connection* to yours. They
fail for entirely different reasons, and the first is a prerequisite for the second.

[docs/NETWORK.md](docs/NETWORK.md) explains what to configure, how to tell the two apart, and
which networks (CGNAT, symmetric NAT, most mobile carriers) simply cannot do it without a relay.

---

## Requirements

- **Node.js 20.11+** (developed on 24)
- **Chrome, Edge, or Firefox on a desktop**, if you are using the browser rather than the app.
  Screen sharing does not exist in mobile browsers; phones and tablets can watch and talk but
  cannot share.
- **Nothing else.** Certificates are generated in-process — no OpenSSL, no Git install. That
  matters because anyone can host a room from the desktop app, and "hosting requires a developer
  toolchain" is not a requirement that can travel with an installer.

---

## Commands

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run it with auto-restart |
| `npm run links` | Print the addresses to share and the certificate fingerprint |
| `npm run certs` | Regenerate certificates (automatic on first run) |
| `npm run certs:check` | Verify the certificate still covers this machine's addresses |
| `npm test` | Lint, unit, integration, certificates, browser and desktop tests — one verdict |
| `npm run test:unit` | The fast tests only |
| `npm run test:e2e` | The browser tests only |

---

## Documentation

| | |
|---|---|
| [SETUP.md](docs/SETUP.md) | First run, ports, the firewall prompt |
| [NETWORK.md](docs/NETWORK.md) | LAN vs remote, port forwarding, and the honest limits |
| [CERTIFICATES.md](docs/CERTIFICATES.md) | The browser warning, and how to stop seeing it |
| [PROTOCOL.md](docs/PROTOCOL.md) | The signaling protocol, for anyone changing the code |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom → cause → fix |

---

## How it fits together

```
  Browser A ──┐                                          ┌── Browser B
              │   wss://…/ws   signaling only            │
              └────────────►  Node server  ◄─────────────┘
                             (HTTPS + WebSocket)
       ▲                                                        ▲
       └──────────── WebRTC: audio and video, direct ───────────┘
```

- **Runtime dependencies: one** (`ws`). Everything else is Node's standard library.
- **No build step.** The frontend is plain ES modules, served as they are written.
- `public/shared/` holds the few files both sides import, so the server and the browser cannot
  drift apart on what a message means.
