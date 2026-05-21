// ── Config (overrideable via UI) ───────────────────────────────────────────
const CONFIG = {
  maxSessionTime : 15,   // seconds — max recording window
  minVoiceTarget : 10,   // seconds — clean speech needed to complete
};

const SAMPLE_TEXT =
  "The quick brown fox jumped over the lazy dog near the riverbank. " +
  "Artificial intelligence systems are transforming how we interact with technology every single day. " +
  "Please speak this passage clearly and at a natural pace for the best recording quality.";

// ── DSP thresholds ─────────────────────────────────────────────────────────
const SILENCE_RMS   = 0.005;   // below → silence
const VOICE_RMS     = 0.018;   // above → candidate for voice
const FAN_RMS_MAX   = 0.025;   // fan/AC: low energy …
const FAN_ZCR_MIN   = 0.28;    //         … but high ZCR
const NOISE_ZCR     = 0.35;    // broadband noise cutoff

// Cough detection — short explosive burst
// A cough has: very high energy spike, moderate-to-high ZCR,
// and spectral centroid skewed toward mid-high frequencies
const COUGH_RMS_MIN         = 0.12;   // coughs are loud
const COUGH_ZCR_MAX         = 0.55;   // not as high-frequency as hiss
const COUGH_ZCR_MIN         = 0.18;   // but not DC-like speech either
const COUGH_BURST_MS        = 350;    // max duration of a cough burst (ms)
const COUGH_COOLDOWN_MS     = 800;    // silence window after cough before re-qualifying voice

// ── State ──────────────────────────────────────────────────────────────────
let mediaRecorder    = null;
let audioCtx         = null;
let analyser         = null;
let animId           = null;
let stream           = null;
let recording        = false;
let startTime        = 0;
let sessionElapsed   = 0;
let voiceCollected   = 0;
let lastTick         = 0;
let audioChunks      = [];
let segments         = [];
let currentSegType   = "silent";
let wordIndex        = 0;
let wordTimer        = null;
let playbackBlob     = null;

// Cough state machine
let coughBurstStart  = 0;
let coughCooldownEnd = 0;
let inCoughBurst     = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
const readTextEl      = document.getElementById("readText");
const recBtn          = document.getElementById("recBtn");
const resetBtn        = document.getElementById("resetBtn");
const sendBtn         = document.getElementById("sendBtn");
const playBtn         = document.getElementById("playBtn");
const audioPlayer     = document.getElementById("audioPlayer");
const statusPill      = document.getElementById("statusPill");
const statusDot       = document.getElementById("statusDot");
const statusText      = document.getElementById("statusText");
const vadBadge        = document.getElementById("vadBadge");
const voiceVal        = document.getElementById("voiceVal");
const voiceFill       = document.getElementById("voiceFill");
const timeVal         = document.getElementById("timeVal");
const timeFill        = document.getElementById("timeFill");
const rmsVal          = document.getElementById("rmsVal");
const noiseVal        = document.getElementById("noiseVal");
const zcrVal          = document.getElementById("zcrVal");
const alertBox        = document.getElementById("alertBox");
const alertMsg        = document.getElementById("alertMsg");
const segmentsRow     = document.getElementById("segmentsRow");
const canvas          = document.getElementById("waveCanvas");
const ctx2d           = canvas.getContext("2d");
const cfgMaxTime      = document.getElementById("cfgMaxTime");
const cfgMinVoice     = document.getElementById("cfgMinVoice");
const cfgMaxTimeVal   = document.getElementById("cfgMaxTimeVal");
const cfgMinVoiceVal  = document.getElementById("cfgMinVoiceVal");
const applyConfigBtn  = document.getElementById("applyConfigBtn");
const playerSection   = document.getElementById("playerSection");
const playbackTime    = document.getElementById("playbackTime");

// ── Config sliders ─────────────────────────────────────────────────────────
cfgMaxTime.value  = CONFIG.maxSessionTime;
cfgMinVoice.value = CONFIG.minVoiceTarget;
cfgMaxTimeVal.textContent = CONFIG.maxSessionTime + "s";
cfgMinVoiceVal.textContent = CONFIG.minVoiceTarget + "s";

cfgMaxTime.addEventListener("input", () => {
  const v = parseInt(cfgMaxTime.value);
  cfgMaxTimeVal.textContent = v + "s";
  // Ensure min-voice can't exceed max-time
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
  updateProgressLabels();
  setTimeout(hideAlert, 2500);
});

function updateProgressLabels() {
  voiceVal.textContent = voiceCollected.toFixed(1) + "s / " + CONFIG.minVoiceTarget + "s";
  timeVal.textContent  = sessionElapsed.toFixed(1)  + "s / " + CONFIG.maxSessionTime + "s";
}

// ── Build word spans ───────────────────────────────────────────────────────
const words = SAMPLE_TEXT.split(" ");
readTextEl.innerHTML = words.map((w, i) => `<span class="word" data-idx="${i}">${w} </span>`).join("");

// ── UI helpers ─────────────────────────────────────────────────────────────
function setStatus(type, txt) {
  statusPill.className = "status-pill";
  statusDot.className  = "dot";
  if (type === "recording") { statusPill.classList.add("active"); statusDot.classList.add("pulse"); }
  else if (type === "warn")  statusPill.classList.add("warn-state");
  else if (type === "error") statusPill.classList.add("error-state");
  statusText.textContent = txt;
}

function showAlert(type, msg) {
  alertBox.className = `alert-box ${type}`;
  alertMsg.textContent = msg;
}
function hideAlert() { alertBox.className = "alert-box hidden"; }

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
    type === "voice"  ? "voice-seg"  :
    type === "cough"  ? "cough-seg"  :
    type === "noise"  ? "noise-seg"  : "silent-seg"
  );
}

// ── DSP ────────────────────────────────────────────────────────────────────
function computeRMS(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

function computeZCR(data) {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1] - 128;
    const curr = data[i] - 128;
    if ((prev > 0 && curr <= 0) || (prev <= 0 && curr > 0)) crossings++;
  }
  return crossings / data.length;
}

/**
 * Spectral centroid (normalized 0-1) via frequency-domain data.
 * High centroid (> 0.45) = hiss / broadband noise.
 * Mid centroid (0.15–0.40) = speech / cough.
 */
function computeSpectralCentroid(freqData) {
  let weightedSum = 0, totalMag = 0;
  for (let i = 0; i < freqData.length; i++) {
    const mag = freqData[i] / 255;
    weightedSum += i * mag;
    totalMag += mag;
  }
  return totalMag > 0 ? weightedSum / (freqData.length * totalMag) : 0;
}

/**
 * Frame classifier — returns one of:
 *   "voice" | "cough" | "noise" | "silent"
 *
 * Cough detection logic:
 *   A cough is a short, loud burst with:
 *     • RMS well above normal speech floor (COUGH_RMS_MIN)
 *     • ZCR in the mid range (not pure silence, not high-freq hiss)
 *     • Duration ≤ COUGH_BURST_MS
 *   After a cough burst, a cooldown window rejects any frames
 *   that might be trailing cough sounds or reverb.
 */
function classifyFrame(rms, zcr, spectralCentroid, nowMs) {
  // Silence
  if (rms < SILENCE_RMS) {
    inCoughBurst = false;
    return "silent";
  }

  // Fan / AC noise: low-mid energy, high ZCR
  if (rms < FAN_RMS_MAX && zcr > FAN_ZCR_MIN) return "noise";

  // Broadband noise (hiss): high ZCR + high spectral centroid
  if (zcr > NOISE_ZCR && spectralCentroid > 0.4) return "noise";

  // Too quiet for speech
  if (rms < VOICE_RMS) return "silent";

  // ── Cough detection ─────────────────────────────────────────────────────
  const coughCandidate =
    rms  >= COUGH_RMS_MIN &&
    zcr  >= COUGH_ZCR_MIN &&
    zcr  <= COUGH_ZCR_MAX &&
    spectralCentroid >= 0.12 &&
    spectralCentroid <= 0.45;

  if (coughCandidate) {
    if (!inCoughBurst) {
      inCoughBurst    = true;
      coughBurstStart = nowMs;
    }
    const burstDuration = nowMs - coughBurstStart;
    if (burstDuration <= COUGH_BURST_MS) {
      coughCooldownEnd = nowMs + COUGH_COOLDOWN_MS;
      return "cough";
    }
    // Burst lasted too long → treat as sustained speech
    inCoughBurst = false;
  } else {
    inCoughBurst = false;
  }

  // Cough cooldown — reject frames immediately following a cough
  if (nowMs < coughCooldownEnd) return "cough";

  return "voice";
}

// ── Word highlighter ───────────────────────────────────────────────────────
function advanceWord() {
  const wordEls = readTextEl.querySelectorAll(".word");
  if (wordIndex > 0 && wordIndex - 1 < wordEls.length) {
    wordEls[wordIndex - 1].classList.remove("current");
    wordEls[wordIndex - 1].classList.add("done");
  }
  if (wordIndex < wordEls.length) {
    wordEls[wordIndex].classList.add("current");
    wordEls[wordIndex].scrollIntoView({ behavior: "smooth", block: "nearest" });
    wordIndex++;
  }
}

// ── Waveform renderer ──────────────────────────────────────────────────────
function drawWave(dataArray) {
  const W = canvas.width, H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);
  const sliceW = W / dataArray.length;
  let x = 0;
  ctx2d.beginPath();
  ctx2d.strokeStyle =
    currentSegType === "voice"  ? "#3ecf8e" :
    currentSegType === "cough"  ? "#c084fc" :
    currentSegType === "noise"  ? "#f5a623" : "#3a4155";
  ctx2d.lineWidth = 1.5;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    const y = H / 2 + v * (H / 2.5);
    i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    x += sliceW;
  }
  ctx2d.stroke();
}

// ── Playback ───────────────────────────────────────────────────────────────
function setupPlayback() {
  if (!audioChunks.length) return;
  playbackBlob = new Blob(audioChunks, { type: "audio/webm" });
  const url = URL.createObjectURL(playbackBlob);
  audioPlayer.src = url;
  playerSection.classList.remove("hidden");

  audioPlayer.addEventListener("timeupdate", () => {
    const cur = audioPlayer.currentTime.toFixed(1);
    const dur = isNaN(audioPlayer.duration) ? "?" : audioPlayer.duration.toFixed(1);
    playbackTime.textContent = cur + "s / " + dur + "s";
  });

  audioPlayer.addEventListener("play",  () => {
    playBtn.innerHTML = '<i class="ti ti-player-pause"></i> Pause';
    playBtn.classList.add("playing");
  });
  audioPlayer.addEventListener("pause", () => {
    playBtn.innerHTML = '<i class="ti ti-player-play"></i> Play back';
    playBtn.classList.remove("playing");
  });
  audioPlayer.addEventListener("ended", () => {
    playBtn.innerHTML = '<i class="ti ti-player-play"></i> Play back';
    playBtn.classList.remove("playing");
  });
}

playBtn.addEventListener("click", () => {
  if (!audioPlayer.src) return;
  audioPlayer.paused ? audioPlayer.play() : audioPlayer.pause();
});

// ── Main animation / VAD tick ──────────────────────────────────────────────
const freqData = new Uint8Array(512);

function tick() {
  if (!recording) return;
  const now = performance.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;
  sessionElapsed = Math.min((now - startTime) / 1000, CONFIG.maxSessionTime);

  const timeData = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(timeData);
  analyser.getByteFrequencyData(freqData);

  const rms      = computeRMS(timeData);
  const zcr      = computeZCR(timeData);
  const centroid = computeSpectralCentroid(freqData);
  const segType  = classifyFrame(rms, zcr, centroid, now);
  currentSegType = segType;

  // Only count verified voice frames
  if (segType === "voice") voiceCollected = Math.min(voiceCollected + dt, CONFIG.minVoiceTarget);

  updateSegmentBar(sessionElapsed, segType);

  // ── Progress bars ────────────────────────────────────────────────────────
  const voicePct = Math.min((voiceCollected / CONFIG.minVoiceTarget) * 100, 100);
  const timePct  = (sessionElapsed / CONFIG.maxSessionTime) * 100;

  voiceVal.textContent  = voiceCollected.toFixed(1) + "s / " + CONFIG.minVoiceTarget + "s";
  voiceFill.style.width = voicePct.toFixed(1) + "%";
  timeVal.textContent   = sessionElapsed.toFixed(1) + "s / " + CONFIG.maxSessionTime + "s";
  timeFill.style.width  = timePct.toFixed(1) + "%";

  timeFill.className = "fill fill-time";
  if (timePct > 80) timeFill.classList.add("crit");
  else if (timePct > 60) timeFill.classList.add("warn");

  // ── Metrics ──────────────────────────────────────────────────────────────
  rmsVal.textContent = rms.toFixed(3);
  rmsVal.className   = "metric-val " + (rms > VOICE_RMS ? "good" : rms > SILENCE_RMS ? "warn" : "");

  const totalActive  = segments.filter(s => s.type !== "silent").length || 1;
  const noiseRatio   = segments.filter(s => s.type === "noise" || s.type === "cough").length / totalActive;
  noiseVal.textContent = (noiseRatio * 100).toFixed(0) + "%";
  noiseVal.className = "metric-val " + (noiseRatio < 0.2 ? "good" : noiseRatio < 0.5 ? "warn" : "bad");

  zcrVal.textContent = zcr.toFixed(3);
  zcrVal.className   = "metric-val " + (zcr < NOISE_ZCR ? "good" : "warn");

  // ── VAD badge ────────────────────────────────────────────────────────────
  vadBadge.className = "vad-badge";
  if      (segType === "voice")  { vadBadge.classList.add("voice");  vadBadge.textContent = "✦ voice";  }
  else if (segType === "cough")  { vadBadge.classList.add("cough");  vadBadge.textContent = "⚠ cough";  }
  else if (segType === "noise")  { vadBadge.classList.add("noise");  vadBadge.textContent = "⚡ noise";  }
  else                           {                                    vadBadge.textContent = "— silent"; }

  // ── Alert messages ───────────────────────────────────────────────────────
  if (segType === "cough")
    showAlert("warn", "Cough detected — this segment is excluded from voice count.");
  else if (segType === "noise")
    showAlert("warn", "Background noise detected — move away from fans or AC units.");
  else if (segType === "silent" && sessionElapsed > 2)
    showAlert("info", "No voice detected. Speak clearly into your microphone.");
  else
    hideAlert();

  drawWave(timeData);

  if (voiceCollected >= CONFIG.minVoiceTarget) { stopRecording(true);  return; }
  if (sessionElapsed >= CONFIG.maxSessionTime) { stopRecording(false); return; }

  animId = requestAnimationFrame(tick);
}

// ── Start ──────────────────────────────────────────────────────────────────
async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      video: false
    });
  } catch (e) {
    showAlert("error", "Microphone access denied. Please allow microphone permission.");
    setStatus("error", "No mic");
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.4;

  // Use a separate analyser for frequency data (larger FFT = more resolution)
  const freqAnalyser = audioCtx.createAnalyser();
  freqAnalyser.fftSize = 1024;
  freqAnalyser.smoothingTimeConstant = 0.3;

  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(analyser);
  src.connect(freqAnalyser);

  // Override getByteFrequencyData to use the high-res analyser
  const origFreqFn = analyser.getByteFrequencyData.bind(analyser);
  analyser.getByteFrequencyData = (arr) => freqAnalyser.getByteFrequencyData(arr);

  audioChunks  = [];
  playbackBlob = null;
  playerSection.classList.add("hidden");
  audioPlayer.src = "";
  playBtn.innerHTML = '<i class="ti ti-player-play"></i> Play back';
  playBtn.classList.remove("playing");

  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.start(100);

  canvas.width  = (canvas.offsetWidth  || 640) * window.devicePixelRatio;
  canvas.height = (canvas.offsetHeight || 84)  * window.devicePixelRatio;

  recording      = true;
  startTime      = performance.now();
  lastTick       = startTime;
  voiceCollected = 0;
  sessionElapsed = 0;
  wordIndex      = 0;
  inCoughBurst   = false;
  coughCooldownEnd = 0;

  initSegments();
  readTextEl.querySelectorAll(".word").forEach(w => w.classList.remove("current", "done"));

  recBtn.innerHTML = '<i class="ti ti-player-stop-filled"></i> Stop Recording';
  recBtn.classList.add("recording");
  resetBtn.disabled = false;
  sendBtn.disabled  = true;
  setStatus("recording", "Recording…");
  hideAlert();

  wordTimer = setInterval(() => {
    if (currentSegType === "voice") advanceWord();
  }, 600);

  animId = requestAnimationFrame(tick);
}

// ── Stop ───────────────────────────────────────────────────────────────────
function stopRecording(success) {
  if (!recording) return;
  recording = false;
  cancelAnimationFrame(animId);
  clearInterval(wordTimer);

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    // Wait a tick so last ondataavailable fires before we build the blob
    setTimeout(() => setupPlayback(), 300);
  } else {
    setupPlayback();
  }

  stream && stream.getTracks().forEach(t => t.stop());
  audioCtx && audioCtx.close();

  recBtn.innerHTML = '<i class="ti ti-microphone"></i> Start Recording';
  recBtn.classList.remove("recording");
  recBtn.disabled = false;

  if (success) {
    setStatus("", "Complete ✓");
    showAlert("success", `Voice capture complete — ${voiceCollected.toFixed(1)}s of clean speech collected. Ready to send.`);
    sendBtn.disabled = false;
  } else {
    setStatus("error", "Incomplete");
    showAlert("error", `Only ${voiceCollected.toFixed(1)}s collected (need ${CONFIG.minVoiceTarget}s). Try in a quieter environment.`);
  }
}

// ── Reset ──────────────────────────────────────────────────────────────────
function resetAll() {
  stopRecording(false);
  voiceCollected = sessionElapsed = wordIndex = 0;
  inCoughBurst = false; coughCooldownEnd = 0;
  initSegments();
  voiceVal.textContent  = "0.0s / " + CONFIG.minVoiceTarget + "s";
  voiceFill.style.width = "0%";
  timeVal.textContent   = "0.0s / " + CONFIG.maxSessionTime + "s";
  timeFill.style.width  = "0%";
  rmsVal.textContent    = "—"; rmsVal.className  = "metric-val";
  noiseVal.textContent  = "—"; noiseVal.className = "metric-val";
  zcrVal.textContent    = "—"; zcrVal.className   = "metric-val";
  vadBadge.className    = "vad-badge"; vadBadge.textContent = "— silent";
  readTextEl.querySelectorAll(".word").forEach(w => w.classList.remove("current", "done"));
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  audioChunks  = [];
  playbackBlob = null;
  playerSection.classList.add("hidden");
  audioPlayer.src = "";
  playBtn.innerHTML = '<i class="ti ti-player-play"></i> Play back';
  playBtn.classList.remove("playing");
  setStatus("", "Ready");
  hideAlert();
  resetBtn.disabled = true;
  sendBtn.disabled  = true;
  recBtn.disabled   = false;
}

// ── Send ───────────────────────────────────────────────────────────────────
async function sendAudio() {
  if (!audioChunks.length) { showAlert("error", "No audio data to send."); return; }
  const blob = new Blob(audioChunks, { type: "audio/webm" });
  showAlert("info", `Sending ${(blob.size / 1024).toFixed(1)} KB of audio to backend…`);
  sendBtn.disabled = true;
  try {
    const fd = new FormData();
    fd.append("audio",      blob,                       "voice_capture.webm");
    fd.append("duration",   voiceCollected.toFixed(2));
    fd.append("sampleRate", "16000");
    const res = await fetch("/api/voice/upload", { method: "POST", body: fd });
    if (res.ok) {
      showAlert("success", "Audio sent successfully to backend!");
    } else {
      throw new Error("Server responded with " + res.status);
    }
  } catch (e) {
    showAlert("warn", `Backend not reachable: ${e.message}. Wire up /api/voice/upload on your server.`);
    sendBtn.disabled = false;
  }
}

// ── Event listeners ────────────────────────────────────────────────────────
recBtn.addEventListener("click",   () => recording ? stopRecording(voiceCollected >= CONFIG.minVoiceTarget) : startRecording());
resetBtn.addEventListener("click",  resetAll);
sendBtn.addEventListener("click",   sendAudio);
