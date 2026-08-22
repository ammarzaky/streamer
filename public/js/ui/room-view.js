/**
 * All DOM rendering for the room.
 *
 * Views are pure renderers over store state and emit intents; they never call the RTC or
 * media layers. That separation is what keeps mute logic in one place instead of spread
 * across three views that slowly disagree.
 */

import { h, need, replace, show, text, cls, icon } from '../core/dom.js';
import { UI, errorCopy } from './strings.js';
import { fmtBitrate, fmtDuration, hueFromId, initials } from '../core/util.js';
import { PRESETS } from '../../shared/quality-math.js';

export function createRoomView({ store, bus, EVENTS }) {
  const el = {
    lobby: need('#lobby'),
    lobbyForm: need('#lobby-form'),
    lobbyTitle: need('#lobby-title'),
    lobbyBanner: need('#lobby-banner'),
    lobbySubmit: need('#lobby-submit'),
    name: need('#name'),
    nameError: need('#name-error'),
    accessField: need('#access-code-field'),
    accessCode: need('#access-code'),

    room: need('#room'),
    roomBanner: need('#room-banner'),
    liveBadge: need('#live-badge'),
    shareLink: need('#share-link'),
    copyLink: need('#copy-link'),

    stage: need('#stage'),
    stageEmpty: need('#stage-empty'),
    stageEmptyText: need('#stage-empty-text'),
    stageVideo: need('#stage-video'),
    stageLabel: need('#stage-label'),

    rosterList: need('#roster-list'),
    participantCount: need('#participant-count'),
    statsPanel: need('#stats-panel'),

    lobbyMeter: need('#lobby-meter-fill'),
    lobbyMicStatus: need('#lobby-mic-status'),

    fullscreenToggle: need('#fullscreen-toggle'),
    fullscreenLabel: need('#fullscreen-label'),
    stageOverlay: need('#stage-overlay'),
    overlayMic: need('#overlay-mic'),
    overlayMicIcon: need('#overlay-mic-icon'),
    overlayMicLabel: need('#overlay-mic-label'),
    overlayMeter: need('#overlay-meter-fill'),
    overlayExit: need('#overlay-exit'),

    micToggle: need('#mic-toggle'),
    micIcon: need('#mic-icon'),
    micLabel: need('#mic-label'),
    shareToggle: need('#share-toggle'),
    shareIcon: need('#share-icon'),
    shareLabel: need('#share-label'),
    leave: need('#leave'),
    endSession: need('#end-session'),

    qualityToggle: need('#quality-toggle'),
    qualityLabel: need('#quality-label'),
    qualityMenu: need('#quality-menu'),
    statsToggle: need('#stats-toggle'),

    audioSinks: need('#audio-sinks'),
  };

  /** peerId -> HTMLAudioElement. Remote audio is played through dedicated elements rather
   *  than the stage <video>, so muting a tile can never mute a person. */
  const audioElements = new Map();

  let sessionTimer = null;

  // ---------------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------------

  el.lobbyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = el.name.value.trim();
    if (!name) {
      show(el.nameError, true);
      text(el.nameError, UI.nameRequired);
      el.name.setAttribute('aria-invalid', 'true');
      el.name.focus();
      return;
    }
    show(el.nameError, false);
    el.name.removeAttribute('aria-invalid');
    bus.emit(EVENTS.INTENT_JOIN, { name, accessCode: el.accessCode.value.trim() || null });
  });

  el.name.addEventListener('input', () => {
    show(el.nameError, false);
    el.name.removeAttribute('aria-invalid');
  });

  function setLobbyMode({ creating }) {
    text(el.lobbyTitle, creating ? UI.lobbyCreateTitle : UI.lobbyTitle);
    text(el.lobbySubmit, creating ? UI.createNow : UI.joinNow);
  }

  function setLobbyBusy(busy, label) {
    el.lobbySubmit.disabled = busy;
    if (label) text(el.lobbySubmit, label);
  }

  function showLobbyError(code, detail) {
    const { message, hint } = errorCopy(code);
    show(el.lobbyBanner, true);
    el.lobbyBanner.className = 'banner banner--danger';
    replace(el.lobbyBanner, [
      h('span', { class: 'banner__text' }, [`${message} ${hint}`.trim(), detail ? ` (${detail})` : ''].join('')),
    ]);
  }

  function enterRoom() {
    show(el.lobby, false);
    show(el.room, true);
    store.setRoom({ startedAt: Date.now() });
    startSessionClock();
  }

  function startSessionClock() {
    clearInterval(sessionTimer);
    sessionTimer = setInterval(() => {
      const started = store.state.room.startedAt;
      if (started) el.copyLink.title = `${UI.sessionTime}: ${fmtDuration(Date.now() - started)}`;
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  el.micToggle.addEventListener('click', () => bus.emit(EVENTS.INTENT_TOGGLE_MIC));
  el.leave.addEventListener('click', () => bus.emit(EVENTS.INTENT_LEAVE));
  el.endSession.addEventListener('click', () => bus.emit(EVENTS.INTENT_END_SESSION));
  el.statsToggle.addEventListener('click', () => bus.emit(EVENTS.INTENT_TOGGLE_STATS));

  /**
   * The share button.
   *
   * This handler is the reason `captureDisplay()` must be reachable synchronously: the
   * listener runs inside the user gesture, and getDisplayMedia has to be called before any
   * await consumes the transient activation.
   */
  el.shareToggle.addEventListener('click', () => {
    const { share, self } = store.state;
    if (share.sharerId && share.sharerId === self.id) {
      bus.emit(EVENTS.INTENT_STOP_SHARE);
    } else if (share.sharerId) {
      bus.emit(EVENTS.INTENT_TAKE_OVER_SHARE, { currentName: share.sharerName });
    } else {
      bus.emit(EVENTS.INTENT_START_SHARE);
    }
  });

  el.copyLink.addEventListener('click', () => bus.emit(EVENTS.INTENT_COPY_LINK));

  el.qualityToggle.addEventListener('click', () => {
    const open = !store.state.ui.qualityMenuOpen;
    store.setUI({ qualityMenuOpen: open });
  });

  document.addEventListener('click', (event) => {
    if (!store.state.ui.qualityMenuOpen) return;
    if (el.qualityMenu.contains(event.target) || el.qualityToggle.contains(event.target)) return;
    store.setUI({ qualityMenuOpen: false });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderSelfControls() {
    const { self, room } = store.state;

    const muted = self.micMuted;
    el.micIcon.setAttribute('href', `/assets/icons.svg#${muted ? 'mic-off' : 'mic'}`);
    text(el.micLabel, muted ? UI.unmute : UI.mute);
    cls(el.micToggle, 'ctl--off', muted);
    cls(el.micToggle, 'ctl--active', !muted);
    el.micToggle.setAttribute('aria-pressed', String(muted));
    el.micToggle.dataset.micMuted = String(muted);

    // The overlay duplicates this control for fullscreen, where the real bar is off-screen.
    el.overlayMicIcon.setAttribute('href', `/assets/icons.svg#${muted ? 'mic-off' : 'mic'}`);
    text(el.overlayMicLabel, muted ? UI.unmute : UI.mute);
    cls(el.overlayMic, 'ctl--off', muted);
    el.overlayMic.dataset.micMuted = String(muted);

    // Only the host may end the session for everyone.
    show(el.endSession, self.isHost);
    el.endSession.dataset.isHost = String(self.isHost);

    show(el.liveBadge, self.sharing);
    cls(el.room, 'is-sharing', self.sharing);
    void room;
  }

  function renderShareControl() {
    const { share, self } = store.state;
    const isSelf = share.sharerId === self.id;
    const someoneElse = share.sharerId !== null && !isSelf;

    if (isSelf) {
      el.shareIcon.setAttribute('href', '/assets/icons.svg#screen-off');
      text(el.shareLabel, UI.stopShare);
      cls(el.shareToggle, 'ctl--active', true);
    } else {
      el.shareIcon.setAttribute('href', '/assets/icons.svg#screen');
      text(el.shareLabel, someoneElse ? 'Take over' : UI.share);
      cls(el.shareToggle, 'ctl--active', false);
    }
    el.shareToggle.dataset.sharing = String(isSelf);
  }

  function renderStage() {
    const { share, self } = store.state;
    const sharing = share.sharerId !== null;

    show(el.stageEmpty, !sharing);
    show(el.stageVideo, sharing);
    show(el.stageLabel, sharing);

    if (sharing) {
      const label = share.sharerId === self.id ? UI.youAreSharing : UI.sharingLabel(share.sharerName);
      replace(el.stageLabel, [icon('screen', 'btn__icon'), h('span', {}, label)]);
    } else {
      text(el.stageEmptyText, UI.waitingForShare);
    }
  }

  function renderRoster() {
    const peers = store.peerList();
    const { self, share } = store.state;

    const selfTile = tile({
      id: self.id ?? 'self',
      name: self.name,
      micMuted: self.micMuted,
      isSelf: true,
      isHost: self.isHost,
      isSharing: share.sharerId !== null && share.sharerId === self.id,
      pcState: 'connected',
    });

    const peerTiles = peers.map((peer) =>
      tile({
        id: peer.id,
        name: peer.name,
        micMuted: peer.micMuted,
        isSelf: false,
        isHost: store.state.room.hostPeerId === peer.id,
        isSharing: share.sharerId === peer.id,
        pcState: peer.pcState,
      }),
    );

    replace(el.rosterList, [selfTile, ...peerTiles]);
    text(el.participantCount, String(store.participantCount()));
  }

  function tile({ id, name, micMuted, isSelf, isHost, isSharing, pcState }) {
    return h(
      'div',
      {
        class: ['tile', isSelf && 'tile--self', micMuted && 'tile--muted'],
        dataset: { testid: `participant-${id}`, peerId: id, micMuted: String(micMuted) },
      },
      [
        h(
          'div',
          {
            class: 'tile__avatar',
            style: { '--tile-hue': String(hueFromId(id)) },
            'aria-hidden': 'true',
          },
          initials(name),
        ),
        h('div', { class: 'tile__body' }, [
          h('span', { class: 'tile__name' }, `${name}${isSelf ? ` (${UI.you})` : ''}`),
          h(
            'span',
            { class: 'tile__status' },
            [isHost ? UI.host : null, isSharing ? 'sharing' : null].filter(Boolean).join(' · ') ||
              statusText(pcState),
          ),
        ]),
        h('div', { class: 'tile__icons' }, [
          // Two indicators for mute -- the glyph plus a desaturated avatar. One alone is
          // missed at a glance, and "is he muted or just quiet?" is worth designing out.
          micMuted
            ? h('span', { dataset: { testid: `mic-state-${id}` } }, [
                icon('mic-off', 'tile__icon tile__icon--muted'),
              ])
            : h('span', { dataset: { testid: `mic-state-${id}` } }, [
                icon('mic', 'tile__icon'),
              ]),
          isSharing ? icon('screen', 'tile__icon tile__icon--sharing') : null,
          isSelf ? null : h('span', { class: ['tile__conn', `tile__conn--${pcState}`] }),
        ]),
      ],
    );
  }

  function statusText(pcState) {
    switch (pcState) {
      case 'connected':
        return UI.connected;
      case 'connecting':
        return UI.connecting;
      case 'reconnecting':
        return UI.reconnecting;
      case 'failed':
        return 'Connection failed';
      default:
        return UI.connecting;
    }
  }

  // ---------------------------------------------------------------------------
  // Quality menu
  // ---------------------------------------------------------------------------

  function renderQuality() {
    const { quality, ui } = store.state;
    const current = PRESETS.find((p) => p.id === quality.presetId) ?? PRESETS.at(-1);

    text(el.qualityLabel, current.label);
    el.qualityToggle.setAttribute('aria-expanded', String(ui.qualityMenuOpen));
    show(el.qualityMenu, ui.qualityMenuOpen);
    if (!ui.qualityMenuOpen) return;

    const options = PRESETS.map((preset) =>
      h(
        'button',
        {
          class: 'quality__option',
          type: 'button',
          role: 'radio',
          'aria-checked': String(preset.id === quality.presetId),
          dataset: { testid: `quality-${preset.id}`, presetId: preset.id },
          onclick: () => {
            store.setUI({ qualityMenuOpen: false });
            bus.emit(EVENTS.INTENT_SET_QUALITY, { presetId: preset.id });
          },
        },
        [
          h('span', { class: 'quality__label' }, preset.label),
          h('span', { class: 'quality__note' }, preset.note),
        ],
      ),
    );

    // Target and actual sit together: the gap between what was asked for and what is being
    // delivered is the most useful thing this panel can show.
    const actual = quality.actual;
    const footLines = [
      `${UI.statsTarget}: ${current.width}x${current.height} @ ${current.frameRate}`,
      actual
        ? `${UI.statsActual}: ${actual.width}x${actual.height} @ ${Math.round(actual.fps)}`
        : `${UI.statsActual}: —`,
      `${UI.statsLimitedBy}: ${limitedByLabel(quality.limitedBy)}`,
    ];

    replace(el.qualityMenu, [
      ...options,
      h(
        'div',
        { class: 'quality__foot', dataset: { testid: 'quality-foot' } },
        footLines.map((line) => h('div', {}, line)),
      ),
    ]);
  }

  function limitedByLabel(limitedBy) {
    switch (limitedBy) {
      case 'cpu':
        return UI.limitedCpu;
      case 'bandwidth':
        return UI.limitedBandwidth;
      case 'mesh-budget':
        return UI.limitedMeshBudget;
      default:
        return UI.limitedNone;
    }
  }

  // ---------------------------------------------------------------------------
  // Stats panel
  // ---------------------------------------------------------------------------

  function renderStats() {
    const { ui, quality } = store.state;
    show(el.statsPanel, ui.statsOpen);
    if (!ui.statsOpen) return;

    const peers = store.peerList();
    if (peers.length === 0) {
      replace(el.statsPanel, [
        h('div', { class: 'stats' }, h('span', { class: 'stats__key' }, 'No peers connected.')),
      ]);
      return;
    }

    const blocks = peers.map((peer) => {
      const s = peer.stats;
      const conn = s?.connectionType?.kind ?? 'unknown';

      return h('div', { class: 'stats__peer', dataset: { testid: `stats-${peer.id}` } }, [
        h('div', { class: 'stats__name' }, peer.name),
        h('div', { class: 'stats__grid' }, [
          row(UI.statsSending, fmtBitrate(s?.sendBps), 'stat-send'),
          row(UI.statsMicSending, micSendingLabel(s), 'stat-mic-send'),
          row(UI.statsReceiving, fmtBitrate(s?.recvBps), 'stat-bitrate'),
          row(UI.statsAudioReceiving, fmtBitrate(s?.audioRecvBps), 'stat-audio-recv'),
          row(
            UI.statsResolution,
            s?.recvWidth ? `${s.recvWidth}x${s.recvHeight}` : '—',
            'stat-resolution',
          ),
          row(UI.statsFrames, s?.recvFps ? `${Math.round(s.recvFps)} fps` : '—', 'stat-fps'),
          row(UI.statsDropped, s?.framesDropped != null ? String(s.framesDropped) : '—', 'stat-dropped'),
          row(UI.statsConnection, connectionLabel(conn), 'stat-connection-type'),
          row(UI.statsRoundTrip, s?.roundTripMs != null ? `${s.roundTripMs} ms` : '—', 'stat-rtt'),
          row(
            UI.statsPacketLoss,
            s?.lossRatio != null ? `${(s.lossRatio * 100).toFixed(1)}%` : '—',
            'stat-loss',
          ),
        ]),
      ]);
    });

    replace(el.statsPanel, [
      h('div', { class: 'stats' }, [
        h('div', { class: 'stats__grid', style: { marginBottom: 'var(--space-3)' } }, [
          row(UI.statsLimitedBy, limitedByLabel(quality.limitedBy), 'stat-limited-by'),
        ]),
        ...blocks,
      ]),
    ]);
  }

  function row(key, value, testid) {
    return [
      h('span', { class: 'stats__key' }, key),
      h('span', { class: 'stats__val', dataset: { testid } }, value ?? '—'),
    ];
  }

  /**
   * Why the far end cannot hear you, narrowed to an answer you can act on.
   *
   * The distinction that matters is **whether a microphone is attached to this connection at
   * all**. No outbound audio report means it is not, which is a fault and was previously
   * invisible from either end. A report means it is, and the number is what is leaving.
   *
   * Mute is reported from local state rather than inferred from the bitrate, because muting
   * here is `track.enabled = false`: the RTP session deliberately stays up and keeps sending
   * silence -- measured at around 14 kbps. A muted microphone therefore looks almost exactly
   * like a quiet one on the wire, which is precisely why the `mute-state` message has to exist
   * at all, and why guessing from traffic would be wrong.
   */
  function micSendingLabel(sample) {
    if (!sample) return '—';
    if (!sample.hasMicSender) return UI.statsMicNotSent;
    const rate = fmtBitrate(sample.micSendBps);
    return store.state.self.micMuted ? `${rate} — ${UI.statsMicMuted}` : rate;
  }

  function connectionLabel(kind) {
    switch (kind) {
      case 'local':
        return UI.connLocal;
      case 'direct':
        return UI.connDirect;
      case 'relay':
        return UI.connRelay;
      default:
        return UI.connUnknown;
    }
  }

  // ---------------------------------------------------------------------------
  // Media attachment
  // ---------------------------------------------------------------------------

  function attachRemoteVideo(track) {
    // Replacing srcObject with an identical single-track stream restarts playback for no
    // reason, so skip when the same track is already showing.
    const current = el.stageVideo.srcObject;
    if (current instanceof MediaStream && current.getVideoTracks()[0] === track) return;

    el.stageVideo.srcObject = new MediaStream([track]);
    cls(el.stageVideo, 'stage__video--mirror', false);
    el.stageVideo.play().catch(() => {
      // Autoplay refusal on a muted element is unusual but not fatal -- the picture appears
      // as soon as the user interacts with the page.
    });
  }

  /** The sharer's own preview. Same element, same path -- there is no second video surface to
   *  keep in sync. */
  function attachLocalPreview(track) {
    attachRemoteVideo(track);
  }

  function clearRemoteVideo() {
    el.stageVideo.srcObject = null;
  }

  /** Remote audio gets its own element per peer, so per-peer volume stays possible and the
   *  stage video element can remain muted. */
  function attachRemoteAudio(peerId, track) {
    let audio = audioElements.get(peerId);
    if (!audio) {
      audio = h('audio', { autoplay: true, playsInline: true });
      audioElements.set(peerId, audio);
      el.audioSinks.append(audio);
    }
    const existing = audio.srcObject;
    if (existing instanceof MediaStream) existing.addTrack(track);
    else audio.srcObject = new MediaStream([track]);
    audio.play().catch(() => {});
  }

  function removePeerMedia(peerId) {
    const audio = audioElements.get(peerId);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      audioElements.delete(peerId);
    }
  }

  /** Drop every remote audio element. Needed after our own reconnect, where the peers keep
   *  their identities but every id changes, so no peer-left ever arrives to clean them up. */
  function removeAllPeerMedia() {
    for (const peerId of [...audioElements.keys()]) removePeerMedia(peerId);
    clearRemoteVideo();
  }

  // ---------------------------------------------------------------------------
  // Banners
  // ---------------------------------------------------------------------------

  function showBanner(kind, message, action) {
    show(el.roomBanner, true);
    el.roomBanner.className = `banner banner--${kind}`;
    replace(el.roomBanner, [
      h('span', { class: 'banner__text', dataset: { testid: 'room-banner' } }, message),
      action ? h('button', { class: 'btn btn--sm btn--secondary', onclick: action.onClick }, action.label) : null,
    ]);
  }

  function hideBanner() {
    show(el.roomBanner, false);
  }

  function setShareLink(link) {
    text(el.shareLink, link.replace(/^https?:\/\//, ''));
    el.shareLink.title = link;
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  store.subscribe('self', () => {
    renderSelfControls();
    renderRoster();
  });
  store.subscribe('peers', () => {
    renderRoster();
    renderStats();
  });
  store.subscribe('share', () => {
    renderShareControl();
    renderStage();
    renderRoster();
    renderSelfControls();
  });
  store.subscribe('quality', renderQuality);
  store.subscribe('stats', renderStats);
  store.subscribe('ui', () => {
    renderQuality();
    renderStats();
  });

  // ---------------------------------------------------------------------------
  // Microphone level
  // ---------------------------------------------------------------------------

  /**
   * Paint a 0..1 level onto a bar.
   *
   * The amber state is the useful one: the meter is fed a clone of the track that stays enabled
   * while muted, so a bar moving in amber is the app saying "you are talking and nobody can
   * hear you" -- which is the exact situation that prompted all of this.
   */
  function paintMeter(bar, level, { muted = false, dead = false } = {}) {
    if (!bar) return;
    // A gentle curve: speech sits low in a linear scale and the bar would barely move.
    const shown = dead ? 0 : Math.min(100, Math.round(Math.sqrt(Math.max(0, level)) * 130));
    bar.style.width = `${shown}%`;
    cls(bar, 'meter__fill--muted', muted && !dead);
    cls(bar, 'meter__fill--dead', dead);
  }

  function setLobbyMicLevel(level, { dead = false } = {}) {
    paintMeter(el.lobbyMeter, level, { dead });
  }

  function setLobbyMicStatus(message) {
    text(el.lobbyMicStatus, String(message ?? ''));
  }

  function setStageMicLevel(level) {
    paintMeter(el.overlayMeter, level, { muted: store.state.self.micMuted });
  }

  // ---------------------------------------------------------------------------
  // Fullscreen
  // ---------------------------------------------------------------------------

  /** Idle-hide for the overlay, so it does not sit over the picture while nobody needs it. */
  let overlayIdleTimer = null;

  function isFullscreen() {
    return document.fullscreenElement === el.stage;
  }

  async function toggleFullscreen() {
    try {
      if (isFullscreen()) await document.exitFullscreen();
      // The CONTAINER, not the <video>: fullscreening the element itself replaces everything
      // with a bare video surface and loses the label and these controls with it.
      else await el.stage.requestFullscreen();
    } catch {
      // Refused (no user gesture, or a policy blocks it). The fullscreenchange handler is the
      // only thing that updates the button, so a refusal simply leaves it where it was.
    }
  }

  function nudgeOverlay() {
    if (!isFullscreen()) return;
    cls(el.stageOverlay, 'stage__overlay--idle', false);
    clearTimeout(overlayIdleTimer);
    overlayIdleTimer = setTimeout(() => {
      cls(el.stageOverlay, 'stage__overlay--idle', true);
    }, 2600);
  }

  // Driven by the event rather than by the request resolving, so Escape and the window manager
  // leave the button telling the truth.
  document.addEventListener('fullscreenchange', () => {
    const on = isFullscreen();
    show(el.stageOverlay, on);
    cls(el.fullscreenToggle, 'btn--active', on);
    text(el.fullscreenLabel, on ? UI.exitFullscreen : UI.fullscreen);
    clearTimeout(overlayIdleTimer);
    if (on) nudgeOverlay();
    else cls(el.stageOverlay, 'stage__overlay--idle', false);
  });

  el.stage.addEventListener('mousemove', nudgeOverlay);
  el.stage.addEventListener('touchstart', nudgeOverlay, { passive: true });

  el.fullscreenToggle.addEventListener('click', () => void toggleFullscreen());
  el.overlayExit.addEventListener('click', () => void toggleFullscreen());
  el.overlayMic.addEventListener('click', () => bus.emit(EVENTS.INTENT_TOGGLE_MIC));

  // Where people actually try first.
  el.stageVideo.addEventListener('dblclick', () => void toggleFullscreen());

  document.addEventListener('keydown', (event) => {
    // Not while typing a name or an access code.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      void toggleFullscreen();
    }
  });

  function destroy() {
    clearTimeout(overlayIdleTimer);
    clearInterval(sessionTimer);
    for (const [peerId] of audioElements) removePeerMedia(peerId);
  }

  return {
    el,
    setLobbyMode,
    setLobbyBusy,
    showLobbyError,
    enterRoom,
    setShareLink,
    showBanner,
    hideBanner,
    attachRemoteVideo,
    attachLocalPreview,
    clearRemoteVideo,
    attachRemoteAudio,
    removePeerMedia,
    removeAllPeerMedia,
    setLobbyMicLevel,
    setLobbyMicStatus,
    setStageMicLevel,
    toggleFullscreen,
    isFullscreen,
    renderAll() {
      renderSelfControls();
      renderShareControl();
      renderStage();
      renderRoster();
      renderQuality();
      renderStats();
    },
    destroy,
  };
}
