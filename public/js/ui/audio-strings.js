/**
 * Copy for the audio diagnostics, in Arabic and English.
 *
 * The people this app is for report bugs in Egyptian Arabic. Three reports of "nobody can hear
 * me" went unresolved partly because every remediation the app could offer was in English, so
 * the verdicts, the guided check and the tile lines all carry both. Arabic first, because it is
 * the language of the person reading it; English second, because it is the language of the
 * person debugging it later.
 *
 * Every entry is either a `{ar, en}` pair or a function of parameters returning one. `bi()`
 * joins a pair for single-line contexts; dialogs and banners render the two lines separately.
 */

const fmtLevel = (level) => (Number.isFinite(level) ? level.toFixed(2) : '—');

/** One line: Arabic, then English. */
export const bi = (pair) => (pair?.ar && pair?.en ? `${pair.ar} — ${pair.en}` : pair?.en || pair?.ar || '');

/** Resolve an entry that may be a function of params. */
export const resolve = (entry, params = {}) => (typeof entry === 'function' ? entry(params) : entry);

// ---------------------------------------------------------------------------
// The verdict banner (audio-health.js codes)
// ---------------------------------------------------------------------------

export const AUDIO_HEALTH = {
  MIC_ERROR: ({ errorLine }) => ({
    ar: `الميكروفون غير متاح. ${errorLine ?? ''}`.trim(),
    en: `Microphone unavailable. ${errorLine ?? ''}`.trim(),
  }),
  ENGINE_SUSPENDED: {
    ar: 'المتصفح موقّف الصوت مؤقتاً — اضغط في أي مكان على الصفحة.',
    en: 'Audio is paused by the browser — click anywhere on the page.',
  },
  TRACK_ENDED: ({ label }) => ({
    ar: `الميكروفون "${label}" اتقفل. وصّله تاني، أو اختار ميكروفون تاني من قايمة الميكروفون (▴).`,
    en: `Microphone "${label}" stopped. Reconnect it, or pick another one from the mic menu (▴).`,
  }),
  // The track's `muted` flag: Chromium mirrors the Windows endpoint mute onto it within a
  // second, so this names the mute key and the Sound page and nothing else.
  SOURCE_MUTED: ({ label }) => ({
    ar: `Windows كاتم الميكروفون "${label}". اضغط زرار كتم الميكروفون في الكيبورد (نوره بيبقى شغال وهو مكتوم) أو افتح Settings › System › Sound › Input › "${label}" وشيل الكتم.`,
    en: `Windows has muted "${label}". Press the keyboard's mic-mute key (its light is on while muted) or open Settings › System › Sound › Input › "${label}" and unmute it.`,
  }),
  // Ordered by how often each cause is the answer: the Windows mute (a keyboard key most people
  // do not know they pressed) first, the headset switch second, the wrong device last.
  CAPTURE_SILENT: ({ label, lobbyWorked }) => ({
    ar:
      `الميكروفون "${label}" مفتوح بس مفيش أي صوت بيوصل منه. لو إنت بتتكلم دلوقتي، الأول اتأكد إنه مش مكتوم في Windows: ` +
      `اضغط زرار كتم الميكروفون في الكيبورد (نوره بيبقى شغال وهو مكتوم) أو افتح Settings › System › Sound › Input › "${label}" وشيل الكتم. ` +
      `لو لسه صامت، اتأكد من زرار الكتم في السماعة، وفي الآخر اختار جهاز تاني من قايمة الميكروفون (▴).` +
      (lobbyWorked ? ' كان شغال في شاشة الدخول، يعني الميكروفون نفسه سليم وحاجة اتغيرت لما الروم فتحه تاني.' : ''),
    en:
      `Your microphone "${label}" is open but delivering silence. If you are speaking right now, first make sure it is not ` +
      `muted in Windows: press the keyboard's mic-mute key (its light is on while muted) or open Settings › System › Sound › Input › "${label}" ` +
      `and unmute it. If it is still silent, check the headset's mute switch, and only then pick another device from the mic menu (▴).` +
      (lobbyWorked ? ' It worked on the join screen, so the microphone itself is fine — something changed when the room re-opened it.' : ''),
  }),
  NOT_ATTACHED: ({ name }) => ({
    ar: `الميكروفون مش متوصّل بالاتصال مع ${name}. دي مشكلة في التطبيق — اضغط "نسخ التشخيص" وابعته.`,
    en: `Your microphone is not attached to the connection with ${name}. That is an app fault — press Copy diagnostics and report it.`,
  }),
  UNHEARD_PLAYBACK: ({ name }) => ({
    ar: `${name} بيستقبل صوتك بس جهازه مش بيشغّله. قوله يضغط في أي مكان على الصفحة عنده.`,
    en: `${name} is receiving your voice but their app is not playing it. Ask them to click anywhere on their page.`,
  }),
  UNHEARD_TRANSPORT: ({ name }) => ({
    ar: `صوتك بيخرج من جهازك بس مش بيوصل لـ ${name}. اضغطوا "نسخ التشخيص" على الجهازين.`,
    en: `Your voice leaves this machine but does not arrive at ${name}. Copy diagnostics on both sides.`,
  }),
  TALKING_WHILE_MUTED: {
    ar: 'إنت بتتكلم وإنت كاتم الميكروفون — محدش سامعك.',
    en: 'You are talking while muted — nobody can hear you.',
  },
  HEARD: ({ name, level }) => ({
    ar: `${name} سامعك (مستوى ${fmtLevel(level)}).`,
    en: `${name} can hear you (level ${fmtLevel(level)}).`,
  }),
  OK: { ar: '', en: '' },
};

/** The short line under the mic button. */
export const AUDIO_HINT = {
  MIC_ERROR: { ar: 'الميكروفون غير متاح', en: 'mic unavailable' },
  ENGINE_SUSPENDED: { ar: 'اضغط على الصفحة', en: 'click the page' },
  TRACK_ENDED: { ar: 'الميكروفون اتقفل', en: 'mic stopped' },
  SOURCE_MUTED: ({ label }) => ({
    ar: `Windows كاتم "${label}" — زرار كتم المايك / Sound › Input › شيل الكتم`,
    en: `Windows muted "${label}" — mic-mute key / Sound › Input › unmute`,
  }),
  CAPTURE_SILENT: { ar: 'مفيش صوت — اتأكد إن ويندوز مش كاتم المايك ▴', en: 'no sound — check the Windows mic mute ▴' },
  NOT_ATTACHED: { ar: 'الميكروفون مش متوصّل', en: 'mic not attached' },
  UNHEARD_PLAYBACK: { ar: 'واصل بس مش بيتشغّل عندهم', en: 'received, not playing there' },
  UNHEARD_TRANSPORT: { ar: 'صوتك مش بيوصل', en: 'your voice is not arriving' },
  TALKING_WHILE_MUTED: { ar: 'إنت كاتم الميكروفون', en: 'you are muted' },
  HEARD: ({ name }) => ({ ar: `${name} سامعك`, en: `${name} hears you` }),
  OK: { ar: '', en: '' },
};

// ---------------------------------------------------------------------------
// Roster tiles
// ---------------------------------------------------------------------------

export const TILE = {
  hearsYou: ({ level }) => ({ ar: `سامعك (${fmtLevel(level)})`, en: `can hear you (${fmtLevel(level)})` }),
  cannotHearYou: { ar: 'مش سامعك — صوتك واصله صمت', en: 'cannot hear you — your mic is silent to them' },
  notPlaying: { ar: 'واصله صوتك بس مش بيتشغّل عنده', en: 'receiving but not playing (they need to click)' },
  mutedForTest: { ar: 'كاتم الصوت الوارد للتجربة', en: 'muted incoming audio (test)' },
  nobodyHears: { ar: 'محدش سامعك لسه', en: 'Nobody can hear you yet' },
  stale: { ar: '—', en: '—' },
};

// ---------------------------------------------------------------------------
// Microphone menu
// ---------------------------------------------------------------------------

export const MIC_MENU = {
  device: { ar: 'الميكروفون', en: 'Microphone' },
  current: ({ label }) => ({ ar: `المستخدم حالياً: ${label}`, en: `In use: ${label}` }),
  systemDefault: { ar: 'الافتراضي في النظام', en: 'System default' },
  communications: { ar: 'جهاز الاتصالات الافتراضي', en: 'Default communications device' },
  processing: { ar: 'معالجة الصوت', en: 'Audio processing' },
  aec: { ar: 'إلغاء الصدى (AEC)', en: 'Echo cancellation (AEC)' },
  ns: { ar: 'تقليل الضوضاء', en: 'Noise suppression' },
  agc: { ar: 'ضبط تلقائي لمستوى الصوت', en: 'Automatic gain control' },
  processingNote: {
    ar: 'التغيير بيعيد فتح الميكروفون؛ القيم المعروضة هي اللي المتصفح طبّقها فعلاً.',
    en: 'Changing these re-opens the microphone; the values shown are what the browser actually applied.',
  },
  tests: { ar: 'اختبارات', en: 'Tests' },
  selfTest: { ar: 'سجّل 3 ثواني واسمع نفسك', en: 'Record 3 s and play it back' },
  incomingMute: { ar: 'اكتم الصوت الوارد (تجربة)', en: 'Mute incoming audio (test)' },
  incomingMuteNote: {
    ar: 'لو لسه سامع صوتك وده مفعّل، فالصوت مش جاي من التطبيق: افتح Windows Sound › Recording › الميكروفون › Listen، أو برنامج السماعة (sidetone).',
    en: "If you still hear yourself with this on, the sound is not from this app: Windows Sound › Recording › your mic › Listen tab, or your headset's sidetone.",
  },
  releaseMic: { ar: 'سيب الميكروفون 3 ثواني', en: 'Release microphone for 3 s' },
  audioCheck: { ar: 'فحص الصوت', en: 'Audio check' },
  copyDiagnostics: { ar: 'نسخ التشخيص', en: 'Copy diagnostics' },
};

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------

export const SELFTEST = {
  recording: { ar: 'بيسجّل… اتكلم دلوقتي', en: 'Recording… speak now' },
  playing: { ar: 'بيشغّل التسجيل', en: 'Playing back' },
  done: ({ peak }) => ({
    ar: `اتسجّل بأعلى مستوى ${fmtLevel(peak)} — لو سمعت نفسك، ميكروفون الروم شغال.`,
    en: `Recorded peak level ${fmtLevel(peak)} — if you heard yourself, the room microphone works.`,
  }),
  silent: { ar: 'اتسجّل صمت: الميكروفون ده مش بيوصّل أي صوت للتطبيق.', en: 'Recorded silence: this microphone delivers no sound to the app.' },
  failed: ({ error }) => ({ ar: `الاختبار فشل (${error}).`, en: `The test failed (${error}).` }),
  playbackFailed: ({ error }) => ({
    ar: `اتسجّل، بس المتصفح رفض يشغّله (${error}). اضغط على الصفحة وجرّب تاني.`,
    en: `Recorded, but the browser refused to play it (${error}). Click the page and try again.`,
  }),
  save: { ar: 'حفظ التسجيل', en: 'Save recording' },
};

// ---------------------------------------------------------------------------
// Banners and toasts
// ---------------------------------------------------------------------------

export const BANNER = {
  playbackBlocked: ({ name }) => ({
    ar: `صوت ${name} متوقف لحد ما تضغط — اضغط هنا لتشغيل الصوت.`,
    en: `Audio from ${name} is blocked until you click — click here to enable audio.`,
  }),
  enableAudio: { ar: 'تشغيل الصوت', en: 'Enable audio' },
  incomingMuted: {
    ar: 'الصوت الوارد مكتوم للتجربة — مش هتسمع حد. اقفله من قايمة الميكروفون (▴).',
    en: 'Incoming audio is muted for testing — you cannot hear anyone. Turn it off in the mic menu (▴).',
  },
  micSourceMuted: ({ label }) => ({
    ar: `Windows كتم الميكروفون "${label}" — زرار كتم المايك أو Sound › Input.`,
    en: `Windows has muted "${label}" — the mic-mute key or Sound › Input.`,
  }),
  micSwitched: ({ label }) => ({ ar: `الميكروفون دلوقتي: ${label}`, en: `Microphone now: ${label}` }),
  micSwitchFailed: { ar: 'مقدرتش أفتح الميكروفون ده.', en: 'Could not open that microphone.' },
  micReleased: { ar: 'الميكروفون اتساب 3 ثواني… لسه سامع نفسك؟', en: 'Microphone released for 3 s… still hearing yourself?' },
  micReacquired: { ar: 'الميكروفون رجع.', en: 'Microphone re-opened.' },
  diagnosticsCopied: { ar: 'اتنسخ التشخيص', en: 'Diagnostics copied' },
  diagnosticsCopyFailed: { ar: 'مقدرتش أنسخ — علّم النص وانسخه يدوي.', en: 'Could not copy — select the text and copy it manually.' },
  peerDumpRequested: ({ name }) => ({ ar: `طلبت تشخيص ${name}…`, en: `Requested ${name}'s diagnostics…` }),
  peerDumpReceived: ({ name }) => ({ ar: `وصل تشخيص ${name} — هيتضاف لنسخة التشخيص.`, en: `${name}'s diagnostics arrived — included in Copy diagnostics.` }),
  peerDumpFailed: { ar: 'مقدرتش أجيب تشخيص الطرف التاني — نسخته يدوياً من عنده.', en: "Could not fetch their diagnostics — ask them to use Copy diagnostics on their side." },
  meshAttachFailed: { ar: 'الميكروفون شغال بس مقدرتش أوصّله بالاتصال. جرّب تكتم وتفتح تاني.', en: 'The microphone works but could not be attached to the connection. Try mute and unmute.' },
};

// ---------------------------------------------------------------------------
// The guided audio check
// ---------------------------------------------------------------------------

export const AUDIO_CHECK = {
  title: { ar: 'فحص الصوت', en: 'Audio check' },
  next: { ar: 'التالي', en: 'Next' },
  back: { ar: 'رجوع', en: 'Back' },
  close: { ar: 'إغلاق', en: 'Close' },
  yes: { ar: 'أيوه', en: 'Yes' },
  no: { ar: 'لأ', en: 'No' },

  step1Title: { ar: '١ — قول أي حاجة', en: '1 — Say something' },
  step1Body: {
    ar: 'اتكلم بصوتك العادي. الشريط لازم يتحرك. تحته هتلاقي اسم الميكروفون اللي المتصفح فاتحه فعلاً.',
    en: 'Speak normally. The bar should move. Below it is the microphone the browser actually opened.',
  },
  step1Device: ({ label }) => ({ ar: `الميكروفون: ${label || 'غير معروف'}`, en: `Microphone: ${label || 'unknown'}` }),
  step1Moving: { ar: 'الشريط بيتحرك — الميكروفون ده بيوصّل صوتك.', en: 'The bar moves — this microphone delivers your voice.' },
  step1Flat: {
    ar: 'الشريط ثابت. لو إنت بتتكلم، فالميكروفون ده مش بيوصّل صوت: اختار سماعتك من القايمة تحت أو اتأكد من زرار الكتم فيها.',
    en: 'The bar is flat. If you are speaking, this microphone delivers no sound: pick your headset from the list below or check its mute switch.',
  },

  step2Title: { ar: '٢ — اكتم الميكروفون وكمّل كلام', en: '2 — Mute and keep talking' },
  step2Body: {
    ar: 'اضغط كتم، واتكلم. هل لسه سامع صوتك إنت في سماعتك؟',
    en: 'Press mute, then talk. Do you still hear your own voice in your headphones?',
  },
  step2Proof: ({ enabled, sinks }) => ({
    ar: `دليل: track.enabled=${enabled} · عدد عناصر الصوت اللي فيها ميكروفونك: 0 · عناصر الصوت الوارد: ${sinks}`,
    en: `Proof: track.enabled=${enabled} · audio elements carrying your mic: 0 · incoming audio elements: ${sinks}`,
  }),
  step2Yes: {
    ar:
      'الصوت ده مش جاي من التطبيق: التطبيق مش بيبعت أي حاجة وإنت كاتم، ومش بيشغّل ميكروفونك في سماعتك أبداً. ' +
      'ده إما "Listen to this device" في Windows، أو sidetone في السماعة/برنامجها، أو "Input monitoring" في Realtek. ' +
      'الحل: Control Panel › Sound › Recording › الميكروفون › Properties › Listen › شيل علامة "Listen to this device"، ' +
      'وافتح برنامج السماعة وقفّل Sidetone / Mic monitoring. للتأكيد: اقفل التطبيق خالص — الصوت هيفضل موجود.',
    en:
      'That sound is not coming from this app: it sends nothing while muted, and it never plays your microphone to you. ' +
      "It is Windows 'Listen to this device', your headset's sidetone (in its software), or Realtek 'Input monitoring'. " +
      "Fix: Control Panel › Sound › Recording › your mic › Properties › Listen › untick 'Listen to this device', and turn off " +
      'Sidetone / Mic monitoring in the headset app. To confirm: close this app entirely — the voice will persist.',
  },
  step2No: ({ name }) => ({
    ar:
      `يبقى بيحصل بس وإنت فاتح الميكروفون، يعني الصوت راجع من ناحية ${name}. ` +
      'لو هو بيشير سكرين من تطبيق الديسكتوب، صوت النظام عنده فيه صوتك — قوله يشيل علامة "Share system audio"، أو استخدموا سماعات.',
    en:
      `Then it only happens while you are unmuted: it is coming back from ${name}'s side. ` +
      "If they share their screen from the desktop app, their system audio includes your voice — ask them to untick 'Share system audio', or both use headphones.",
  }),
  step2Release: { ar: 'اختبار إضافي: سيب الميكروفون 3 ثواني', en: 'Extra test: release the microphone for 3 s' },
  step2ReleaseNote: {
    ar: 'لو الصوت اختفى وإنت سايب الميكروفون ورجع لما اتفتح تاني، فده sidetone بيشتغل لما أي برنامج يفتح الميكروفون (سماعات بلوتوث/USB).',
    en: 'If the voice disappears while the mic is released and returns when it re-opens, it is sidetone that engages whenever an app opens the mic (Bluetooth/USB headsets).',
  },

  step3Title: { ar: '٣ — افتح الميكروفون واتكلم 5 ثواني', en: '3 — Unmute and talk for five seconds' },
  step3Body: {
    ar: 'هنا بنقيس الصوت اللي بيخرج فعلاً من جهازك، مش مجرد البايتات.',
    en: 'This measures the sound actually leaving your machine, not just bytes.',
  },
  step3Sending: ({ status }) => ({ ar: `الإرسال: ${status}`, en: `Sending: ${status}` }),
  step3Hears: ({ name, status }) => ({ ar: `${name}: ${status}`, en: `${name}: ${status}` }),

  step4Title: { ar: '٤ — خلّي الطرف التاني يتكلم', en: '4 — Ask the other person to talk' },
  step4Body: ({ name }) => ({
    ar: `اطلب من ${name} يتكلم. تحت: مستوى الصوت اللي بيوصلك منه، وحالة تشغيله على جهازك.`,
    en: `Ask ${name} to speak. Below: the level arriving from them, and whether your app is playing it.`,
  }),

  summaryTitle: { ar: 'الخلاصة', en: 'Summary' },
  summaryNone: { ar: 'مفيش مشكلة واضحة من الجهاز ده.', en: 'No obvious problem on this machine.' },
  copy: { ar: 'نسخ التشخيص', en: 'Copy diagnostics' },
  noPeers: { ar: 'مفيش حد تاني في الروم لسه.', en: 'Nobody else is in the room yet.' },
};

// ---------------------------------------------------------------------------
// Stats panel audio rows (values; the row keys stay English in strings.js)
// ---------------------------------------------------------------------------

export const STATS_AUDIO = {
  speech: ({ level }) => ({ ar: `فيه كلام · مستوى ${fmtLevel(level)}`, en: `speech detected · level ${fmtLevel(level)}` }),
  silent: { ar: 'صمت (الميكروفون مفتوح بس مفيش صوت)', en: 'SILENT (mic open, no sound)' },
  hearing: ({ level }) => ({ ar: `سامعه (${fmtLevel(level)})`, en: `hearing them (${fmtLevel(level)})` }),
  quiet: { ar: 'صمت', en: 'silent' },
  unknown: { ar: '—', en: '—' },
  playing: { ar: 'بيتشغّل', en: 'playing' },
  blocked: ({ error }) => ({ ar: `متوقف (${error})`, en: `blocked (${error})` }),
  paused: { ar: 'متوقف مؤقتاً', en: 'paused' },
  noElement: { ar: 'مفيش عنصر صوت', en: 'no audio element' },
};

export const LOBBY = {
  hearingDevice: ({ label }) => ({ ar: `الميكروفون شغال — "${label}"`, en: `Microphone is working — "${label}"` }),
  quietDevice: ({ label }) => ({
    ar: `الميكروفون مفتوح ("${label}"). قول أي حاجة عشان الشريط يتحرك — لو ما اتحركش، اختار ميكروفون تاني تحت.`,
    en: `Microphone is on ("${label}"). Say something to see the bar move — if it does not, pick another microphone below.`,
  }),
  /** The endpoint is muted in Windows: the track's `muted` flag says so (Chromium mirrors the
   *  OS mute onto it within a second), so this is certain, immediate, and clears by itself. */
  osMutedDevice: ({ label }) => {
    const ar = label ? `"${label}"` : 'الميكروفون';
    const en = label ? `"${label}"` : 'the microphone';
    return {
      ar:
        `Windows كاتم ${ar}. اضغط زرار كتم الميكروفون في صف F في الكيبورد (نوره بيبقى شغال وهو مكتوم؛ F9 في لابتوبات ASUS) ` +
        `أو افتح Settings › System › Sound › Input › ${ar} وشيل الكتم — الشريط هيتحرك لوحده أول ما يتفتح.`,
      en:
        `Windows has muted ${en} — press the microphone-mute key in the F row (its light is on while muted; F9 on ASUS laptops) ` +
        `or open Settings › System › Sound › Input › ${en} and unmute it; the bar starts moving by itself the moment it is unmuted.`,
    };
  },
  /** Six seconds of nothing from a live device whose `muted` flag is FALSE. The endpoint mute
   *  Chromium can see is `osMutedDevice` above; this is the fallback for a capture that delivers
   *  real near-zero samples anyway (an APO or hardware-gated mute, a headset switch), which by
   *  signal alone reads like a quiet room. The Windows mute is still named first because a
   *  mute the driver applies below the endpoint is the usual cause of that signature. */
  silentDevice: ({ label }) => {
    const ar = label ? `"${label}"` : 'الميكروفون';
    const en = label ? `"${label}"` : 'the microphone';
    return {
      ar:
        `مفيش أي صوت وصل للتطبيق من ${ar} من 6 ثواني. غالباً الميكروفون مكتوم في Windows: اضغط زرار كتم الميكروفون في الكيبورد ` +
        `(في صف F، عليه علامة ميكروفون، ونوره بيبقى شغال وهو مكتوم) أو افتح Settings › System › Sound › Input › ${ar} ` +
        `وشيل الكتم / علّي الصوت، وبعدين اتكلم تاني. لو ده ما نفعش بس، اختار ميكروفون تاني تحت.`,
      en:
        `No sound has reached the app from ${en} for 6 seconds. Most often the microphone is muted in Windows: press the keyboard's ` +
        `mic-mute key (an F-row key with a microphone icon; its light is on while muted) or open Settings › System › Sound › Input › ${en} ` +
        `and unmute it / raise its volume, then talk again. Only if that does not help, pick another microphone below.`,
    };
  },
};
