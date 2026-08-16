# Setup

## First run

```bash
npm install
npm start
```

On the first start the server generates its own certificates (a few seconds) and prints:

```
Streamer ready: https://localhost:8443  https://192.168.1.34:8443
Certificate SHA-256: AE:11:D0:4A:…
Outside-network access requires router port forwarding.
```

**Windows will ask about the firewall.** Allow it on **Private networks**. Denying it, or
allowing only Public, is the most common reason another device on the same Wi-Fi cannot open
the page.

Open `https://localhost:8443` and accept the certificate warning —
[CERTIFICATES.md](CERTIFICATES.md) explains why it appears.

## Inviting people on your network

```bash
npm run links
```

Send them the `https://192.168.x.x:8443` address. Each device accepts the certificate warning
once, or installs `certs/ca.crt` to stop seeing it.

For anyone outside your network, read [NETWORK.md](NETWORK.md) first — that is a separate
problem with its own failure modes.

## Ports

| Port | Purpose | Setting |
|---|---|---|
| 8443 | HTTPS + signaling | `server.port` |
| 8080 | Redirects http:// to https:// | `server.httpRedirect.port` |

To change them, create `config.json`:

```json
{ "server": { "port": 9443, "httpRedirect": { "port": 9080 } } }
```

Or set `STREAMER_PORT` / `STREAMER_HTTP_PORT`.

## Configuration

`config.default.json` is the reference and is not meant to be edited — it documents every
option, including why several of the values are what they are. Put your changes in
`config.json` beside it; objects merge, arrays replace (so you can remove a default STUN server
rather than only add to it).

The settings most worth reviewing:

```json
{
  "media": {
    "uploadBudgetKbps": 20000,
    "defaultPreset": "1080p60",
    "autoAdapt": true
  },
  "rooms": {
    "maxParticipants": 4,
    "accessCode": null
  },
  "webrtc": {
    "iceServers": [{ "urls": ["stun:stun.l.google.com:19302"] }]
  }
}
```

- **`uploadBudgetKbps`** — set it to your real upload speed. See the README; this is the one
  number most worth correcting.
- **`maxParticipants`** — everyone connects to everyone, so cost grows quickly. 4 is the
  comfortable ceiling; the hard maximum is 8.
- **`accessCode`** — a shared code required to join, on top of the room link.
- **`iceServers`** — set to `[]` for local-network-only use, which removes the third-party STUN
  lookup entirely.

Anything invalid fails at startup with the exact key path, rather than misbehaving later:

```
ConfigError: config: rooms.maxParticipants must be an integer between 2 and 8, got 12
```

### Environment variables

For anything you would rather not write in a file:

```
STREAMER_PORT              STREAMER_HOST              STREAMER_HTTP_PORT
STREAMER_MAX_PARTICIPANTS  STREAMER_ACCESS_CODE       STREAMER_LOG_LEVEL
STREAMER_TURN_ENABLED      STREAMER_TURN_URLS         STREAMER_TURN_USERNAME
STREAMER_TURN_CREDENTIAL   STREAMER_OPENSSL
```

## Running it continuously

Nothing here needs a service manager, but if you want the server always available, run it under
whatever you normally use (Task Scheduler, NSSM, pm2). It holds no state on disk, so restarting
is free — it only ends any rooms that were live at the time.

## Verifying an install

```bash
npm test
```

Runs lint, the unit and integration tests, a certificate check, and the browser tests, and
prints one verdict. The browser tests drive two and three real Chromium instances through
actual peer connections, so a green result means media genuinely flowed — not that the code
merely parsed.

Expect it to take two to three minutes. `npm run test:unit` is the fast subset.
