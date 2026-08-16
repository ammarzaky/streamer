/**
 * A synthetic screen-capture stream, used only under the E2E harness.
 *
 * Automating the operating system's screen picker is a losing game: it is locale-dependent,
 * needs a real desktop session, and behaves differently in headless Chromium. So the tests
 * substitute this canvas for the picker and leave everything else real -- the encoder, RTP,
 * DTLS-SRTP, ICE, the jitter buffer, the decoder, and the <video> element are all the actual
 * implementation. The only thing skipped is the picker, which is UX rather than WebRTC.
 *
 * It renders at 1920x1080@60 to match the default preset, so tests can assert the real
 * default rather than a scaled-down stand-in.
 *
 * This module is imported unconditionally but only *called* when window.__E2E__ is set, which
 * the server injects and only when started with STREAMER_E2E=1.
 */

export function makeSyntheticDisplayStream({ width = 1920, height = 1080, fps = 60 } = {}) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { alpha: false });

  let frame = 0;
  let running = true;

  function draw() {
    if (!running) return;
    frame++;

    // A shifting background plus a moving block. The motion matters: a static canvas encodes
    // to almost nothing, and every bitrate assertion in the suite would pass trivially while
    // proving nothing about the encoder.
    ctx.fillStyle = `hsl(${frame % 360} 70% 35%)`;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#000';
    const x = (frame * 11) % Math.max(1, width - 300);
    ctx.fillRect(x, height / 3, 300, 300);

    // A visible frame counter, so a receiver can prove frames are actually advancing rather
    // than a single frame being held.
    ctx.fillStyle = '#fff';
    ctx.font = '96px monospace';
    ctx.fillText(String(frame), 60, height - 80);

    requestAnimationFrame(draw);
  }
  draw();

  const stream = canvas.captureStream(fps);

  // A stand-in for shared system audio, so tests can tell the display-audio sender apart from
  // the microphone -- the distinction the mute behaviour depends on.
  try {
    const audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const destination = audioCtx.createMediaStreamDestination();

    oscillator.frequency.value = 440;
    gain.gain.value = 0.05; // audible to the decoder, not painful if anything plays it
    oscillator.connect(gain).connect(destination);
    oscillator.start();

    const [audioTrack] = destination.stream.getAudioTracks();
    if (audioTrack) stream.addTrack(audioTrack);
  } catch {
    // Audio is optional here; a video-only synthetic stream still exercises the whole path.
  }

  // Make the stream stoppable the same way a real capture is, so stopShare() behaves
  // identically under test.
  const originalStop = MediaStreamTrack.prototype.stop;
  for (const track of stream.getTracks()) {
    track.stop = function stop() {
      running = false;
      originalStop.call(this);
    };
  }

  return stream;
}
