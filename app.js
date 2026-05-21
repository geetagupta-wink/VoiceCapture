// ═══════════════════════════════════════════════════════════════════════════
//  Voice Capture — app.js
//  Architecture:
//    • fullRecorder  → captures everything (raw stream) → playback only
//    • voiceRecorder → starts/stops per VAD frame       → sent to backend
//  Cough / noise frames never open voiceRecorder, so the clean blob
//  contains pure speech only.
// ═══════════════════════════════════════════════════════════════════════════

// ── Config ─────────────────────────────────────────────────────────────────
const CONFIG = {
  maxSessionTime : 15,
  minVoiceTarget : 10,
};

const SAMPLE_TEXT =
  "The quick brown fox jumped over the lazy dog near the riverbank. " +
  "Artificial intelligence systems are transforming how we interact with technology every single day. " +
  "Please speak this passage clearly and at a natural pace for the best recording quality.";

// ── DSP thresholds ─────────────────────────────────────────────────────────
const SILENCE_RMS        = 0.005;
const VOICE_RMS          = 0.018;
const FAN_RMS_MAX        = 0.025;
const FAN_ZCR_MIN        = 0.28;
const NOISE_ZCR          = 0.35;

const COUGH_RMS_MIN      = 0.12;
const COUGH_ZCR_MAX      = 0.55;
const COUGH_ZCR_MIN      = 0.18;
const COUGH_BURST_MS     = 350;
const COUGH_COOLDOWN_MS  = 800;

// How many consecutive voice frames before opening the voice recorder
// (avoids tiny spurious blips being recorded)
const VOICE_OPEN_FRAMES  = 3;
// How many consecutive non-voice frames before closing the voice recorder
// (provides a short tail so words don't get clipped)
const VOICE_CLOSE_FRAMES = 8;

// ── State ──────────────────────────────────────────────────────────────────
let fullRecorder      = null;   // records everything → playback blob
let voiceRecorder     = null;   // records only during voice frames → send blob
let voiceStream       = null;   // MediaStream piped into voiceRecorder
let voiceDest         = null;   // MediaStreamAudioDestinationNode
let audioCtx          = null;
let analyser          = null;
let freqAnalyser      = null;
let animId            = null;
let stream            = null;

let recording         = false;
let startTime         = 0;
let sessionElapsed    = 0;
let voiceCollected    = 0;
let lastTick          = 0;

let fullChunks        = [];     // raw audio for playback
let voiceChunks       = [];     // clean voice-only audio for backend
let voiceRecOpen      = false;  // is voiceRecorder currently running?
let voiceOpenCounter  = 0;      // consecutive voice frames seen
let voiceCloseCounter = 0;      // consecutive non-voice frames seen

let segments          = [];
let currentSegType    = "silent";
let wordIndex         = 0;
let wordTimer         = null;
let playbackBlob      = null;
let cleanBlob         = null;   // voice-only blob sent to backend

// Cough state
let coughBurstStart   = 0;
let coughCooldownEnd  = 0;
let inCoughBurst      = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
const readTextEl     = document.getElementById("readText");
const recBtn         = document.getElementById("recBtn");
const resetBtn       = document.getElementById("resetBtn");
const sendBtn        = document.getElementById("sendBtn");
const playBtn        = document.getElementById("playBtn");
const audioPlayer    = document.getElementById("audioPlayer");
const statusPill     = document.getElementById("statusPill");
const statusDot      = document.getElementById("statusDot");
const statusText     = document.getElementById("statusText");
const vadBadge       = document.getElementById("vadBadge");
const voiceVal       = document.getElementById("voiceVal");
const voiceFill      = document.getElementById("voiceFill");
const timeVal        = document.getElementById("timeVal");
const timeFill       = document.getElementById("timeFill");
const rmsVal         = document.getElementById("rmsVal");
const noiseVal       = document.getElementById("noiseVal");
const zcrVal         = document.getElementById("zcrVal");
const alertBox       = document.getElementById("alertBox");
const alertMsg       = document.getElementById("alertMsg");
const segmentsRow    = document.getElementById("segmentsRow");
const canvas         = document.getElementById("waveCanvas");
const ctx2d          = canvas.getContext("2d");
const cfgMaxTime     = document.getElementById("cfgMaxTime");
const cfgMinVoice    = document.getElementById("cfgMinVoice");
const cfgMaxTimeVal  = document.getElementById("cfgMaxTimeVal");
const cfgMinVoiceVal = document.getElementById("cfgMinVoiceVal");
const applyConfigBtn = document.getElementById("applyConfigBtn");
const playerSection  = document.getElementById("playerSection");
const playbackTime   = document.getElementById("playbackTime");
const cleanSizeEl    = document.getElementById("cleanSize");
const cleanDurEl     = document.getElementById("cleanDur");

// ── Config sliders ─────────────────────────────────────────────────────────
cfgMaxTime.value           = CONFIG.maxSessionTime;
cfgMinVoice.value          = CONFIG.minVoiceTarget;
cfgMaxTimeVal.textContent  = CONFIG.maxSessionTime + "s";
cfgMinVoiceVal.textContent = CONFIG.minVoiceTarget + "s";

cfgMaxTime.addEventListener("input", () => {
  const v = parseInt(cfgMaxTime.value);
  cfgMaxTimeVal.textContent = v + "s";
  if (parseInt(cfgMinVoice.value) >= v) {
    cfgMinVoice.value = v - 1;
    cfgMinVoiceVal.textContent = (v - 1) + "s";
  }
  cfgMinVoice.max = v - 1;
});
cfgMinVoice.addEventListener("input", () => {
  cfgMinVoiceVal.textContent = cfgMinVoice.value + "s";
});
applyConfigBtn.addEventListener("click", () => {
  CONFIG.maxSessionTime = parseInt(cfgMaxTime.value);
  CONFIG.minVoiceTarget = parseInt(cfgMinVoice.value);
  showAlert("info", `Config applied — session max: ${CONFIG.maxSessionTime}s, voice target: ${CONFIG.minVoiceTarget}s`);
  setTimeout(hideAlert, 2500);
});

// ── Word spans ─────────────────────────────────────────────────────────────
const words = SAMPLE_TEXT.split(" ");
readTextEl.innerHTML = words.map((w, i) => `<span class="word" data-idx="${i}">${w} </span>`).join("");

// ── UI helpers ─────────────────────────────────────────────────────────────
function setStatus(type, txt) {
  statusPill.className = "status-pill";
  statusDot.className  = "dot";
  if (type === "recording") { statusPill.classList.add("active"); statusDot.classList.add("pulse"); }
  else if (type === "warn")   statusPill.classList.add("warn-state");
  else if (type === "error")  statusPill.classList.add("error-state");
  statusText.textContent = txt;
}
function showAlert(type, msg) { alertBox.className = `alert-box ${type}`; alertMsg.textContent = msg; }
function hideAlert()           { alertBox.className = "alert-box hidden"; }

// ── Segment timeline ───────────────────────────────────────────────────────
function initSegments() {
  segmentsRow.innerHTML = "";
  segments = [];
  for (let i = 0; i < 60; i++) {
    const bar = document.createElement("div");
    bar.className = "seg-bar silent-seg";
    bar.style.height = "3px";
    segmentsRow.appendChild(bar);
    segments.push({ el: bar, type: "silent" });
  }
}
initSegments();

function updateSegmentBar(elapsed, type) {
  const idx = Math.min(Math.floor((elapsed / CONFIG.maxSessionTime) * 60), 59);
  const bar = segments[idx];
  if (!bar) return;
  bar.type = type;
  bar.el.className = "seg-bar";
  const h = type === "voice" ? 18 : type === "cough" ? 14 : type === "noise" ? 9 : 3;
  bar.el.style.height = h + "px";
  bar.el.classList.add(
    type === "voice" ? "voice-seg" : type === "cough" ? "cough-seg" :
    type === "noise" ? "noise-seg" : "silent-seg"
  );
}

// ── DSP ────────────────────────────────────────────────────────────────────
function computeRMS(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / data.length);
}

function computeZCR(data) {
  let c = 0;
  for (let i = 1; i < data.length; i++) {
    const p = data[i-1] - 128, n = data[i] - 128;
    if ((p > 0 && n <= 0) || (p <= 0 && n > 0)) c++;
  }
  return c / data.length;
}

function computeSpectralCentroid(freqData) {
  let ws = 0, tm = 0;
  for (let i = 0; i < freqData.length; i++) {
    const m = freqData[i] / 255;
    ws += i * m; tm += m;
  }
  return tm > 0 ? ws / (freqData.length * tm) : 0;
}

function classifyFrame(rms, zcr, sc, nowMs) {
  if (rms < SILENCE_RMS) { inCoughBurst = false; return "silent"; }
  if (rms < FAN_RMS_MAX && zcr > FAN_ZCR_MIN) return "noise";
  if (zcr > NOISE_ZCR && sc > 0.4) return "noise";
  if (rms < VOICE_RMS) return "silent";

  const coughCandidate =
    rms >= COUGH_RMS_MIN && zcr >= COUGH_ZCR_MIN && zcr <= COUGH_ZCR_MAX &&
    sc >= 0.12 && sc <= 0.45;

  if (coughCandidate) {
    if (!inCoughBurst) { inCoughBurst = true; coughBurstStart = nowMs; }
    if (nowMs - coughBurstStart <= COUGH_BURST_MS) {
      coughCooldownEnd = nowMs + COUGH_COOLDOWN_MS;
      return "cough";
    }
    inCoughBurst = false;
  } else {
    inCoughBurst = false;
  }

  if (nowMs < coughCooldownEnd) return "cough";
  return "voice";
}

// ── Voice recorder gate ────────────────────────────────────────────────────
// Opens/closes voiceRecorder based on VAD output with hysteresis to avoid
// micro-starts and clipped words at boundaries.

function openVoiceRecorder() {
  if (voiceRecOpen || !voiceDest) return;
  voiceRecorder = new MediaRecorder(voiceDest.stream);
  voiceRecorder.ondataavailable = e => { if (e.data.size > 0) voiceChunks.push(e.data); };
  voiceRecorder.start(50);
  voiceRecOpen = true;
}

function closeVoiceRecorder() {
  if (!voiceRecOpen || !voiceRecorder) return;
  if (voiceRecorder.state !== "inactive") voiceRecorder.stop();
  voiceRecOpen = false;
}

function gateVoiceRecorder(isVoice) {
  if (isVoice) {
    voiceCloseCounter = 0;
    voiceOpenCounter++;
    if (voiceOpenCounter >= VOICE_OPEN_FRAMES) openVoiceRecorder();
  } else {
    voiceOpenCounter = 0;
    if (voiceRecOpen) {
      voiceCloseCounter++;
      if (voiceCloseCounter >= VOICE_CLOSE_FRAMES) closeVoiceRecorder();
    }
  }
}

// ── Word highlighter ───────────────────────────────────────────────────────
function advanceWord() {
  const els = readTextEl.querySelectorAll(".word");
  if (wordIndex > 0 && wordIndex - 1 < els.length) {
    els[wordIndex-1].classList.remove("current"); els[wordIndex-1].classList.add("done");
  }
  if (wordIndex < els.length) {
    els[wordIndex].classList.add("current");
    els[wordIndex].scrollIntoView({ behavior: "smooth", block: "nearest" });
    wordIndex++;
  }
}

// ── Waveform ───────────────────────────────────────────────────────────────
function drawWave(data) {
  const W = canvas.width, H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);
  const sw = W / data.length;
  let x = 0;
  ctx2d.beginPath();
  ctx2d.strokeStyle =
    currentSegType === "voice" ? "#3ecf8e" :
    currentSegType === "cough" ? "#c084fc" :
    currentSegType === "noise" ? "#f5a623" : "#3a4155";
  ctx2d.lineWidth = 1.5;
  for (let i = 0; i < data.length; i++) {
    const y = H/2 + ((data[i]-128)/128) * (H/2.5);
    i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    x += sw;
  }
  ctx2d.stroke();
}

// ── DOM refs — player elements ─────────────────────────────────────────────
const cleanPlayer      = document.getElementById("cleanPlayer");
const cleanPlayBtn     = document.getElementById("cleanPlayBtn");
const cleanScrubber    = document.getElementById("cleanScrubber");
const cleanPlaybackTime= document.getElementById("cleanPlaybackTime");
const cleanDownloadBtn = document.getElementById("cleanDownloadBtn");
const fullDownloadBtn  = document.getElementById("fullDownloadBtn");

// ── Playback setup ─────────────────────────────────────────────────────────
function setupPlayback() {
  if (!fullChunks.length) return;

  // ── Full recording → raw player ──────────────────────────────────────────
  playbackBlob = new Blob(fullChunks, { type: "audio/webm" });
  audioPlayer.src = URL.createObjectURL(playbackBlob);

  fullDownloadBtn.onclick = () => {
    const a = document.createElement("a");
    a.href     = audioPlayer.src;
    a.download = "recording_full.webm";
    a.click();
  };

  audioPlayer.addEventListener("timeupdate", () => {
    const c = audioPlayer.currentTime.toFixed(1);
    const d = isNaN(audioPlayer.duration) ? "?" : audioPlayer.duration.toFixed(1);
    playbackTime.textContent = c + "s / " + d + "s";
  });
  audioPlayer.addEventListener("loadedmetadata", () => { scrubberFull.value = 0; });
  audioPlayer.addEventListener("play",  () => { playBtn.innerHTML = '<i class="ti ti-player-pause"></i> Pause'; playBtn.classList.add("playing"); });
  audioPlayer.addEventListener("pause", () => { playBtn.innerHTML = '<i class="ti ti-player-play"></i> Play back'; playBtn.classList.remove("playing"); });
  audioPlayer.addEventListener("ended", () => { playBtn.innerHTML = '<i class="ti ti-player-play"></i> Play back'; playBtn.classList.remove("playing"); });

  // ── Clean voice-only → clean player ─────────────────────────────────────
  if (voiceChunks.length) {
    cleanBlob = new Blob(voiceChunks, { type: "audio/webm" });
    cleanSizeEl.textContent = (cleanBlob.size / 1024).toFixed(1) + " KB";
    cleanDurEl.textContent  = voiceCollected.toFixed(1) + "s";

    const cleanUrl = URL.createObjectURL(cleanBlob);
    cleanPlayer.src = cleanUrl;

    cleanDownloadBtn.onclick = () => {
      const a = document.createElement("a");
      a.href     = cleanUrl;
      a.download = "voice_clean.webm";
      a.click();
    };

    cleanPlayer.addEventListener("timeupdate", () => {
      const c = cleanPlayer.currentTime.toFixed(1);
      const d = isNaN(cleanPlayer.duration) ? "?" : cleanPlayer.duration.toFixed(1);
      cleanPlaybackTime.textContent = c + "s / " + d + "s";
      if (!isNaN(cleanPlayer.duration) && cleanPlayer.duration > 0)
        cleanScrubber.value = (cleanPlayer.currentTime / cleanPlayer.duration) * 100;
    });
    cleanPlayer.addEventListener("loadedmetadata", () => { cleanScrubber.value = 0; });
    cleanPlayer.addEventListener("play",  () => { cleanPlayBtn.innerHTML = '<i class="ti ti-player-pause"></i> Pause'; cleanPlayBtn.classList.add("playing"); });
    cleanPlayer.addEventListener("pause", () => { cleanPlayBtn.innerHTML = '<i class="ti ti-player-play"></i> Play clean'; cleanPlayBtn.classList.remove("playing"); });
    cleanPlayer.addEventListener("ended", () => { cleanPlayBtn.innerHTML = '<i class="ti ti-player-play"></i> Play clean'; cleanPlayBtn.classList.remove("playing"); });

    cleanScrubber.addEventListener("input", () => {
      if (!isNaN(cleanPlayer.duration))
        cleanPlayer.currentTime = (cleanScrubber.value / 100) * cleanPlayer.duration;
    });
  }

  playerSection.classList.remove("hidden");
}

playBtn.addEventListener("click", () => {
  if (!audioPlayer.src) return;
  audioPlayer.paused ? audioPlayer.play() : audioPlayer.pause();
});

cleanPlayBtn.addEventListener("click", () => {
  if (!cleanPlayer.src) return;
  cleanPlayer.paused ? cleanPlayer.play() : cleanPlayer.pause();
});

// ── Main tick ──────────────────────────────────────────────────────────────
const freqBuf = new Uint8Array(512);

function tick() {
  if (!recording) return;
  const now = performance.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;
  sessionElapsed = Math.min((now - startTime) / 1000, CONFIG.maxSessionTime);

  const timeBuf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(timeBuf);
  freqAnalyser.getByteFrequencyData(freqBuf);

  const rms  = computeRMS(timeBuf);
  const zcr  = computeZCR(timeBuf);
  const sc   = computeSpectralCentroid(freqBuf);
  const type = classifyFrame(rms, zcr, sc, now);
  currentSegType = type;

  // Gate the clean recorder
  gateVoiceRecorder(type === "voice");

  if (type === "voice") voiceCollected = Math.min(voiceCollected + dt, CONFIG.minVoiceTarget);

  updateSegmentBar(sessionElapsed, type);

  const voicePct = Math.min((voiceCollected / CONFIG.minVoiceTarget) * 100, 100);
  const timePct  = (sessionElapsed / CONFIG.maxSessionTime) * 100;

  voiceVal.textContent  = voiceCollected.toFixed(1) + "s / " + CONFIG.minVoiceTarget + "s";
  voiceFill.style.width = voicePct.toFixed(1) + "%";
  timeVal.textContent   = sessionElapsed.toFixed(1) + "s / " + CONFIG.maxSessionTime + "s";
  timeFill.style.width  = timePct.toFixed(1) + "%";

  timeFill.className = "fill fill-time";
  if (timePct > 80) timeFill.classList.add("crit");
  else if (timePct > 60) timeFill.classList.add("warn");

  rmsVal.textContent = rms.toFixed(3);
  rmsVal.className   = "metric-val " + (rms > VOICE_RMS ? "good" : rms > SILENCE_RMS ? "warn" : "");

  const totalActive = segments.filter(s => s.type !== "silent").length || 1;
  const rejectRatio = segments.filter(s => s.type === "noise" || s.type === "cough").length / totalActive;
  noiseVal.textContent = (rejectRatio * 100).toFixed(0) + "%";
  noiseVal.className   = "metric-val " + (rejectRatio < 0.2 ? "good" : rejectRatio < 0.5 ? "warn" : "bad");

  zcrVal.textContent = zcr.toFixed(3);
  zcrVal.className   = "metric-val " + (zcr < NOISE_ZCR ? "good" : "warn");

  vadBadge.className = "vad-badge";
  if      (type === "voice") { vadBadge.classList.add("voice"); vadBadge.textContent = "✦ voice"; }
  else if (type === "cough") { vadBadge.classList.add("cough"); vadBadge.textContent = "⚠ cough"; }
  else if (type === "noise") { vadBadge.classList.add("noise"); vadBadge.textContent = "⚡ noise"; }
  else                       {                                   vadBadge.textContent = "— silent"; }

  if (type === "cough")
    showAlert("warn", "Cough detected — excluded from clean audio.");
  else if (type === "noise")
    showAlert("warn", "Background noise detected — move away from fans or AC units.");
  else if (type === "silent" && sessionElapsed > 2)
    showAlert("info", "No voice detected. Speak clearly into your microphone.");
  else
    hideAlert();

  drawWave(timeBuf);

  if (voiceCollected >= CONFIG.minVoiceTarget) { stopRecording(true);  return; }
  if (sessionElapsed >= CONFIG.maxSessionTime) { stopRecording(false); return; }

  animId = requestAnimationFrame(tick);
}

// ── Start recording ────────────────────────────────────────────────────────
async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      video: false
    });
  } catch (e) {
    showAlert("error", "Microphone access denied. Please allow microphone permission.");
    setStatus("error", "No mic"); return;
  }

  audioCtx     = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  analyser     = audioCtx.createAnalyser();
  freqAnalyser = audioCtx.createAnalyser();
  analyser.fftSize     = 1024; analyser.smoothingTimeConstant     = 0.4;
  freqAnalyser.fftSize = 1024; freqAnalyser.smoothingTimeConstant = 0.3;

  // MediaStreamAudioDestinationNode — the VAD-gated clean stream
  voiceDest = audioCtx.createMediaStreamAudioDestinationNode();

  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(analyser);
  src.connect(freqAnalyser);
  src.connect(voiceDest);   // also feeds the clean destination

  // Full recorder — captures everything for playback
  fullChunks   = [];
  fullRecorder = new MediaRecorder(stream);
  fullRecorder.ondataavailable = e => { if (e.data.size > 0) fullChunks.push(e.data); };
  fullRecorder.start(100);

  // Voice recorder initialised but NOT started yet — gateVoiceRecorder() opens it
  voiceChunks  = [];
  voiceRecOpen = false;
  voiceOpenCounter  = 0;
  voiceCloseCounter = 0;

  cleanBlob    = null;
  playbackBlob = null;
  playerSection.classList.add("hidden");
  audioPlayer.src = ""; cleanPlayer.src = "";
  playBtn.innerHTML = '<i class="ti ti-player-play"></i> Play back';
  playBtn.classList.remove("playing");
  cleanPlayBtn.innerHTML = '<i class="ti ti-player-play"></i> Play clean';
  cleanPlayBtn.classList.remove("playing");
  cleanSizeEl.textContent = "—";
  cleanDurEl.textContent  = "—";

  canvas.width  = (canvas.offsetWidth  || 640) * window.devicePixelRatio;
  canvas.height = (canvas.offsetHeight || 84)  * window.devicePixelRatio;

  recording        = true;
  startTime        = performance.now();
  lastTick         = startTime;
  voiceCollected   = 0;
  sessionElapsed   = 0;
  wordIndex        = 0;
  inCoughBurst     = false;
  coughCooldownEnd = 0;

  initSegments();
  readTextEl.querySelectorAll(".word").forEach(w => w.classList.remove("current", "done"));

  recBtn.innerHTML  = '<i class="ti ti-player-stop-filled"></i> Stop Recording';
  recBtn.classList.add("recording");
  resetBtn.disabled = false;
  sendBtn.disabled  = true;
  setStatus("recording", "Recording…");
  hideAlert();

  wordTimer = setInterval(() => { if (currentSegType === "voice") advanceWord(); }, 600);
  animId = requestAnimationFrame(tick);
}

// ── Stop recording ─────────────────────────────────────────────────────────
function stopRecording(success) {
  if (!recording) return;
  recording = false;
  cancelAnimationFrame(animId);
  clearInterval(wordTimer);

  // Close the voice gate recorder first so its chunks are flushed
  closeVoiceRecorder();

  const finalize = () => setupPlayback();

  if (fullRecorder && fullRecorder.state !== "inactive") {
    fullRecorder.stop();
    setTimeout(finalize, 300);
  } else {
    finalize();
  }

  stream && stream.getTracks().forEach(t => t.stop());
  audioCtx && audioCtx.close();

  recBtn.innerHTML = '<i class="ti ti-microphone"></i> Start Recording';
  recBtn.classList.remove("recording");
  recBtn.disabled = false;

  if (success) {
    setStatus("", "Complete ✓");
    showAlert("success", `Complete — ${voiceCollected.toFixed(1)}s of clean speech captured. Coughs & noise excluded.`);
    sendBtn.disabled = false;
  } else {
    setStatus("error", "Incomplete");
    showAlert("error", `Only ${voiceCollected.toFixed(1)}s of clean voice (need ${CONFIG.minVoiceTarget}s). Try again.`);
    sendBtn.disabled = voiceChunks.length === 0;
  }
}

// ── Reset ──────────────────────────────────────────────────────────────────
function resetAll() {
  stopRecording(false);
  voiceCollected = sessionElapsed = wordIndex = 0;
  inCoughBurst = false; coughCooldownEnd = 0;
  voiceOpenCounter = voiceCloseCounter = 0;
  initSegments();
  voiceVal.textContent  = "0.0s / " + CONFIG.minVoiceTarget + "s";
  voiceFill.style.width = "0%";
  timeVal.textContent   = "0.0s / " + CONFIG.maxSessionTime + "s";
  timeFill.style.width  = "0%";
  rmsVal.textContent = "—"; rmsVal.className = "metric-val";
  noiseVal.textContent = "—"; noiseVal.className = "metric-val";
  zcrVal.textContent = "—"; zcrVal.className = "metric-val";
  vadBadge.className = "vad-badge"; vadBadge.textContent = "— silent";
  readTextEl.querySelectorAll(".word").forEach(w => w.classList.remove("current", "done"));
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  fullChunks = []; voiceChunks = [];
  cleanBlob = null; playbackBlob = null;
  playerSection.classList.add("hidden");
  audioPlayer.src = ""; cleanPlayer.src = "";
  playBtn.innerHTML = '<i class="ti ti-player-play"></i> Play back';
  playBtn.classList.remove("playing");
  cleanPlayBtn.innerHTML = '<i class="ti ti-player-play"></i> Play clean';
  cleanPlayBtn.classList.remove("playing");
  if (typeof scrubberFull !== "undefined" && scrubberFull) scrubberFull.value = 0;
  if (cleanScrubber) cleanScrubber.value = 0;
  cleanSizeEl.textContent = "—";
  cleanDurEl.textContent  = "—";
  setStatus("", "Ready");
  hideAlert();
  resetBtn.disabled = true;
  sendBtn.disabled  = true;
  recBtn.disabled   = false;
}

// ── Send clean blob to backend ─────────────────────────────────────────────
async function sendAudio() {
  if (!voiceChunks.length) { showAlert("error", "No clean voice data to send."); return; }

  cleanBlob = new Blob(voiceChunks, { type: "audio/webm" });
  showAlert("info", `Sending ${(cleanBlob.size / 1024).toFixed(1)} KB of clean voice audio…`);
  sendBtn.disabled = true;

  try {
    const fd = new FormData();
    fd.append("audio",      cleanBlob,                    "voice_clean.webm");
    fd.append("duration",   voiceCollected.toFixed(2));
    fd.append("sampleRate", "16000");
    fd.append("filtered",   "true");   // tells backend this is pre-filtered

    const res = await fetch("/api/voice/upload", { method: "POST", body: fd });
    if (res.ok) {
      showAlert("success", "Clean audio sent successfully!");
    } else {
      throw new Error("Server responded with " + res.status);
    }
  } catch (e) {
    showAlert("warn", `Backend not reachable: ${e.message}. Wire up /api/voice/upload on your server.`);
    sendBtn.disabled = false;
  }
}

// ── Event listeners ────────────────────────────────────────────────────────
recBtn.addEventListener("click",  () => recording ? stopRecording(voiceCollected >= CONFIG.minVoiceTarget) : startRecording());
resetBtn.addEventListener("click", resetAll);
sendBtn.addEventListener("click",  sendAudio);
