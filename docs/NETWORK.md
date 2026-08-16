# Networking: what has to work, and what nobody can promise

## Two separate things have to work, and they fail for different reasons

This is the single most useful thing to understand about this app, because getting it wrong
costs days.

```
  1. HTTPS + WSS        Friend ─────────────────────────►  Your PC
     (the page and                 must reach your address on port 8443
      the signaling)               ↳ needs port forwarding, a tunnel, or a public IP
                                   ↳ has nothing to do with WebRTC

  2. WebRTC media       Friend ◄─────────────────────────►  Your browser
                                   must traverse both networks' NAT
                                   ↳ needs a direct path between the two of you
                                   ↳ has nothing to do with your server
```

**The first is a prerequisite for the second even being attempted.** If someone cannot open
`https://<your-address>:8443` in their browser, the page never loads, the WebSocket never
opens, and no peer connection is ever created.

This is the expensive failure to misdiagnose: everything works perfectly between two devices on
your own Wi-Fi, you send the link to someone in another country, nothing happens — and you
spend a week reading about STUN and ICE when the actual problem is that port 8443 was never
reachable from outside your router.

**So check them in order.** Ask the other person to open the URL first. If the page does not
load, the problem is connection 1 and no amount of WebRTC configuration will help.

The app helps you tell them apart: "Can't reach the server" and "Couldn't connect directly to
this person" are different messages with different remedies, and the room never shows the
second when the first is the real cause.

## On the same network

Nothing to configure. Run the server, run `npm run links`, and give people the
`https://192.168.x.x:8443/...` address. They will each have to accept the certificate warning
once — see [CERTIFICATES.md](CERTIFICATES.md), and install `certs/ca.crt` if you would rather
not see the warning at all.

## From outside your network

You need to make your machine reachable from the internet. That is your decision and your
setup; this app does not do it for you. The usual options:

| Approach | Notes |
|---|---|
| **Port forwarding** | Forward TCP 8443 on your router to this machine. Requires a public IP -- see the CGNAT note below. |
| **A tunnel** (Cloudflare Tunnel, Tailscale, ngrok, …) | Usually the least painful, and often works where port forwarding cannot. A tunnel that terminates TLS also removes the certificate warning. |
| **A VPN between the participants** | Everyone ends up on one virtual network, and the LAN case above applies. |

`npm run links` prints your LAN address, the port to forward, and your detected public address.
**A printed public address is not a promise that it is reachable** — that can only be confirmed
by someone outside actually opening it.

## There is no promise this works on every network

Stated plainly, because the alternative is you assuming something is broken when it is not:

- **CGNAT.** Many mobile and some home ISPs give you an address that is shared with other
  customers. There is no port to forward. Port forwarding cannot work at all; use a tunnel.
- **Symmetric NAT.** Some routers and most corporate networks assign a different external port
  per destination, which defeats the technique STUN relies on. Two peers behind symmetric NAT
  usually cannot connect directly no matter what.
- **Firewalls that block UDP.** Media prefers UDP. Some networks permit only TCP on a few
  ports.
- **Mobile carriers** commonly do several of the above at once.

In those cases a direct connection is impossible, and the only fix is a **TURN relay** — a
server that both peers can reach, which forwards the media between them. TURN is supported in
`config.json` but **off by default**, because enabling it means your audio and video pass
through that relay. That is a real change to the privacy of this app, so it is a decision you
make deliberately rather than a default you inherit.

None of this is specific to this project. It is a property of the networks between you.

## STUN is a third party, by default

To learn its own public address, each browser sends a small UDP request to a STUN server. The
default configuration uses Google's public ones:

```json
"iceServers": [{ "urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]
```

That discloses each participant's IP address and the session's timing to whoever runs those
servers. No media and no content — but it is not nothing, and the automated privacy test
**cannot** see it: it observes HTTP traffic, and STUN is UDP.

Two honest options:

- **LAN only:** set `"iceServers": []` in `config.json`. On a local network, peers find each
  other directly and STUN is not needed at all.
- **Your own STUN/TURN:** run [coturn](https://github.com/coturn/coturn) and point
  `iceServers` at it.

## Ports

| Port | Purpose | Change it in |
|---|---|---|
| 8443 | HTTPS + WebSocket signaling | `server.port` |
| 8080 | Redirects http:// to https:// | `server.httpRedirect.port` |

Only 8443 needs forwarding. Media does not go through the server, so no media port needs to be
opened for it — WebRTC negotiates its own paths.

## Windows Firewall

The first run pops a Windows Firewall prompt. Allow it on **Private networks**. Denying it, or
allowing only Public, is the most common reason another device on the same Wi-Fi cannot reach
the page.

## Quick diagnosis

| Symptom | Almost always |
|---|---|
| Page will not load at all | Connection 1: wrong address, port not forwarded, or the firewall |
| Certificate warning | Expected — see [CERTIFICATES.md](CERTIFICATES.md) |
| Page loads, "Can't reach the server" | The page came from a different origin than the socket, or the certificate was not accepted |
| Everyone joins, no video | Connection 2: a direct path could not be established; you likely need TURN |
| Works on Wi-Fi, not from outside | Connection 1, every time. Verify the public URL opens *before* looking at anything else |
