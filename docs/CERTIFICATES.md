# Certificates

## Why there is a warning at all

Browsers will not give a page a microphone or a screen unless it was loaded over HTTPS. There
is no exception for local addresses beyond `localhost` itself, so serving this app over plain
`http://` does not merely restrict screen sharing — the API is not there at all, and the app
tells you so rather than failing halfway through.

HTTPS needs a certificate, and certificates are issued for public domain names. Your machine on
your home network does not have one. So on first run the server creates its own small
certificate authority and issues itself a certificate from it.

Nothing verifies that authority, so browsers warn. **The warning is expected and correct.** It
means "nobody has vouched for this", not "something is wrong".

## What gets created

On first run, in `certs/` (git-ignored, never leaves your machine):

| File | What it is |
|---|---|
| `ca.crt` | Your local authority. **This is the file to install on other devices.** |
| `ca.key` | Its private key. Never share this. |
| `server.crt` | The certificate the server presents |
| `server.key` | Its private key |

The server certificate covers `localhost`, `streamer.local`, `127.0.0.1`, `::1`, and **every
LAN IPv4 address this machine had when it was generated**.

That last point matters: change networks, and your address changes. `npm run certs:check` fails
when the certificate no longer covers your current address, and `npm start` regenerates
automatically. It is also part of `npm test`, so "why can't my phone connect any more" shows up
as a failing check rather than a mystery.

## Two ways to deal with the warning

### Click through it (fine for a one-off)

Each person does this once per device, per address.

| Browser | What to do |
|---|---|
| **Chrome / Edge** | "Advanced" → "Proceed to … (unsafe)". If there is no link, click the page and type `thisisunsafe`. |
| **Firefox** | "Advanced…" → "Accept the Risk and Continue" |
| **Safari** | "Show Details" → "visit this website" → confirm |
| **iOS Safari** | "Show Details" → "visit this website". Install the CA instead if you use it often. |
| **Android Chrome** | "Advanced" → "Proceed to …" |

**Verify the fingerprint before accepting**, especially away from home. Run `npm run links` to
print the server's SHA-256 fingerprint, and compare it with what the browser shows. This is the
step that makes clicking through safe rather than a habit.

### Install the authority (better if you will use it repeatedly)

Copy `certs/ca.crt` to the device and install it. Afterwards every certificate this server
issues is trusted with no warning, including after your IP changes and a new one is generated.

| Platform | How |
|---|---|
| **Windows** | Double-click `ca.crt` → Install Certificate → **Local Machine** → Place all in **Trusted Root Certification Authorities** |
| **macOS** | Double-click → Keychain Access → find "Streamer Local CA" → Get Info → Trust → "Always Trust" |
| **iOS** | AirDrop or email it → Settings → Profile Downloaded → Install → then **Settings → General → About → Certificate Trust Settings** and enable it. That second step is separate and easy to miss. |
| **Android** | Settings → Security → Encryption & credentials → Install a certificate → **CA certificate** |
| **Firefox** | Uses its own store: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import → tick "identify websites" |

**What you are agreeing to:** that device will trust anything signed by *your* CA. The key
never leaves your machine, but treat `ca.key` as you would any private key, and remove the CA
from a device you no longer control.

## Regenerating

```bash
npm run certs           # only if needed
npm run certs -- --force  # start over, including a new CA
npm run certs:check     # verify; exits non-zero if regeneration is needed
```

`--force` creates a **new authority**, so any device that installed the old one has to install
the new one. Without `--force` only the server certificate is reissued and installed CAs keep
working — which is why the CA is separate in the first place.

## Making the warning go away entirely

A certificate from a real authority requires a real domain name. If you already have one, put
this behind a reverse proxy holding a Let's Encrypt certificate, or in front of a tunnel that
terminates TLS for you (Cloudflare Tunnel, Tailscale Funnel). Then there is no warning for
anyone, and nothing to install.

## If something breaks

**None of this applies if everyone uses the desktop app.** It pins the certificate's fingerprint
straight from the invite link, so there is no CA to install and no warning to accept — see
[DESKTOP.md](DESKTOP.md). The rest of this page is for browser participants.

**Certificates are generated in-process.** There is no OpenSSL dependency any more; earlier
versions shelled out to it and therefore quietly required Git for Windows to be installed, which
is not something a packaged app can assume on someone else's machine.

If you have an installation from before that change, its EC certificates keep working untouched.
The one visible consequence appears if the certificate later needs reissuing — usually because
the machine's LAN IP changed: the old CA cannot sign the new leaf, so a fresh CA is created and
browser participants install `ca.crt` once more. App participants are unaffected.

**A device still warns after installing the CA** — Firefox uses its own certificate store, and
iOS needs the separate trust toggle described above. Also confirm the address you are visiting
appears in the certificate: `npm run certs:check` prints the list.

**"Can't reach the server" with no warning shown** — the page and the WebSocket must be the
same origin. If the page loads over one address and the socket is attempted on another, the
handshake fails silently with no interstitial at all. Always use the address `npm run links`
prints.
