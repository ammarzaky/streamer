/**
 * Per-peer statistics, derived from RTCPeerConnection.getStats().
 *
 * getStats returns cumulative counters, so every rate here is a delta between two samples.
 * The elapsed time comes from the report timestamps rather than the polling interval: a
 * busy main thread delays the timer, and dividing by the nominal interval then reports a
 * bitrate that is wrong in exactly the situation the user is trying to diagnose.
 */

import { ema } from '../core/util.js';
import { logger } from '../core/logger.js';

/** Rates are noisy enough sample-to-sample that an unsmoothed readout cannot be read. */
const SMOOTHING = 0.3;

export function createStatsCollector({ mesh, config, onSample }) {
  const intervalMs = config?.media?.statsPollIntervalMs ?? 1000;

  /** peerId -> previous raw sample, for delta computation */
  const previous = new Map();
  /** peerId -> smoothed values */
  const smoothed = new Map();

  let timer = null;

  function start() {
    if (timer) return;
    timer = setInterval(() => void tick(), intervalMs);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    previous.clear();
    smoothed.clear();
  }

  function forget(peerId) {
    previous.delete(peerId);
    smoothed.delete(peerId);
  }

  async function tick() {
    const results = [];
    for (const peer of mesh.list()) {
      try {
        const report = await peer.getStats();
        const sample = derive(peer.peerId, report);
        if (sample) results.push(sample);
      } catch (err) {
        logger.debug('stats: getStats failed', { peerId: peer.peerId, error: err?.message });
      }
    }
    if (results.length) onSample?.(results);
  }

  /**
   * Reduce one getStats report to the handful of numbers the UI and the quality controller
   * actually use.
   */
  function derive(peerId, report) {
    let outboundVideo = null;
    let inboundVideo = null;
    let inboundAudio = null;
    let outboundAudio = null;
    let candidatePair = null;
    let transport = null;
    let remoteInbound = null;

    const candidates = new Map();

    for (const stat of report.values()) {
      switch (stat.type) {
        case 'outbound-rtp':
          if (stat.kind === 'video') outboundVideo = stat;
          else if (stat.kind === 'audio' && !outboundAudio) outboundAudio = stat;
          break;
        case 'inbound-rtp':
          if (stat.kind === 'video') inboundVideo = stat;
          else if (stat.kind === 'audio' && !inboundAudio) inboundAudio = stat;
          break;
        case 'remote-inbound-rtp':
          if (stat.kind === 'video') remoteInbound = stat;
          break;
        case 'transport':
          transport = stat;
          break;
        case 'candidate-pair':
          // Prefer the nominated, succeeded pair. Firefox does not always expose
          // transport.selectedCandidatePairId, so this fallback is not optional.
          if (stat.nominated && stat.state === 'succeeded') candidatePair = stat;
          break;
        case 'local-candidate':
        case 'remote-candidate':
          candidates.set(stat.id, stat);
          break;
        default:
          break;
      }
    }

    if (transport?.selectedCandidatePairId) {
      const selected = report.get(transport.selectedCandidatePairId);
      if (selected) candidatePair = selected;
    }

    const now = performance.now();
    const prev = previous.get(peerId);

    const current = {
      t: now,
      bytesSent: outboundVideo?.bytesSent ?? 0,
      bytesReceived: inboundVideo?.bytesReceived ?? 0,
      audioBytesSent: outboundAudio?.bytesSent ?? 0,
      audioBytesReceived: inboundAudio?.bytesReceived ?? 0,
      framesEncoded: outboundVideo?.framesEncoded ?? 0,
      framesDecoded: inboundVideo?.framesDecoded ?? 0,
      framesDropped: inboundVideo?.framesDropped ?? 0,
      packetsLost: inboundVideo?.packetsLost ?? 0,
      packetsReceived: inboundVideo?.packetsReceived ?? 0,
    };
    previous.set(peerId, current);

    if (!prev) return null; // a rate needs two samples

    // Seconds actually elapsed, from the clock rather than the nominal interval.
    const dt = (current.t - prev.t) / 1000;
    if (dt <= 0) return null;

    const rate = (a, b) => Math.max(0, (a - b) * 8) / dt;
    const perSec = (a, b) => Math.max(0, a - b) / dt;

    const previousSmoothed = smoothed.get(peerId) ?? {};
    const next = {
      sendBps: ema(previousSmoothed.sendBps, rate(current.bytesSent, prev.bytesSent), SMOOTHING),
      recvBps: ema(
        previousSmoothed.recvBps,
        rate(current.bytesReceived, prev.bytesReceived),
        SMOOTHING,
      ),
      sendFps: ema(
        previousSmoothed.sendFps,
        perSec(current.framesEncoded, prev.framesEncoded),
        SMOOTHING,
      ),
      recvFps: ema(
        previousSmoothed.recvFps,
        perSec(current.framesDecoded, prev.framesDecoded),
        SMOOTHING,
      ),
    };
    smoothed.set(peerId, next);

    // Loss as a fraction of what should have arrived in this interval, not cumulatively --
    // a cumulative figure only ever drifts towards a number nobody can act on.
    const deltaLost = Math.max(0, current.packetsLost - prev.packetsLost);
    const deltaReceived = Math.max(0, current.packetsReceived - prev.packetsReceived);
    const lossRatio = deltaLost + deltaReceived > 0 ? deltaLost / (deltaLost + deltaReceived) : 0;

    return {
      peerId,

      sendBps: next.sendBps,
      recvBps: next.recvBps,
      sendFps: next.sendFps,
      recvFps: next.recvFps,
      framesDropped: current.framesDropped,
      lossRatio,

      // Outbound: what we are actually encoding, which is the honest answer to "am I really
      // sending 1080p60?"
      sendWidth: outboundVideo?.frameWidth ?? null,
      sendHeight: outboundVideo?.frameHeight ?? null,
      recvWidth: inboundVideo?.frameWidth ?? null,
      recvHeight: inboundVideo?.frameHeight ?? null,

      // The single most useful field in the whole report.
      qualityLimitationReason: outboundVideo?.qualityLimitationReason ?? 'none',
      actualBitrateBps: next.sendBps,
      availableOutgoingBitrate: candidatePair?.availableOutgoingBitrate ?? null,
      roundTripMs:
        (candidatePair?.currentRoundTripTime ?? remoteInbound?.roundTripTime ?? null) !== null
          ? Math.round(
              (candidatePair?.currentRoundTripTime ?? remoteInbound?.roundTripTime) * 1000,
            )
          : null,

      connectionType: describeConnection(candidatePair, candidates, report),

      // Sending video at all? Chrome may drop the outbound-rtp report entirely after
      // replaceTrack(null) rather than freezing it, so absence means stopped.
      hasOutboundVideo: Boolean(outboundVideo),
    };
  }

  /**
   * Turn the selected candidate pair into something a person can act on.
   *
   * `host` means the two machines reached each other directly on the same network.
   * `srflx`/`prflx` means a direct connection through NAT, discovered via STUN.
   * `relay` means media is going through a TURN server -- worth surfacing prominently,
   * because this app is built on the promise that it usually is not.
   */
  function describeConnection(pair, candidates, report) {
    if (!pair) return { kind: 'unknown', local: null, remote: null };

    const local = candidates.get(pair.localCandidateId) ?? report.get(pair.localCandidateId);
    const remote = candidates.get(pair.remoteCandidateId) ?? report.get(pair.remoteCandidateId);

    const localType = local?.candidateType ?? null;
    const remoteType = remote?.candidateType ?? null;

    let kind = 'unknown';
    if (localType === 'relay' || remoteType === 'relay') kind = 'relay';
    else if (localType === 'host' && remoteType === 'host') kind = 'local';
    else if (localType) kind = 'direct';

    return { kind, local: localType, remote: remoteType };
  }

  return { start, stop, forget, tick };
}
