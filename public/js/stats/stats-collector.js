/**
 * Per-peer statistics, derived from RTCPeerConnection.getStats().
 *
 * getStats returns cumulative counters, so every rate here is a delta between two samples.
 * The elapsed time comes from the report timestamps rather than the polling interval: a
 * busy main thread delays the timer, and dividing by the nominal interval then reports a
 * bitrate that is wrong in exactly the situation the user is trying to diagnose.
 *
 * Audio is measured as SOUND, not bytes. A muted microphone and a microphone that delivers
 * digital silence both produce a steady ~14 kbps of Opus, so `bytesSent` cannot answer "is my
 * voice leaving this machine". `media-source.totalAudioEnergy` (what the encoder was given)
 * and `inbound-rtp.totalAudioEnergy` (what the decoder produced) can, and `deriveAudio` turns
 * them into per-interval RMS levels on both ends of every audio stream.
 */

import { ema } from '../core/util.js';
import { logger } from '../core/logger.js';

/** Rates are noisy enough sample-to-sample that an unsmoothed readout cannot be read. */
const SMOOTHING = 0.3;

/** Above this per-interval RMS, an audio stream carries speech rather than room tone. Same
 *  scale as the level meter (0..1 RMS); room tone with noise suppression sits at ~0.002. */
export const MIC_SPEECH_RMS = 0.01;

const finite = (value) => (Number.isFinite(value) ? value : null);

/** Interval RMS from two cumulative energy/duration readings. Null when it cannot be known. */
function intervalRms(energy, duration, prevEnergy, prevDuration) {
  if (energy === null || duration === null || prevEnergy === null || prevDuration === null) return null;
  const dE = Math.max(0, energy - prevEnergy);
  const dD = duration - prevDuration;
  if (!(dD > 0)) return null;
  return Math.min(1, Math.sqrt(dE / dD));
}

/**
 * Everything audio in one getStats report, as levels and rates.
 *
 * Pure: takes the report's values and the previous cumulative snapshot, returns the derived
 * numbers plus a new snapshot for next time. `undefined` browser fields become `null` --
 * "unknown", never "silent" -- because a Safari guest reports no audioLevel at all and must
 * not be told its microphone is dead.
 *
 * @param {Iterable<object>} values     report.values()
 * @param {{micTrackId?: string|null, roleByMid?: Record<string,string>, prev?: object|null, dtSec?: number|null}} opts
 */
export function deriveAudio(values, { micTrackId = null, roleByMid = {}, prev = null, dtSec = null } = {}) {
  const mediaSources = new Map();
  const outboundAudio = [];
  const inboundAudio = [];
  const remoteInboundAudio = [];

  for (const stat of values) {
    switch (stat.type) {
      case 'media-source':
        if (stat.kind === 'audio') mediaSources.set(stat.id, stat);
        break;
      case 'outbound-rtp':
        if (stat.kind === 'audio') outboundAudio.push(stat);
        break;
      case 'inbound-rtp':
        if (stat.kind === 'audio') inboundAudio.push(stat);
        break;
      case 'remote-inbound-rtp':
        if (stat.kind === 'audio') remoteInboundAudio.push(stat);
        break;
      default:
        break;
    }
  }

  // Which outbound audio report is the microphone. The m-line's role is authoritative when the
  // report carries a mid; the media-source's track id is the second witness; and the sole
  // report is taken as the mic only when a mic track is actually attached -- with no mic track,
  // a lone report is the shared system audio, and calling that "the microphone" would report a
  // film's bitrate as speech.
  const roleOf = (stat) => (stat.mid !== null && stat.mid !== undefined ? roleByMid[stat.mid] : undefined);
  const micOutbound =
    outboundAudio.find((stat) => roleOf(stat) === 'mic') ??
    outboundAudio.find((stat) => {
      const source = stat.mediaSourceId ? mediaSources.get(stat.mediaSourceId) : null;
      return micTrackId && source?.trackIdentifier === micTrackId;
    }) ??
    (micTrackId && outboundAudio.length === 1 && (roleOf(outboundAudio[0]) ?? 'mic') === 'mic'
      ? outboundAudio[0]
      : null);
  const micSource = micOutbound?.mediaSourceId ? (mediaSources.get(micOutbound.mediaSourceId) ?? null) : null;

  const cumulative = {
    micEnergy: finite(micSource?.totalAudioEnergy),
    micDuration: finite(micSource?.totalSamplesDuration),
    micPackets: finite(micOutbound?.packetsSent),
    micBytes: micOutbound?.bytesSent ?? 0,
    in: {},
  };

  const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : null;
  const perSec = (now, before) => (dt !== null && now !== null && before !== null ? Math.max(0, now - before) / dt : null);

  const micLevel = finite(micSource?.audioLevel);
  const micRms = prev ? intervalRms(cumulative.micEnergy, cumulative.micDuration, prev.micEnergy, prev.micDuration) : null;
  const mic = {
    hasSender: Boolean(micOutbound),
    level: micLevel,
    rms: micRms,
    energyPerSec: prev ? perSec(cumulative.micEnergy, prev.micEnergy) : null,
    packetsPerSec: prev ? perSec(cumulative.micPackets, prev.micPackets) : null,
    // Interval RMS is the honest measure; the instantaneous level is the fallback when a
    // browser reports one but not the other. Null means "cannot tell", not "silent".
    speech: micRms !== null ? micRms > MIC_SPEECH_RMS : micLevel !== null ? micLevel > MIC_SPEECH_RMS : null,
  };

  const audioIn = {};
  let inboundAudioBytes = 0;
  for (const stat of inboundAudio) {
    inboundAudioBytes += stat.bytesReceived ?? 0;
    const mid = stat.mid ?? null;
    const mapped = mid !== null ? roleByMid[mid] : undefined;
    const role = mapped ?? (inboundAudio.length === 1 ? 'mic' : `mid:${mid ?? '?'}`);
    const snapshot = {
      energy: finite(stat.totalAudioEnergy),
      duration: finite(stat.totalSamplesDuration),
      packets: finite(stat.packetsReceived),
      concealed: finite(stat.concealedSamples),
      bytes: stat.bytesReceived ?? 0,
    };
    cumulative.in[role] = snapshot;
    const before = prev?.in?.[role] ?? null;
    const rms = before ? intervalRms(snapshot.energy, snapshot.duration, before.energy, before.duration) : null;
    const level = finite(stat.audioLevel);
    audioIn[role] = {
      mid,
      bps: before && dt !== null ? (Math.max(0, snapshot.bytes - before.bytes) * 8) / dt : null,
      level,
      rms,
      energyPerSec: before ? perSec(snapshot.energy, before.energy) : null,
      packetsPerSec: before ? perSec(snapshot.packets, before.packets) : null,
      concealedPerSec: before ? perSec(snapshot.concealed, before.concealed) : null,
      jitterMs: Number.isFinite(stat.jitter) ? Math.round(stat.jitter * 1000) : null,
      packetsLost: finite(stat.packetsLost),
      speech: rms !== null ? rms > MIC_SPEECH_RMS : level !== null ? level > MIC_SPEECH_RMS : null,
    };
  }

  const remote = remoteInboundAudio[0] ?? null;
  const remoteAudioLoss = remote
    ? {
        packetsLost: finite(remote.packetsLost),
        jitterMs: Number.isFinite(remote.jitter) ? Math.round(remote.jitter * 1000) : null,
        roundTripMs: Number.isFinite(remote.roundTripTime) ? Math.round(remote.roundTripTime * 1000) : null,
        fractionLost: finite(remote.fractionLost),
      }
    : null;

  return {
    mic,
    audioIn,
    remoteAudioLoss,
    cumulative,
    hasInboundAudio: inboundAudio.length > 0,
    inboundAudioBytes,
  };
}

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

  let ticking = false;

  async function tick() {
    // Peers are polled sequentially, so on a busy tab one tick can still be running when the
    // next fires. Two overlapping ticks clobber `previous` and produce nonsense deltas.
    if (ticking) return;
    ticking = true;

    try {
      const results = [];
      for (const peer of mesh.list()) {
        try {
          const report = await peer.getStats();
          // Which outgoing audio stream is the microphone. There are two audio senders per
          // peer -- the mic and the shared system audio -- and they are deliberately separate,
          // so "the first audio report" is a coin flip between them. The sender the mesh
          // labels 'mic' knows its own track, and that id is what ties it to a report.
          const micTrackId = peer.sender?.('mic')?.track?.id ?? null;
          // Inbound audio is told apart the same way, by the m-line it arrived on.
          const roleByMid = {};
          for (const entry of peer.taggedSenders?.() ?? []) {
            if (entry.mid !== null && entry.mid !== undefined) roleByMid[entry.mid] = entry.role;
          }
          const sample = derive(peer.peerId, report, micTrackId, roleByMid);
          if (sample) {
            sample.transceivers = peer.transceiverSnapshot?.() ?? null;
            results.push(sample);
          }
        } catch (err) {
          logger.debug('stats: getStats failed', { peerId: peer.peerId, error: err?.message });
        }
      }
      if (results.length) onSample?.(results);
    } finally {
      ticking = false;
    }
  }

  /**
   * Reduce one getStats report to the handful of numbers the UI and the quality controller
   * actually use.
   */
  function derive(peerId, report, micTrackId = null, roleByMid = {}) {
    let outboundVideo = null;
    let inboundVideo = null;
    let candidatePair = null;
    let transport = null;
    let remoteInbound = null;

    const candidates = new Map();
    const values = [...report.values()];

    for (const stat of values) {
      switch (stat.type) {
        case 'outbound-rtp':
          if (stat.kind === 'video') outboundVideo = stat;
          break;
        case 'inbound-rtp':
          if (stat.kind === 'video') inboundVideo = stat;
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

    // The timestamp the counters were actually sampled at, taken from the report itself.
    //
    // Using performance.now() here would measure when the getStats promise happened to
    // resolve, which drifts with main-thread load -- so under a stall dt inflates and every
    // rate reads low, precisely when someone has opened the panel to find out why. Falling
    // back to the wall clock only when no report carries a timestamp.
    const now = outboundVideo?.timestamp ?? inboundVideo?.timestamp ?? transport?.timestamp ?? performance.now();
    const prev = previous.get(peerId);

    // Seconds actually elapsed, from the clock rather than the nominal interval.
    const dt = prev ? (now - prev.t) / 1000 : null;

    const audio = deriveAudio(values, {
      micTrackId,
      roleByMid,
      prev: prev?.audio ?? null,
      dtSec: dt,
    });

    const current = {
      t: now,
      bytesSent: outboundVideo?.bytesSent ?? 0,
      bytesReceived: inboundVideo?.bytesReceived ?? 0,
      micBytesSent: audio.cumulative.micBytes,
      audioBytesReceived: audio.inboundAudioBytes,
      framesEncoded: outboundVideo?.framesEncoded ?? 0,
      framesDecoded: inboundVideo?.framesDecoded ?? 0,
      framesDropped: inboundVideo?.framesDropped ?? 0,
      packetsLost: inboundVideo?.packetsLost ?? 0,
      packetsReceived: inboundVideo?.packetsReceived ?? 0,
      audio: audio.cumulative,
    };
    previous.set(peerId, current);

    if (!prev) return null; // a rate needs two samples

    // Reject a non-positive or implausible interval rather than publishing a rate derived
    // from it. This also covers the case where the timestamp source differs between two
    // samples because one report type was momentarily absent.
    if (dt <= 0 || dt > 30) return null;

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
      micSendBps: ema(
        previousSmoothed.micSendBps,
        rate(current.micBytesSent, prev.micBytesSent),
        SMOOTHING,
      ),
      audioRecvBps: ema(
        previousSmoothed.audioRecvBps,
        rate(current.audioBytesReceived, prev.audioBytesReceived),
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

      // The answer to "can he hear me", which nothing in this app could previously give.
      //
      // Two values rather than one, because they fail differently and the distinction is the
      // whole point: no report at all means the microphone is not attached to this connection,
      // while a report sitting at zero means it is attached and sending silence. The first is a
      // bug, the second is usually just the mute button.
      micSendBps: next.micSendBps,
      hasMicSender: audio.mic.hasSender,
      audioRecvBps: next.audioRecvBps,
      hasInboundAudio: audio.hasInboundAudio,

      // And the third value, without which the second is ambiguous: whether the microphone
      // the sender was given carried any SOUND. This is what separates "muted" and "silent
      // device" from "speaking", which bytes never could.
      micAudioLevel: audio.mic.level,
      micRms: audio.mic.rms,
      micEnergyPerSec: audio.mic.energyPerSec,
      micPacketsPerSec: audio.mic.packetsPerSec,
      micSpeech: audio.mic.speech,
      audioIn: audio.audioIn,
      remoteAudioLoss: audio.remoteAudioLoss,
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
