# Signaling protocol — `streamer.v1`

The server relays signaling only. No audio or video ever passes through it.

This document and [`public/shared/protocol.js`](../public/shared/protocol.js) are the contract
between the Node server (`src/`) and the browser client (`public/js/`). They share no other
file. **Neither side may write a message type or error code as a string literal** — both import
the constants — because a hardcoded `'ice-candidate'` that drifts from the constant is the
exact failure this split is designed to prevent.

---

## Transport

| | |
|---|---|
| Endpoint | `wss://<same-origin-as-the-page>/ws` |
| Subprotocol | `streamer.v1` — requested by the client, echoed by the server |
| Frames | Text only. A binary frame closes the connection. |
| Max frame | 64 KB (32 KB for SDP, 4 KB for a candidate) |

**Same origin is load-bearing.** The client builds the URL from `location`, never from a
hardcoded address. A certificate accepted for `https://host:8443` does not cover
`wss://host:9000`, and a rejected WebSocket handshake produces no interstitial and no
diagnosable error — the browser just fires `close`. One origin means accepting the page's
certificate also covers the socket.

A client requesting a different subprotocol is rejected during the HTTP upgrade with 403,
before any room state exists.

## Envelope

Every frame, both directions:

```jsonc
{
  "v": 1,              // protocol version; a mismatch is fatal
  "type": "join",      // from C2S or S2C
  "id": "c7",          // optional client correlation id, <=32 chars
  "ref": "c7",         // server only: echo of the request's id
  "ts": 1699999999999, // server only: Date.now() at send
  "data": {}           // object; missing is treated as {}, array/primitive is an error
}
```

Relays are **not acknowledged**. Silence means success; only failures generate traffic.

## Connection state machine

```
  open ──▶ UNJOINED ──create-room|join──▶ JOINED ──leave|end|close──▶ CLOSED
             │                              │
             └────── welcome sent ──────────┘
```

One socket carries **one peer in one room for its entire life**. `leave` closes the socket
rather than returning to UNJOINED; that costs a reconnect (free) and removes every bug where a
socket half-belongs to two rooms.

A message sent in an illegal state gets `WRONG_STATE` rather than being dropped, so a confused
client fails immediately instead of waiting forever for a reply that was never coming.
`LEGAL_IN_STATE` in `protocol.js` is the authority.

---

## Client → server

### `create-room`
```jsonc
{ "name": "Ahmed" }
```
The landing page **never opens a socket.** "Create room" is a client-side navigation to
`/r/new`; `room.html` opens the socket and sends this. The obvious alternative — create on the
landing page, then navigate — destroys the WebSocket mid-navigation and orphans a room whose
host never arrives.

→ `room-created`, then the sender is in the room as host.

### `join`
```jsonc
{ "roomId": "kJ8x...", "name": "Sara", "hostToken": "…", "accessCode": "…" }
```
`hostToken` and `accessCode` are optional. A valid `hostToken` within the grace window reclaims
the host role; an absent, stale, or wrong one simply joins as a normal participant — degraded,
never broken.

→ `joined` to the sender, `peer-joined` to everyone else.
→ Errors: `ROOM_NOT_FOUND`, `ROOM_FULL`, `NAME_INVALID`, `ACCESS_CODE_REQUIRED`, `ACCESS_CODE_INVALID`

> Before rejecting with `ROOM_FULL`, the server evicts peers whose socket is no longer OPEN.
> Dead-socket detection is a 15–35 s heartbeat window, so without that sweep a peer reloading
> after a Wi-Fi blip is refused entry to its *own* full room.

### `leave` · `end`
```jsonc
{}
```
`end` is host-only (`NOT_HOST` otherwise) and terminates the room for everyone.
A host sending `leave` promotes the next host **immediately** — the grace window exists for
unexpected socket loss, not for a deliberate exit.

### `mute-state`
```jsonc
{ "micMuted": true }
```
**Microphone only.** Not screen sharing, and not the system audio of whatever is being shared.

Muting is `track.enabled = false`, which keeps RTP flowing, so the remote's
`MediaStreamTrack.muted` never changes and no event fires — the far side is *structurally
incapable* of detecting a mute without being told. This message is therefore the sole
mechanism, not a convenience.

There are two independent audio sources and conflating them is a real bug, not a naming
preference: muting your microphone must never silence the film you are sharing.

| Source | From | Controlled by | Reported by |
|---|---|---|---|
| Microphone | `getUserMedia` | the Mute button | `mute-state.micMuted` |
| System / display audio | `getDisplayMedia({audio:true})` | starting/stopping the share | `share-state` |

→ `peer-mute-state` to everyone else.

### `claim-share` · `release-share`
```jsonc
{ "force": false }    // claim-share
{ "epoch": 7 }        // release-share
```
See [Share ownership](#share-ownership) below.

### `offer` · `answer` · `ice-candidate`
```jsonc
{ "to": "p-3", "description": { "type": "offer", "sdp": "v=0\r\n…" } }
{ "to": "p-3", "candidate": { "candidate": "candidate:…", "sdpMid": "0", "sdpMLineIndex": 0 } }
{ "to": "p-3", "candidate": null }   // end-of-candidates
```
Relayed to `to` **and only to `to`** — a regression here is a privacy bug, and it has a
dedicated three-client test.

`candidate: null` is the pinned encoding for end-of-candidates. The server relays either form
verbatim; the client passes `init ?? undefined` to `addIceCandidate`. This matters because a
validator demanding an object would reject the final candidate of *every* peer connection,
turning a normal part of ICE into an error on every single connect.

→ Errors: `PEER_NOT_FOUND` (fires on any relay to a peer that just left — an ordinary race,
so the client treats it as informational, not as a failure to show)

### `ping`
```jsonc
{}
```
→ `pong`. Legal in both states.

---

## Server → client

### `welcome`
Sent immediately on open, before anything is asked for. The shape is `toClientConfig()` in
`src/config.js`:
```jsonc
{
  "iceServers": [{ "urls": ["stun:…"] }],
  "iceTransportPolicy": "all",
  "bundlePolicy": "max-bundle",
  "maxParticipants": 4,
  "oneSharerAtATime": true,
  "defaultPreset": "1080p30",
  "uploadBudgetKbps": 10000,
  "autoAdapt": true,
  "stepDownSamplesCpu": 8,
  "stepDownSamplesBandwidth": 6,
  "adaptCooldownMs": 10000,
  "adaptWarmupMs": 15000,
  "includeDisplayAudio": true,
  "statsPollIntervalMs": 1000,
  "audio": { "echoCancellation": true, "noiseSuppression": true, "autoGainControl": true, "channelCount": 1 },
  "limits": { "maxNameChars": 32 }
}
```
`audio` is the capture-processing contract: the room passes it through `micConstraints()`
(`public/js/media/mic-constraints.js`) for every microphone acquisition, so changing
`config.media.audio` on the server changes every client's capture. Unknown keys (such as the
config file's `_comment`) are ignored; the lobby check runs before the socket opens and uses
the client-side defaults, which a unit test keeps equal to `config.default.json`.

### `room-created`
```jsonc
{ "roomId": "kJ8x…", "selfId": "p-1", "joinOrder": 1, "hostToken": "…" }
```

### `joined`
```jsonc
{
  "roomId": "kJ8x…",
  "selfId": "p-4",
  "joinOrder": 4,
  "isHost": false,
  "hostPeerId": "p-1",
  "maxParticipants": 4,
  "share": { "sharerId": "p-2", "sharerName": "Sara", "epoch": 7 },
  "participants": [
    { "id": "p-1", "name": "Ahmed", "joinOrder": 1, "micMuted": false,
      "youInitiate": false, "polite": true }
  ]
}
```

**The `share` and `micMuted` snapshots are mandatory, not decoration.** `share-state` and
`peer-mute-state` are change notifications, so a peer joining mid-session receives neither. Without
the snapshot it renders "No one is sharing yet" while video arrives over the mesh, and anyone
who muted before it joined shows as unmuted forever. Clients initialise their
`lastAppliedEpoch` from `share.epoch`.

### `peer-joined`
```jsonc
{ "peer": { "id": "p-5", "name": "Omar", "joinOrder": 5, "micMuted": false,
            "youInitiate": true, "polite": false } }
```

### `peer-left`
```jsonc
{ "id": "p-3", "reason": "left" }   // left | disconnected | timeout | room-ended
```
The reason changes the wording: someone who left deliberately is not the same event as someone
whose connection died.

### `peer-mute-state`
```jsonc
{ "peerId": "p-3", "micMuted": true }
```
Note the polarity: `micMuted`, not `micOn`. Both trees use the same sense end to end — an
inverted flag on one side is how a mute indicator ships backwards.

### `host-changed` — broadcast, **never carries a token**
```jsonc
{ "hostPeerId": "p-2", "reason": "promoted" }   // promoted | reclaimed
```

### `host-token` — directed to the new host **only**
```jsonc
{ "hostToken": "…" }
```
Two messages rather than one conditional payload, because a token inside a broadcast hands
every participant in the room the ability to reclaim host. An integration test asserts the
`host-changed` frames received by non-promoted peers contain no `hostToken` key.

### `share-state` — broadcast on every ownership change
```jsonc
{ "sharerId": "p-2", "sharerName": "Sara", "epoch": 8 }
{ "sharerId": null, "epoch": 9 }
```

### `share-revoked` — directed to the outgoing sharer only
```jsonc
{ "byPeerId": "p-3", "byName": "Omar", "reason": "takeover", "epoch": 8 }
```

### `room-ended`
```jsonc
{ "reason": "host-ended" }   // host-ended | empty | idle | server-shutdown
```

### `error`
```jsonc
{ "code": "ROOM_FULL", "message": "…", "data": { } }
```
Every code in `SERVER_ERROR_CODES` has a user-facing string in `public/js/ui/strings.js`, and a
unit test asserts the two sets are equal in both directions. A code with no string renders as a
blank toast, which in an app that promises no silent failures is itself a silent failure.

---

## Deterministic negotiation

Each peer receives a monotonic per-room `joinOrder` that is never reused.

> **The peer with the lower `joinOrder` creates the offer** — whoever was already in the room
> offers to the newcomer.

The server ships the decision as data (`youInitiate`, `polite`) rather than letting each client
compute it. Independent derivation is where asymmetry bugs come from: a string-versus-numeric
comparison on one side and not the other yields either two offers or none, and both look like a
network problem.

`polite = !youInitiate` drives Perfect Negotiation for mid-session renegotiation, which this app
genuinely needs because any peer may start sharing at any moment. Exactly one side of each pair
is polite, permanently.

### Transceivers are pre-allocated

The impolite peer calls `addTransceiver` **once**, in the fixed order **mic, shareAudio, video**,
with `sendEncodings: [{}]` on the video one. The polite peer adopts them by index from
`setRemoteDescription` and must set `direction = 'sendrecv'` **before** `createAnswer`.

Both halves matter. Pre-allocation is what makes "starting and stopping a share never
renegotiates" true — with `addTrack` instead, every share, every stop, and every late-arriving
mic fires `negotiationneeded`. And transceivers created implicitly by `setRemoteDescription`
start `recvonly`; `replaceTrack` does **not** promote them, so a polite peer that skips the
direction assignment sends nothing at all, with no error anywhere to say why.

### Diagnostics data channels

The initiator also creates two `RTCDataChannel`s — `diag` (unordered, no retransmits: a
once-a-second report of what this peer hears from the other and the state of its `<audio>`
element) and `diag-dump` (ordered, reliable, chunked, ≤ 64 KB: a peer's whole diagnostics
dump on request). They are created **in the same task as, and before, `createTransceivers()`**
so both land in the one initial offer; a channel created later would cost a second
negotiation for telemetry. The answerer adopts them from `ondatachannel`; they occupy no
transceiver, so index-based adoption of the three m-lines is untouched.

They carry **diagnostics only, never signaling**. Nothing in this document changes: the
message inventory in `protocol.js` is the same, and the server neither sees nor relays
anything on these channels. Everything received on them is parsed as untrusted input.

### Reconnect

A reconnecting peer gets a **new `peerId` and a new, higher `joinOrder`**. Everyone else sees
`peer-left` then `peer-joined` and rebuilds that one connection. There is no session resume in
v1: for four people that rebuild takes under a second and removes all state reconciliation.

The reconnecting client must:

1. **Discard its entire outbound queue.** Its peerId is dead, so every queued `to:` is stale and
   every replayed `offer` produces `PEER_NOT_FOUND`.
2. **Tear down its whole mesh and rebuild from the new `joined` snapshot** — not just one
   connection. Its old `RTCPeerConnection`s still look `connected` from its side while every
   remote builds fresh ones against the new peerId, which doubles the encoders.
3. **Re-claim the share if it was sharing**, and run `stopShare('lost')` if refused. Without
   this, a ten-second Wi-Fi blip lets another peer be granted the share while the original
   sharer's tracks are re-attached to the new connections — and two peers transmit screen video
   at once, in violation of one-sharer-at-a-time.

---

## Share ownership

One sharer at a time, enforced as an explicit ownership protocol rather than inferred from
track state. `room.shareEpoch` is a counter incremented on every grant.

### Claiming

`resolveClaim()` in `protocol.js` is the single decision function, written pure so every branch
is testable without a socket:

| Situation | Outcome |
|---|---|
| Claimant already owns it | **no-op** — no epoch bump, no broadcast |
| A claim is already pending | `SHARE_IN_PROGRESS` |
| Slot free (`force` or not) | grant, bump epoch, broadcast `share-state` |
| Owned, `force: false` | `SHARE_IN_PROGRESS` |
| Owned, `force: true` | send `share-revoked` to the owner, arm the timer |

The no-op case is not a nicety. A double-clicked Share button that bumped the epoch would
invalidate the client's cached epoch; its later `release-share` would then fail the epoch guard,
and **the share slot would stay wedged for the life of the room**.

### The capture happens before the claim

The client calls `getDisplayMedia()` **synchronously inside the click handler, before sending
`claim-share`** — never after the server replies.

`getDisplayMedia` requires transient user activation. A WebSocket callback arriving up to
`shareRevokeTimeoutMs` plus a round trip later is outside Chrome's and Firefox's activation
window, and outside Safari's model entirely. Waiting for the server would mean raising
`shareRevokeTimeoutMs` in a config file silently disables screen sharing on the takeover path —
and Tier-1 E2E stubs `getDisplayMedia` out, so no test would catch it.

If the resulting `share-state` does not name this peer, the client stops the tracks it captured
and shows `SHARE_IN_PROGRESS`. The cost is one wasted picker in a rare race.

### Takeover, in order

1. B captures, then sends `claim-share { force: true }`.
2. Server sets `pendingClaim`, sends **`share-revoked`** to A, arms `shareRevokeTimeoutMs`.
3. A runs `stopShare('revoked')` — `replaceTrack(null)` on every peer, stops the display tracks
   — and sends `release-share`.
4. A's release **resolves the pending claim atomically**: owner becomes B, epoch bumps, and
   exactly **one** `share-state` is broadcast.
5. If A never answers, the timer fires — but only grants B if `room.currentSharer` is *still* A.

Step 4 must not route through the generic release path, which would broadcast
`share-state { sharerId: null }` first and make every stage flicker to the empty state for a
round trip.

Step 5's re-check is the mirror of the epoch guard. Without it: A is revoked for B; A stops
sharing on its own at 0.1 s; C claims the freed slot at 0.2 s and starts transmitting; the timer
fires at 3 s and grants B anyway — silently evicting C, who keeps transmitting while its UI
insists it is live. That is precisely the bug the epoch counter fixes on the release side, moved
one message over.

### Releasing

`release-share` is honoured only when **both** hold:

```js
senderId === room.currentSharer && epoch === room.shareEpoch
```

The sender check covers the common case; the epoch also covers a peer releasing a grant it has
since re-acquired. Clients likewise ignore any `share-state` whose epoch is not greater than the
last one they applied, which makes out-of-order delivery harmless.

`stopShare()` is reachable from five paths — the native browser stop button, the app's Stop
button, `share-revoked`, `room-ended`, and teardown — and must be idempotent. Every path except
`room-ended` and teardown sends `release-share`; on `room-ended` the room is already gone and the
send would only produce an error toast layered over the ended screen.

---

## Close codes

| Code | Meaning | Client reconnects? |
|---|---|---|
| 1000 | normal | no |
| 4000 | `leave` | no |
| 4001 | `room-ended` | no |
| 4002 | rate-limit disconnect | no |
| 4003 | protocol error | no |
| 4004 | server shutdown | yes |
| 4005 | idle timeout | yes |
| 4006 | version mismatch | no |
| 4007 | slow consumer | yes |
| 1006 | abnormal (the ordinary Wi-Fi drop) | yes |

`shouldReconnect(code)` is the authority. This table is load-bearing: `room-ended` closes every
socket, so a reconnector with no rule for distinguishing intentional closes re-opens, re-joins a
deleted room, receives `ROOM_NOT_FOUND`, and replaces the correct "The host ended the session"
screen with a wrong "This room doesn't exist."

---

## Room chat extension

The welcome payload advertises `chatEnabled: true`. Clients connected to an older host disable
chat. The `chat` message is additive to protocol v1; old clients do not render incoming chat.

Client to server: `chat` is legal only after joining, with `{ "text": "hello" }` and an optional
envelope correlation `id`. Text must be nonblank and at most 2,000 UTF-16 code units. Extra
payload keys (including sender names and destinations) are rejected.

Server to client: `chat` carries `{ id, peerId, name, text, sentAt }`. The server assigns a unique
message ID, timestamp, and the authenticated member's name/ID, trims the text, and relays it
only inside that member's room. The sender receives the same message with `ref` matching the
request ID: this confirms server acceptance, not that every participant has read it.

Chat has a separate six-message burst allowance, refilling at two messages per second. Excess
messages receive `RATE_LIMITED` without spending signaling/control tokens or dropping the call.
No transcript is retained by the server or replayed to late joiners. Clients retain at most
100 messages in page memory and clear them on reload or room exit. Chat uses WSS through the
room server, rather than the peer-to-peer media channel; it is not included in diagnostics.

## File data channel

`room-files-v1` is a separate reliable, ordered WebRTC data channel created with the initial
offer, alongside diagnostics. It is not a signaling message. Both sides send a JSON
`{v:1,kind:"hello"}` before file controls are accepted, allowing older clients to remain in a call
without being offered unsupported file transfers.

Controls are JSON strings up to 2,048 characters: `offer` carries a UUID `id`, sanitized `name`,
and integer `size` (0..104857600). `accept`, `cancel`, `end`, and `complete` carry the same `id`.
There is one active outgoing and one active incoming transfer per peer. The receiver reserves
memory and sends `accept` only after its user chooses Receive. Each binary chunk contains the
36 ASCII bytes of the UUID, a 4-byte big-endian offset, then up to 12,288 payload bytes. Invalid
offsets or an overrun cancel the transfer. Only an `end` after exactly `size` bytes creates a
download, followed by `complete` confirming receipt to the sender. No automatic opening occurs.

The upload pacer is shared across recipients; each data-channel buffer is bounded to about
76 KB. Receive reservations plus completed downloads are capped at 200 MiB per page, and removing
their chat cards releases memory and object URLs. A channel close, cancellation, or 180 seconds
without progress ends incomplete transfers; reconnection does not resume them. Files never enter
the signaling protocol, transcript persistence, or diagnostics dumps.

## Other protocol limits

Stated plainly so nobody looks for it:

- **No message ordering guarantee across different senders.** Candidates from B and C may
  interleave arbitrarily; clients queue remote candidates until `remoteDescription` is set,
  flush in order, cap the queue at 256, and clear it on rollback and on connection rebuild.
- **No delivery acknowledgement for relays.**
- **No session resume.** A reconnect is a new peer.
- **No membership revocation.** There is no kick and no ban; the room id is the credential, so a
  leaked link is good for the life of the room. Rotate by ending the session and creating a new
  one.
