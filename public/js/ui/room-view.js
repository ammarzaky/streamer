/**
 * All DOM rendering for the room.
 *
 * Views are pure renderers over store state and emit intents; they never call the RTC or
 * media layers. That separation is what keeps mute logic in one place instead of spread
 * across three views that slowly disagree.
 *
 * The one thing this view OWNS rather than renders is the set of remote <audio> elements,
 * because they are DOM. Their state (playing, blocked, muted) is exposed read-only through
 * `audioSinkState` so the composition root can put it in the diagnostics and the stats panel.
 */

import { h, need, replace, show, text, cls, icon } from '../core/dom.js';
import { UI, errorCopy, TILE, MIC_MENU, STATS_AUDIO, SELFTEST, resolve } from './strings.js';
import { biNode } from './dialog.js';
import { fmtBitrate, fmtDuration, hueFromId, initials } from '../core/util.js';
import { PRESETS } from '../../shared/quality-math.js';
import { logger } from '../core/logger.js';
import { RESERVED_DEVICE_IDS, friendlyDeviceLabel } from '../media/mic-constraints.js';
import { createRemoteAudioMixer, clampGain, MAX_GAIN, UNITY_GAIN } from '../media/remote-audio.js';

/** A peer report older than this no longer describes the present. */
const REPORT_STALE_MS = 8000;

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
    lobbyMicDevice: need('#lobby-mic-device'),

    fullscreenToggle: need('#fullscreen-toggle'),
    fullscreenLabel: need('#fullscreen-label'),
    stageOverlay: need('#stage-overlay'),
    overlayMic: need('#overlay-mic'),
    overlayMicIcon: need('#overlay-mic-icon'),
    overlayMicLabel: need('#overlay-mic-label'),
    overlayMeter: need('#overlay-meter-fill'),
    overlayExit: need('#overlay-exit'),

    micGroup: need('#mic-group'),
    micToggle: need('#mic-toggle'),
    micIcon: need('#mic-icon'),
    micLabel: need('#mic-label'),
    ctlMeter: need('#ctl-meter-fill'),
    micMenuToggle: need('#mic-menu-toggle'),
    micMenu: need('#mic-menu'),
    micHint: need('#mic-hint'),
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
  /** peerId -> the last play() outcome and element events, for diagnostics. */
  const sinkFacts = new Map();

  /**
   * The Web Audio path, for volumes the element cannot reach (`.volume` stops at 1) and for
   * nothing else. It stays dormant until somebody actually moves a slider -- see
   * `media/remote-audio.js` -- so an ordinary call has exactly the playback it always had.
   */
  let mixerOutput = null;
  const mixer = createRemoteAudioMixer({
    onOutput: (stream) => {
      mixerOutput = h('audio', { autoplay: true, playsInline: true, dataset: { testid: 'mixer-output' } });
      mixerOutput.muted = incomingMuted;
      mixerOutput.srcObject = stream;
      el.audioSinks.append(mixerOutput);
      applySinkId(mixerOutput);
      mixerOutput.play().catch((err) => {
        logger.warn('audio: mixer output play rejected', { name: err?.name });
        bus.emit(EVENTS.AUDIO_PLAYBACK_BLOCKED, { peerId: null, name: err?.name ?? 'play-rejected' });
      });
    },
  });

  /** The chosen output device, applied to every element present and future. */
  let speakerDeviceId = null;

  let sessionTimer = null;
  /** The last level painted, so a mute flip can repaint the colour without a new sample. */
  let lastLevel = 0;
  let lastDead = false;
  /** "Mute incoming audio (test)": applied to every element, present and future. */
  let incomingMuted = false;

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

  el.lobbyMicDevice.addEventListener('change', () => {
    const deviceId = el.lobbyMicDevice.value || null;
    bus.emit(EVENTS.INTENT_SET_MIC_DEVICE, { deviceId, lobby: true });
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

  /**
   * Usable input devices with their display labels. Entries with no id (Firefox before full
   * permission) and duplicates are dropped, so neither list can offer a button that re-opens
   * the default for nothing.
   */
  function deviceOptions(devices) {
    return listDevices(devices?.inputs);
  }

  /** The same list for the other direction. Windows names the reserved output ids exactly as it
   *  names the input ones, so the labelling rules are shared rather than re-derived. */
  function speakerOptions(devices) {
    return listDevices(devices?.outputs);
  }

  function listDevices(entries) {
    const seen = new Set();
    const out = [];
    for (const entry of entries ?? []) {
      if (!entry.deviceId || seen.has(entry.deviceId)) continue;
      seen.add(entry.deviceId);
      let label = friendlyDeviceLabel(entry) || entry.deviceId.slice(0, 8);
      if (entry.deviceId === RESERVED_DEVICE_IDS.DEFAULT) label = `${UI.micSystemDefault} — ${label}`;
      if (entry.deviceId === RESERVED_DEVICE_IDS.COMMUNICATIONS) label = `${UI.micCommunications} — ${label}`;
      out.push({ deviceId: entry.deviceId, label });
    }
    return out;
  }

  /** Fill a <select> with the input devices, reserved entries first. */
  function fillDeviceSelect(select, devices, currentDeviceId) {
    const options = deviceOptions(devices);
    replace(
      select,
      options.map((o) => h('option', { value: o.deviceId, selected: o.deviceId === (currentDeviceId ?? RESERVED_DEVICE_IDS.DEFAULT) }, o.label)),
    );
    if (currentDeviceId && options.some((o) => o.deviceId === currentDeviceId)) select.value = currentDeviceId;
    show(select, options.length > 0);
  }

  function setLobbyDevices(devices, currentDeviceId) {
    fillDeviceSelect(el.lobbyMicDevice, devices, currentDeviceId);
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
  el.micMenuToggle.addEventListener('click', () => bus.emit(EVENTS.INTENT_TOGGLE_MIC_MENU));
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
    if (store.state.ui.qualityMenuOpen) {
      if (!el.qualityMenu.contains(event.target) && !el.qualityToggle.contains(event.target)) {
        store.setUI({ qualityMenuOpen: false });
      }
    }
    if (store.state.ui.micMenuOpen) {
      if (!el.micMenu.contains(event.target) && !el.micMenuToggle.contains(event.target)) {
        store.setUI({ micMenuOpen: false });
      }
    }
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
    // The device Windows actually opened, where a hover can read it.
    el.micToggle.title = self.micDevice?.label ? `${UI.micLabel}: ${self.micDevice.label}` : UI.micLabel;

    // The overlay duplicates this control for fullscreen, where the real bar is off-screen.
    el.overlayMicIcon.setAttribute('href', `/assets/icons.svg#${muted ? 'mic-off' : 'mic'}`);
    text(el.overlayMicLabel, muted ? UI.unmute : UI.mute);
    cls(el.overlayMic, 'ctl--off', muted);
    el.overlayMic.dataset.micMuted = String(muted);

    // Amber/green must flip the instant the button does, not on the next meter sample.
    setStageMicLevel(lastLevel, { dead: lastDead });

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

  /**
   * What a peer's last report says about us, as one tile line.
   *
   * The report is the peer's own measurement of what it receives from us and whether its
   * audio element is playing -- the two facts that used to be available only by asking.
   */
  function hearLine(peer) {
    const { self } = store.state;
    const report = peer.hearsMe;
    if (!report || !Number.isFinite(report.at) || Date.now() - report.at > REPORT_STALE_MS) return null;
    if (report.mutedForTest) return { pair: TILE.mutedForTest, tone: 'warn' };
    if (self.micMuted) return null;
    if (Number.isFinite(report.level) && report.level >= 0.01) {
      return { pair: resolve(TILE.hearsYou, { level: report.level }), tone: 'ok' };
    }
    if (report.playing === false) return { pair: TILE.notPlaying, tone: 'bad' };
    // Only claim silence while we are actually speaking; a quiet moment is not a fault.
    if (lastLevel > 0.06 && Number.isFinite(report.level)) return { pair: TILE.cannotHearYou, tone: 'bad' };
    return null;
  }

  function renderRoster() {
    const peers = store.peerList();
    const { self, share, audio } = store.state;

    const selfTile = tile({
      id: self.id ?? 'self',
      name: self.name,
      micMuted: self.micMuted,
      isSelf: true,
      isHost: self.isHost,
      isSharing: share.sharerId !== null && share.sharerId === self.id,
      pcState: 'connected',
      // CAPTURE_SILENT deliberately absent: it rests on a clone of the microphone that can
      // fail on its own, and "nobody hears you" on your own tile while the call is working is
      // the same false alarm the banner used to raise. UNHEARD_TRANSPORT is a peer SAYING they
      // cannot hear us, which is evidence of a different and better kind.
      hear: audio.health?.code === 'UNHEARD_TRANSPORT' ? { pair: TILE.nobodyHears, tone: 'bad' } : null,
      deviceLabel: self.micDevice?.label ?? null,
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
        hear: hearLine(peer),
      }),
    );

    replace(el.rosterList, [selfTile, ...peerTiles]);
    text(el.participantCount, String(store.participantCount()));
    // The self tile was just rebuilt; give its bar the current level immediately.
    setStageMicLevel(lastLevel, { dead: lastDead });
  }

  function tile({ id, name, micMuted, isSelf, isHost, isSharing, pcState, hear, deviceLabel }) {
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
            { class: 'tile__status', title: deviceLabel ?? undefined },
            [isHost ? UI.host : null, isSharing ? 'sharing' : null].filter(Boolean).join(' · ') ||
              statusText(pcState),
          ),
          isSelf
            ? h('span', { class: 'meter meter--tile', 'aria-hidden': 'true' }, [
                h('span', { class: 'meter__fill', dataset: { testid: 'tile-meter-self' } }),
              ])
            : null,
          hear
            ? h(
                'span',
                { class: ['tile__hear', `tile__hear--${hear.tone}`], dataset: { testid: `hear-${id}`, tone: hear.tone } },
                [biNode(hear.pair, { inline: true })],
              )
            : null,
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
    const { quality, ui, share } = store.state;
    // No fallback to the top preset: an unknown id used to render "1080p 60", so a client that
    // had not been told a preset asserted the highest one on the ladder.
    const current = PRESETS.find((p) => p.id === quality.presetId) ?? null;
    const actual = quality.actual;

    // The preset is a LOCAL target for a LOCAL share, and it is never sent over the wire. On a
    // viewer's screen it describes a stream they are not sending, so labelling their button
    // with it is a claim about someone else's encoder that this side cannot make. While
    // somebody else shares, the button shows what is arriving instead.
    const watchingOther = share.sharerId !== null && share.sharerId !== store.state.self.id;
    text(
      el.qualityLabel,
      watchingOther
        ? actual
          ? `${actual.height}p · ${Math.round(actual.fps)} fps`
          : UI.qualityReceiving
        : (current?.label ?? '—'),
    );
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
    // delivered is the most useful thing this panel can show. `actual` is outbound for the
    // sharer and inbound for everyone else, and it is labelled so nobody reads a number about
    // their decoder as a number about their encoder.
    const footLines = [
      current
        ? `${UI.statsTarget}: ${current.width}x${current.height} @ ${current.frameRate}`
        : `${UI.statsTarget}: —`,
      actual
        ? `${actual.inbound ? UI.statsReceiving : UI.statsActual}: ${actual.width}x${actual.height} @ ${Math.round(actual.fps)}`
        : `${UI.statsActual}: —`,
      // `limitedBy` only ever describes the LOCAL encoder. On a viewer's screen that encoder is
      // idle, so the honest answer is that we do not know -- printing "Nothing" there told
      // people their poor picture was unconstrained when nothing here had measured it.
      watchingOther
        ? `${UI.statsLimitedBy}: —`
        : `${UI.statsLimitedBy}: ${limitedByLabel(quality.limitedBy)}`,
    ];
    // Only for the sharer, and only once measured: this is the answer to "why is my sharp
    // screen sending two frames a second", which otherwise looks like a fault.
    if (!watchingOther && quality.contentMode) {
      footLines.push(`${UI.statsContent}: ${contentModeLabel(quality.contentMode)}`);
    }

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

  function contentModeLabel(mode) {
    return mode === 'still' ? UI.contentStill : UI.contentMoving;
  }

  // ---------------------------------------------------------------------------
  // Microphone menu
  // ---------------------------------------------------------------------------

  function menuButton(pair, { testid, onclick, checked = null, disabled = false }) {
    return h(
      'button',
      {
        class: 'quality__option',
        type: 'button',
        role: checked === null ? 'menuitem' : 'menuitemradio',
        'aria-checked': checked === null ? undefined : String(checked),
        disabled,
        dataset: { testid },
        onclick,
      },
      [h('span', { class: 'quality__label' }, [biNode(pair, { inline: true })])],
    );
  }

  function menuCheck(pair, { testid, checked, onchange }) {
    const input = h('input', { type: 'checkbox', checked, dataset: { testid }, onchange: () => onchange(input.checked) });
    return h('label', { class: 'mic-menu__check' }, [input, h('span', {}, [biNode(pair, { inline: true })])]);
  }

  /**
   * peerId -> the live `<input type="range">`, so a re-render can update its VALUE without
   * replacing the node. Replacing a slider that is mid-drag cancels the drag, and the menu
   * re-renders on any audio-slice change -- which a moving slider is.
   */
  const volumeInputs = new Map();

  /** One participant's volume row: a slider and the percentage it is currently at. */
  function volumeRow(peerId, name, gain) {
    const readout = h('span', { class: 'mic-menu__volume-value', dataset: { testid: `peer-volume-value-${peerId}` } }, `${Math.round(gain * 100)}%`);
    const input = h('input', {
      type: 'range',
      class: 'mic-menu__volume-slider',
      min: '0',
      // Percent rather than gain, so the step is a whole number and the keyboard arrows move
      // by 5% instead of by an unrepresentable fraction.
      max: String(MAX_GAIN * 100),
      step: '5',
      value: String(Math.round(gain * 100)),
      dataset: { testid: `peer-volume-${peerId}` },
      'aria-label': `${name}: ${UI.volumeLabel}`,
      oninput: () => {
        const next = Number(input.value) / 100;
        readout.textContent = `${input.value}%`;
        bus.emit(EVENTS.INTENT_SET_PEER_VOLUME, { peerId, gain: next });
      },
    });
    volumeInputs.set(peerId, { input, readout });
    return h('div', { class: 'mic-menu__volume', dataset: { testid: `peer-volume-row-${peerId}` } }, [
      h('div', { class: 'mic-menu__volume-head' }, [
        h('span', { class: 'mic-menu__volume-name' }, name),
        readout,
      ]),
      input,
    ]);
  }

  /**
   * Push new values into sliders that already exist, instead of rebuilding them.
   *
   * Skipped for the one the user is holding: writing `.value` under an active drag makes the
   * thumb jump back to wherever the last render thought it was.
   */
  function syncVolumeInputs() {
    const { volumes } = store.state.audio;
    for (const [peerId, { input, readout }] of volumeInputs) {
      if (document.activeElement === input) continue;
      const percent = String(Math.round(clampGain(volumes[peerId] ?? UNITY_GAIN) * 100));
      if (input.value === percent) continue;
      input.value = percent;
      readout.textContent = `${percent}%`;
    }
  }

  /** What the open menu was last built from, so a stats tick does not rebuild it under a
   *  pointer that is mid-press. */
  let micMenuKey = null;

  function renderMicMenu() {
    const { ui, audio, self } = store.state;
    el.micMenuToggle.setAttribute('aria-expanded', String(ui.micMenuOpen));
    show(el.micMenu, ui.micMenuOpen);
    if (!ui.micMenuOpen) {
      micMenuKey = null;
      return;
    }

    const currentId = self.micDevice?.settings?.deviceId ?? null;
    const options = deviceOptions(audio.devices);
    const outputs = speakerOptions(audio.devices);
    const processing = audio.processing ?? self.micDevice?.settings ?? {};
    const roster = store.peerList().map((p) => [p.id, p.name]);
    // `displayAudioActive` rather than "am I sharing": the warning is about the SHARED AUDIO
    // track carrying this machine's playback, and a screen share with the audio box unticked
    // carries nothing to warn about.
    const sharingSystemAudio = Boolean(self.sharing && self.displayAudioActive);
    const key = JSON.stringify([
      sharingSystemAudio,
      options,
      outputs,
      audio.speakerDeviceId,
      currentId,
      self.micDevice?.label ?? null,
      processing.echoCancellation,
      processing.noiseSuppression,
      processing.autoGainControl,
      audio.selfTest?.state,
      audio.selfTest?.verdict,
      audio.selfTest?.blobUrl,
      audio.incomingMutedForTest,
      // WHO is in the room, never how loud they are: a volume in this key would rebuild the
      // menu on the first pixel of every drag and take the slider out from under the pointer.
      roster,
    ]);
    if (key === micMenuKey) {
      syncVolumeInputs();
      return;
    }
    micMenuKey = key;
    volumeInputs.clear();

    const deviceButtons = options.map((o) => {
      const checked = currentId === o.deviceId;
      return menuButton({ en: o.label }, {
        testid: `mic-device-${o.deviceId.slice(0, 12)}`,
        checked,
        onclick: () => {
          store.setUI({ micMenuOpen: false });
          bus.emit(EVENTS.INTENT_SET_MIC_DEVICE, { deviceId: o.deviceId });
        },
      });
    });
    const checks = [
      ['echoCancellation', MIC_MENU.aec, 'mic-proc-aec'],
      ['noiseSuppression', MIC_MENU.ns, 'mic-proc-ns'],
      ['autoGainControl', MIC_MENU.agc, 'mic-proc-agc'],
    ].map(([key, pair, testid]) =>
      menuCheck(pair, {
        testid,
        checked: Boolean(processing[key]),
        onchange: (checked) => bus.emit(EVENTS.INTENT_SET_MIC_PROCESSING, { patch: { [key]: checked } }),
      }),
    );

    replace(el.micMenu, [
      h('div', { class: 'mic-menu__section' }, [biNode(MIC_MENU.device, { inline: true })]),
      self.micDevice?.label
        ? h('div', { class: 'mic-menu__note', dataset: { testid: 'mic-menu-current' } }, [
            biNode(resolve(MIC_MENU.current, { label: self.micDevice.label }), { inline: true }),
          ])
        : null,
      ...deviceButtons,

      h('div', { class: 'mic-menu__section' }, [biNode(MIC_MENU.speaker, { inline: true })]),
      ...(speakerSelectionSupported()
        ? outputs.map((o) =>
            menuButton({ en: o.label }, {
              testid: `speaker-device-${o.deviceId.slice(0, 12)}`,
              checked: (audio.speakerDeviceId ?? RESERVED_DEVICE_IDS.DEFAULT) === o.deviceId,
              onclick: () => bus.emit(EVENTS.INTENT_SET_SPEAKER_DEVICE, { deviceId: o.deviceId }),
            }),
          )
        : [h('div', { class: 'mic-menu__note', dataset: { testid: 'speaker-unsupported' } }, [
            biNode(MIC_MENU.speakerUnsupported, { inline: true }),
          ])]),

      ...(roster.length
        ? [
            h('div', { class: 'mic-menu__section' }, [biNode(MIC_MENU.volumes, { inline: true })]),
            ...roster.map(([peerId, name]) =>
              volumeRow(peerId, name, clampGain(audio.volumes[peerId] ?? UNITY_GAIN)),
            ),
            h('div', { class: 'mic-menu__note' }, [biNode(MIC_MENU.volumeNote, { inline: true })]),
            // Only when both are true, because only then does it matter: a system-audio share
            // carries this machine's playback, so a boost is re-sent to the person boosted.
            sharingSystemAudio
              ? h('div', { class: 'mic-menu__note mic-menu__note--warn', dataset: { testid: 'volume-loopback-warning' } }, [
                  biNode(MIC_MENU.volumeLoopbackWarning, { inline: true }),
                ])
              : null,
          ]
        : []),

      h('div', { class: 'mic-menu__section' }, [biNode(MIC_MENU.processing, { inline: true })]),
      ...checks,
      h('div', { class: 'mic-menu__note' }, [biNode(MIC_MENU.processingNote, { inline: true })]),
      h('div', { class: 'mic-menu__section' }, [biNode(MIC_MENU.tests, { inline: true })]),
      menuButton(MIC_MENU.selfTest, {
        testid: 'mic-selftest',
        disabled: audio.selfTest?.state === 'recording' || audio.selfTest?.state === 'playing',
        onclick: () => bus.emit(EVENTS.INTENT_MIC_SELFTEST),
      }),
      audio.selfTest?.verdict
        ? h('div', { class: 'mic-menu__note', dataset: { testid: 'mic-selftest-result' } }, [biNode(audio.selfTest.verdict, { inline: true })])
        : null,
      audio.selfTest?.blobUrl
        ? h('a', { class: 'quality__option', href: audio.selfTest.blobUrl, download: 'mic-selftest.webm', dataset: { testid: 'mic-selftest-save' } }, [
            h('span', { class: 'quality__label' }, [biNode(SELFTEST.save, { inline: true })]),
          ])
        : null,
      menuCheck(MIC_MENU.incomingMute, {
        testid: 'mic-incoming-mute',
        checked: audio.incomingMutedForTest,
        onchange: () => bus.emit(EVENTS.INTENT_TOGGLE_INCOMING_AUDIO_TEST),
      }),
      h('div', { class: 'mic-menu__note' }, [biNode(MIC_MENU.incomingMuteNote, { inline: true })]),
      menuButton(MIC_MENU.releaseMic, { testid: 'mic-release-test', onclick: () => bus.emit(EVENTS.INTENT_RELEASE_MIC_TEST) }),
      menuButton(MIC_MENU.audioCheck, {
        testid: 'mic-audio-check',
        onclick: () => {
          store.setUI({ micMenuOpen: false });
          bus.emit(EVENTS.INTENT_AUDIO_CHECK);
        },
      }),
      menuButton(MIC_MENU.copyDiagnostics, {
        testid: 'mic-copy-diagnostics',
        onclick: () => {
          store.setUI({ micMenuOpen: false });
          bus.emit(EVENTS.INTENT_COPY_DIAGNOSTICS);
        },
      }),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Stats panel
  // ---------------------------------------------------------------------------

  function renderStats() {
    const { ui, quality, audio } = store.state;
    show(el.statsPanel, ui.statsOpen);
    if (!ui.statsOpen) return;

    const peers = store.peerList();
    const actions = h('div', { class: 'stats__actions' }, [
      h('button', { class: 'btn btn--secondary btn--sm', dataset: { testid: 'stats-audio-check' }, onclick: () => bus.emit(EVENTS.INTENT_AUDIO_CHECK) }, UI.statsAudioCheck),
      h('button', { class: 'btn btn--secondary btn--sm', dataset: { testid: 'stats-copy-diagnostics' }, onclick: () => bus.emit(EVENTS.INTENT_COPY_DIAGNOSTICS) }, UI.copyDiagnostics),
    ]);

    if (peers.length === 0) {
      replace(el.statsPanel, [
        h('div', { class: 'stats' }, [actions, h('span', { class: 'stats__key' }, 'No peers connected.')]),
      ]);
      return;
    }

    const blocks = peers.map((peer) => {
      const s = peer.stats;
      const conn = s?.connectionType?.kind ?? 'unknown';
      const sink = audio.sinks?.[peer.id] ?? null;

      return h('div', { class: 'stats__peer', dataset: { testid: `stats-${peer.id}` } }, [
        h('div', { class: 'stats__name' }, [
          peer.name,
          h(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              dataset: { testid: `stats-request-dump-${peer.id}` },
              title: UI.statsRequestPeerDiagnostics,
              onclick: () => bus.emit(EVENTS.INTENT_REQUEST_PEER_DIAGNOSTICS, { peerId: peer.id }),
            },
            UI.statsRequestPeerDiagnostics,
          ),
        ]),
        h('div', { class: 'stats__grid' }, [
          row(UI.statsSending, fmtBitrate(s?.sendBps), 'stat-send'),
          row(UI.statsMicSending, micSendingLabel(s), 'stat-mic-send', micSendingTone(s)),
          row(UI.statsTheyHearYou, theyHearLabel(peer), 'stat-they-hear', theyHearTone(peer)),
          row(UI.statsReceiving, fmtBitrate(s?.recvBps), 'stat-bitrate'),
          row(UI.statsAudioReceiving, fmtBitrate(s?.audioRecvBps), 'stat-audio-recv'),
          row(UI.statsTheirMic, inboundLabel(s?.audioIn?.mic), 'stat-their-mic', inboundTone(s?.audioIn?.mic)),
          row(UI.statsTheirShare, inboundLabel(s?.audioIn?.shareAudio), 'stat-their-share'),
          row(UI.statsPlayback, playbackLabel(sink), 'stat-playback', sink?.playError ? 'danger' : null),
          row(UI.statsDirections, directionsLabel(s?.transceivers), 'stat-directions'),
          // `!= null` rather than truthiness: a genuine zero is a measurement (nothing is
          // arriving), and printing "—" for it hides the one reading that says so.
          row(
            UI.statsResolution,
            s?.recvWidth != null ? `${s.recvWidth}x${s.recvHeight}` : '—',
            'stat-resolution',
          ),
          row(UI.statsFrames, s?.recvFps != null ? `${Math.round(s.recvFps)} fps` : '—', 'stat-fps'),
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
        actions,
        h('div', { class: 'stats__grid', style: { marginBottom: 'var(--space-3)' } }, [
          row(UI.statsLimitedBy, limitedByLabel(quality.limitedBy), 'stat-limited-by'),
        ]),
        ...blocks,
      ]),
    ]);
  }

  function row(key, value, testid, tone = null) {
    return [
      h('span', { class: 'stats__key' }, key),
      h('span', { class: ['stats__val', tone && `stats__val--${tone}`], dataset: { testid } }, value ?? '—'),
    ];
  }

  /**
   * Why the far end cannot hear you, narrowed to an answer you can act on.
   *
   * Three states now, because two were not enough. **No outbound audio report** means the
   * microphone is not attached to this connection at all -- a fault. **Muted** is reported
   * from local state, because muting is `track.enabled = false` and the RTP session keeps
   * sending ~14 kbps of encoded silence. And an unmuted sender is judged by the SOUND the
   * encoder was given (`media-source.totalAudioEnergy`), not the bytes: a microphone that
   * delivers digital silence produces exactly the bitrate a working one does, and that was
   * the gap three reports of "he can't hear me" fell through.
   */
  function micSendingLabel(sample) {
    if (!sample) return '—';
    if (!sample.hasMicSender) return UI.statsMicNotSent;
    const rate = fmtBitrate(sample.micSendBps);
    if (store.state.self.micMuted) return `${rate} — ${UI.statsMicMuted}`;
    if (sample.micSpeech === true) return `${rate} · ${resolve(STATS_AUDIO.speech, { level: sample.micRms ?? sample.micAudioLevel }).en}`;
    if (sample.micSpeech === false) return `${rate} · ${STATS_AUDIO.silent.en}`;
    return rate;
  }

  function micSendingTone(sample) {
    if (!sample) return null;
    if (!sample.hasMicSender) return 'danger';
    if (store.state.self.micMuted) return 'warn';
    if (sample.micSpeech === true) return 'ok';
    if (sample.micSpeech === false) return 'danger';
    return null;
  }

  function inboundLabel(entry) {
    if (!entry) return STATS_AUDIO.unknown.en;
    const level = entry.rms ?? entry.level;
    if (entry.speech === true) return resolve(STATS_AUDIO.hearing, { level }).en;
    if (entry.speech === false) return STATS_AUDIO.quiet.en;
    return entry.bps != null ? fmtBitrate(entry.bps) : STATS_AUDIO.unknown.en;
  }

  function inboundTone(entry) {
    if (!entry) return null;
    if (entry.speech === true) return 'ok';
    return null;
  }

  function playbackLabel(sink) {
    if (!sink) return STATS_AUDIO.noElement.en;
    if (sink.playError) return resolve(STATS_AUDIO.blocked, { error: sink.playError }).en;
    if (sink.muted) return TILE.mutedForTest.en;
    if (sink.paused) return STATS_AUDIO.paused.en;
    return STATS_AUDIO.playing.en;
  }

  function directionsLabel(transceivers) {
    if (!transceivers?.length) return '—';
    return transceivers
      .map((t) => `${t.role} ${t.direction ?? '?'}/${t.currentDirection ?? '?'}`)
      .join(' · ');
  }

  function theyHearLabel(peer) {
    const line = hearLine(peer);
    if (line) return line.pair.en;
    const report = peer.hearsMe;
    if (!report || Date.now() - report.at > REPORT_STALE_MS) return STATS_AUDIO.unknown.en;
    if (store.state.self.micMuted) return UI.statsMicMuted;
    return Number.isFinite(report.level) ? `level ${report.level.toFixed(2)}` : STATS_AUDIO.unknown.en;
  }

  function theyHearTone(peer) {
    const line = hearLine(peer);
    if (!line) return null;
    return line.tone === 'ok' ? 'ok' : line.tone === 'bad' ? 'danger' : 'warn';
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

  function facts(peerId) {
    let entry = sinkFacts.get(peerId);
    if (!entry) {
      entry = { playError: null, lastEvent: null, lastEventAt: null, playAttempts: 0, tracks: [] };
      sinkFacts.set(peerId, entry);
    }
    return entry;
  }

  /**
   * Remote audio gets its own element per peer, so per-peer volume stays possible and the
   * stage video element can remain muted.
   *
   * A refused `play()` is no longer swallowed: it is the difference between "they are silent"
   * and "my browser is not playing them", and it is logged, recorded for the stats panel and
   * announced so the composition root can offer a click to fix it.
   */
  function attachRemoteAudio(peerId, track) {
    let audio = audioElements.get(peerId);
    const f = facts(peerId);
    if (!audio) {
      audio = h('audio', { autoplay: true, playsInline: true });
      audio.muted = incomingMuted;
      audio.dataset.peerId = peerId;
      audioElements.set(peerId, audio);
      el.audioSinks.append(audio);
      for (const type of ['playing', 'pause', 'stalled', 'suspend', 'error', 'waiting']) {
        audio.addEventListener(type, () => {
          f.lastEvent = type;
          f.lastEventAt = Date.now();
          if (type === 'error') logger.warn('audio: remote element error', { peerId, code: audio.error?.code ?? null });
        });
      }
    }
    const existing = audio.srcObject;
    if (existing instanceof MediaStream) existing.addTrack(track);
    else audio.srcObject = new MediaStream([track]);

    // Registered per TRACK, not per stream. A peer's microphone and their shared system audio
    // land on this one element, and a MediaStreamAudioSourceNode reads only the stream's first
    // audio track -- so a per-stream graph would drop the shared audio without a word.
    mixer.attach(peerId, track);
    audio.muted = incomingMuted || mixer.isRouted(peerId);
    audio.volume = mixer.isRouted(peerId) ? 1 : Math.min(mixer.gain(peerId), 1);
    applySinkId(audio);

    for (const type of ['mute', 'unmute', 'ended']) {
      track.addEventListener(type, () => logger.info(`audio: remote track ${type}`, { peerId, kind: track.kind, id: track.id }));
    }

    playSink(peerId, audio);
  }

  function playSink(peerId, audio) {
    const f = facts(peerId);
    f.playAttempts++;
    audio
      .play()
      .then(() => {
        if (f.playError) logger.info('audio: remote playback resumed', { peerId });
        f.playError = null;
      })
      .catch((err) => {
        const name = err?.name ?? 'play-rejected';
        f.playError = name;
        logger.warn('audio: play rejected', { peerId, name, message: err?.message });
        bus.emit(EVENTS.AUDIO_PLAYBACK_BLOCKED, { peerId, name });
      });
  }

  /** Read-only state of one peer's <audio> element, for reports and the stats panel. */
  function audioSinkState(peerId) {
    const audio = audioElements.get(peerId);
    if (!audio) return null;
    const f = facts(peerId);
    const stream = audio.srcObject instanceof MediaStream ? audio.srcObject : null;
    return {
      paused: audio.paused,
      readyState: audio.readyState,
      networkState: audio.networkState,
      muted: audio.muted,
      volume: audio.volume,
      sinkId: audio.sinkId ?? '',
      /** The Web Audio gain, 0..5. Separate from `volume` because that one is capped at 1 by
       *  the specification and would silently truncate anything a slider set above it. */
      gain: mixer.gain(peerId),
      /** 'element' | 'webaudio' -- which path this peer's sound is actually taking. */
      outputVia: mixer.isRouted(peerId) ? 'webaudio' : 'element',
      currentTime: Math.round(audio.currentTime * 10) / 10,
      playError: f.playError,
      lastEvent: f.lastEvent,
      lastEventAt: f.lastEventAt,
      playAttempts: f.playAttempts,
      tracks: (stream?.getTracks() ?? []).map((t) => ({ id: t.id, kind: t.kind, muted: t.muted, readyState: t.readyState, enabled: t.enabled })),
    };
  }

  function allSinkStates() {
    const out = {};
    for (const peerId of audioElements.keys()) out[peerId] = audioSinkState(peerId);
    return out;
  }

  /** Try every element again, inside a user gesture. */
  function resumeAllAudio() {
    for (const [peerId, audio] of audioElements) playSink(peerId, audio);
    // The graph has its own autoplay gate: a suspended AudioContext is silence that looks
    // exactly like a working one, so the same click has to reach it too.
    void mixer.resume();
    if (mixerOutput) mixerOutput.play().catch(() => {});
  }

  function setIncomingMuted(flag) {
    incomingMuted = Boolean(flag);
    for (const [peerId, audio] of audioElements) audio.muted = incomingMuted || mixer.isRouted(peerId);
    // The mixer's output is a sink too. Missing it would leave a boosted peer audible with
    // "mute incoming audio" ticked, which is exactly the confusion that switch exists to rule
    // out.
    if (mixerOutput) mixerOutput.muted = incomingMuted;
  }

  /**
   * Whether this browser can send audio to a chosen speaker at all.
   *
   * Chromium and Edge can; Firefox needs a flag and Safari has no implementation. Asked once
   * rather than assumed, because a picker that silently does nothing is worse than no picker.
   */
  function speakerSelectionSupported() {
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  }

  function applySinkId(audio) {
    if (!audio?.setSinkId || speakerDeviceId === null) return;
    audio.setSinkId(speakerDeviceId).catch((err) => {
      // A device that has been unplugged since the menu was drawn, or a permission refusal.
      // Reported rather than swallowed: "I picked my headphones and nothing moved" has to be
      // answerable from the log.
      logger.warn('audio: setSinkId failed', { name: err?.name, deviceId: speakerDeviceId });
    });
  }

  /**
   * Route every remote element -- and the mixer's output -- to one speaker.
   *
   * Applied to elements rather than to the AudioContext: `HTMLMediaElement.setSinkId` has been
   * in Chromium since 49 and works on both paths, while `AudioContext.setSinkId` arrived in 110
   * and would only cover the boosted one.
   */
  function setOutputDevice(deviceId) {
    speakerDeviceId = deviceId || null;
    for (const audio of audioElements.values()) applySinkId(audio);
    if (mixerOutput) applySinkId(mixerOutput);
    logger.info('audio: output device set', { deviceId: speakerDeviceId });
  }

  /**
   * Set one participant's playback volume, 0..5.
   *
   * Above 1 the element cannot help -- `HTMLMediaElement.volume` is clamped by the
   * specification -- so the peer moves onto the Web Audio path and their own element is muted
   * so nobody is heard twice. At or below 1, restore the original remote playback element.
   */
  function setPeerVolume(peerId, value) {
    const gain = clampGain(value);
    const routed = mixer.setGain(peerId, gain);
    const audio = audioElements.get(peerId);
    if (audio) {
      audio.muted = incomingMuted || routed;
      // Left at 1 rather than tracking the gain: while routed the element is silent anyway, and
      // if the graph could not be built (no AudioContext) this is the only volume there is.
      audio.volume = routed ? 1 : Math.min(gain, 1);
    }
    return routed;
  }

  function removePeerMedia(peerId) {
    const audio = audioElements.get(peerId);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      audioElements.delete(peerId);
    }
    sinkFacts.delete(peerId);
    mixer.detach(peerId);
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

  /**
   * `message` may be a string or a Node (a bilingual pair rendered with biNode).
   *
   * One line, always. The long form of a verdict lives behind `action` -- the Audio check
   * wizard -- because a banner that grows with its copy is a banner that eats the stage.
   *
   * `onDismiss` adds a close button. The composition root has to remember the dismissal: this
   * function is called again on the next health tick, one second later, and would otherwise
   * put back what the user just closed.
   */
  function showBanner(kind, message, action, onDismiss) {
    show(el.roomBanner, true);
    el.roomBanner.className = `banner banner--${kind}`;
    replace(el.roomBanner, [
      message instanceof Node
        ? h('span', { class: 'banner__text', dataset: { testid: 'room-banner' } }, [message])
        : h('span', { class: 'banner__text', dataset: { testid: 'room-banner' } }, message),
      action ? h('button', { class: 'btn btn--sm btn--secondary', dataset: { testid: 'room-banner-action' }, onclick: action.onClick }, action.label) : null,
      onDismiss
        ? h('button', {
            class: 'banner__close',
            type: 'button',
            title: UI.dismiss,
            'aria-label': UI.dismiss,
            dataset: { testid: 'room-banner-dismiss' },
            onclick: onDismiss,
          }, '×')
        : null,
    ]);
  }

  function hideBanner() {
    show(el.roomBanner, false);
    // Cleared as well as hidden: a stale message must not survive to be read by a screen
    // reader, a test, or the next showBanner that forgets to replace it. The empty text span
    // keeps its test id so "the banner says nothing" is observable.
    replace(el.roomBanner, [h('span', { class: 'banner__text', dataset: { testid: 'room-banner' } }, '')]);
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
    renderMicMenu();
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
    renderMicMenu();
  });
  let lastHealthCode = null;
  store.subscribe('audio', () => {
    renderMicMenu();
    renderStats();
    // The self tile's "nobody can hear you" line reads the verdict; rebuild the roster only
    // when the verdict actually changed, not on every meter or sink patch.
    const code = store.state.audio.health?.code ?? null;
    if (code !== lastHealthCode) {
      lastHealthCode = code;
      renderRoster();
    }
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

  /** `muted` here is the OS mute the lobby check saw on the track, painted in the same amber
   *  the room uses for "working but not sent". */
  function setLobbyMicLevel(level, { dead = false, muted = false } = {}) {
    paintMeter(el.lobbyMeter, level, { dead, muted });
  }

  /** @param {{severity?: 'warn'|'danger'|null}} [options]  colours the line; null is the plain hint */
  function setLobbyMicStatus(message, { severity = null } = {}) {
    if (message instanceof Node) replace(el.lobbyMicStatus, [message]);
    else text(el.lobbyMicStatus, String(message ?? ''));
    cls(el.lobbyMicStatus, 'field__hint--warn', severity === 'warn');
    cls(el.lobbyMicStatus, 'field__hint--danger', severity === 'danger');
  }

  /**
   * The in-room level, on every bar that shows it: the control-bar button (always visible),
   * the self tile, and the fullscreen overlay. The tile's bar is looked up on every call
   * because tiles are rebuilt on every 'self' emit; a cached node would go stale silently.
   */
  function setStageMicLevel(level, { dead = false } = {}) {
    lastLevel = level;
    lastDead = dead;
    const opts = { muted: store.state.self.micMuted, dead };
    paintMeter(el.ctlMeter, level, opts);
    paintMeter(el.overlayMeter, level, opts);
    const tileFill = el.rosterList.querySelector('[data-testid="tile-meter-self"]');
    if (tileFill) paintMeter(tileFill, level, opts);
  }

  /** The one-line verdict above the mic button. Null hides it. */
  function setMicHint(message, severity = null) {
    if (!message) {
      // Cleared, not just hidden. A hidden element that still reads `data-severity="warn"` and
      // still carries the old sentence is a stale assertion that anything reading the DOM --
      // a test, a screen reader, the next render -- will believe. It surfaced when the "you
      // are muted" warning stopped being replaced by an all-clear and simply went quiet.
      show(el.micHint, false);
      text(el.micHint, '');
      el.micHint.className = 'ctl__hint';
      el.micHint.dataset.severity = '';
      return;
    }
    if (message instanceof Node) replace(el.micHint, [message]);
    else text(el.micHint, message);
    el.micHint.className = `ctl__hint${severity ? ` ctl__hint--${severity}` : ''}`;
    el.micHint.dataset.severity = severity ?? '';
    show(el.micHint, true);
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
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      void toggleFullscreen();
    }
  });

  function destroy() {
    clearTimeout(overlayIdleTimer);
    clearInterval(sessionTimer);
    for (const [peerId] of audioElements) removePeerMedia(peerId);
    mixer.stop();
    if (mixerOutput) {
      mixerOutput.srcObject = null;
      mixerOutput.remove();
      mixerOutput = null;
    }
    setMicHint(null);
  }

  return {
    el,
    setLobbyMode,
    setLobbyBusy,
    showLobbyError,
    setLobbyDevices,
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
    audioSinkState,
    allSinkStates,
    resumeAllAudio,
    setIncomingMuted,
    setOutputDevice,
    setPeerVolume,
    speakerSelectionSupported,
    mixerState: () => mixer.state(),
    setLobbyMicLevel,
    setLobbyMicStatus,
    setStageMicLevel,
    setMicHint,
    toggleFullscreen,
    isFullscreen,
    renderAll() {
      renderSelfControls();
      renderShareControl();
      renderStage();
      renderRoster();
      renderQuality();
      renderStats();
      renderMicMenu();
    },
    destroy,
  };
}
