// ── Constants ──────────────────────────────────────────────────────────────
const SAMPLE_TEXT =
  "The quick brown fox jumped over the lazy dog near the riverbank. " +
  "Artificial intelligence systems are transforming how we interact with technology every single day. " +
  "Please speak this passage clearly and at a natural pace for the best recording quality.";

const MAX_TIME             = 15;      // seconds
const MIN_VOICE            = 10;      // seconds of clean voice required

const VOICE_RMS_THRESHOLD  = 0.018;   // minimum RMS to consider as voice
const SILENCE_RMS_THRESHOLD= 0.005;   // below this = silence
const FAN_NOISE_RMS_MAX    = 0.025;   // fan noise is low energy …
const FAN_ZCR_MIN          = 0.28;    // … but high zero-crossing rate
const NOISE_ZCR_THRESHOLD  = 0.35;    // generic broadband noise cutoff

// ── State ──────────────────────────────────────────────────────────────────
let mediaRecorder   = null;
let audioCtx        = null;
let analyser        = null;
let animId          = null;
let stream          = null;
let recording       = false;
let startTime       = 0;
let sessionElapsed  = 0;
let voiceCollected  = 0;
let lastTick        = 0;
let audioChunks     = [];
let segments        = [];
let currentSegType  = "silent";
let wordIndex       = 0;
let wordTimer       = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const readTextEl  = document.getElementById("readText");
const recBtn      = document.getElementById("recBtn");
const resetBtn    = document.getElementById("resetBtn");
const sendBtn     = document.getElementById("sendBtn");
const statusPill  = document.getElementById("statusPill");
const statusDot   = document.getElementById("statusDot");
const statusText  = document.getElementById("statusText");
const vadBadge    = document.getElementById("vadBadge");
const voiceVal    = document.getElementById("voiceVal");
const voiceFill   = document.getElementById("voiceFill");
const timeVal     = document.getElementById("timeVal");
const timeFill    = document.getElementById("timeFill");
const rmsVal      = document.getElementById("rmsVal");
const noiseVal    = document.getElementById("noiseVal");
const zcrVal      = document.getElementById("zcrVal");
const alertBox    = document.getElementById("alertBox");
const alertMsg    = document.getElementById("alertMsg");
const segmentsRow = document.getElementById("segmentsRow");
const canvas      = document.getElementById("waveCanvas");
const ctx2d       = canvas.getContext("2d");

// ── Build word spans ───────────────────────────────────────────────────────
const words = SAMPLE_TEXT.split(" ");
readTextEl.innerHTML = words
  .map((w, i) => `<span class="word" data-idx="${i}">${w} </span>`)
  .join("");

// ── Helpers ────────────────────────────────────────────────────────────────
function setStatus(type, txt) {
  statusPill.className = "status-pill";
  statusDot.className  = "dot";
  if (type === "recording") {
    statusPill.classList.add("active");
    statusDot.classList.add("pulse");
  } else if (type === "warn") {
    statusPill.classList.add("warn-state");
  } else if (type === "error") {
    statusPill.classList.add("error-state");
  }
  statusText.textContent = txt;
}

function showAlert(type, msg) {
  alertBox.className = `alert-box ${type}`;
  alertMsg.textContent = msg;
}

function hideAlert() {
  alertBox.className = "alert-box hidden";
}

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
  const idx = Math.min(Math.floor((elapsed / MAX_TIME) * 60), 59);
  const bar = segments[idx];
  if (!bar) return;
  bar.type = type;
  bar.el.className = "seg-bar";
  const h = type === "voice" ? 18 : type === "noise" ? 10 : 3;
  bar.el.style.height = h + "px";
  bar.el.classList.add(
    type === "voice" ? "voice-seg" : type === "noise" ? "noise-seg" : "silent-seg"
  );
}

// ── DSP / VAD ──────────────────────────────────────────────────────────────
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
 * Classify a single audio frame using RMS energy + Zero Crossing Rate.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │  Low RMS → silence                                       │
 * │  Low-mid RMS + High ZCR → fan / broadband noise          │
 * │  Mid-high RMS + Low-mid ZCR → speech (voice)             │
 * └──────────────────────────────────────────────────────────┘
 */
function classifyFrame(rms, zcr) {
  if (rms < SILENCE_RMS_THRESHOLD)                      return "silent";
  if (rms < FAN_NOISE_RMS_MAX && zcr > FAN_ZCR_MIN)    return "noise";   // fan / AC
  if (rms < VOICE_RMS_THRESHOLD)                        return "silent";
  if (zcr > NOISE_ZCR_THRESHOLD && rms < 0.04)          return "noise";   // broadband noise
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
    currentSegType === "voice" ? "#3ecf8e" :
    currentSegType === "noise" ? "#f5a623" : "#3a4155";
  ctx2d.lineWidth = 1.5;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    const y = H / 2 + v * (H / 2.5);
    i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    x += sliceW;
  }
  ctx2d.stroke();
}

// ── Main animation / VAD tick ──────────────────────────────────────────────
function tick() {
  if (!recording) return;
  const now = performance.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;
  sessionElapsed = Math.min((now - startTime) / 1000, MAX_TIME);

  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);

  const rms     = computeRMS(data);
  const zcr     = computeZCR(data);
  const segType = classifyFrame(rms, zcr);
  currentSegType = segType;

  if (segType === "voice") voiceCollected = Math.min(voiceCollected + dt, MIN_VOICE);

  updateSegmentBar(sessionElapsed, segType);

  // ── Progress bars ────────────────────────────────────────────────────────
  const voicePct = Math.min((voiceCollected / MIN_VOICE) * 100, 100);
  const timePct  = (sessionElapsed / MAX_TIME) * 100;

  voiceVal.textContent   = voiceCollected.toFixed(1) + "s / 10s";
  voiceFill.style.width  = voicePct.toFixed(1) + "%";
  timeVal.textContent    = sessionElapsed.toFixed(1) + "s / 15s";
  timeFill.style.width   = timePct.toFixed(1) + "%";

  timeFill.className = "fill fill-time";
  if (timePct > 80) timeFill.classList.add("crit");
  else if (timePct > 60) timeFill.classList.add("warn");

  // ── Metrics ──────────────────────────────────────────────────────────────
  rmsVal.textContent  = rms.toFixed(3);
  rmsVal.className    = "metric-val " + (rms > VOICE_RMS_THRESHOLD ? "good" : rms > SILENCE_RMS_THRESHOLD ? "warn" : "");

  const totalActive   = segments.filter(s => s.type !== "silent").length || 1;
  const noiseRatio    = segments.filter(s => s.type === "noise").length / totalActive;
  noiseVal.textContent = (noiseRatio * 100).toFixed(0) + "%";
  noiseVal.className  = "metric-val " + (noiseRatio < 0.2 ? "good" : noiseRatio < 0.5 ? "warn" : "bad");

  zcrVal.textContent = zcr.toFixed(3);
  zcrVal.className   = "metric-val " + (zcr < NOISE_ZCR_THRESHOLD ? "good" : "warn");

  // ── VAD badge ────────────────────────────────────────────────────────────
  vadBadge.className = "vad-badge";
  if (segType === "voice")      { vadBadge.classList.add("voice"); vadBadge.textContent = "✦ voice"; }
  else if (segType === "noise") { vadBadge.classList.add("noise"); vadBadge.textContent = "⚡ noise"; }
  else                          { vadBadge.textContent = "— silent"; }

  // ── Alert messages ───────────────────────────────────────────────────────
  if (segType === "noise")
    showAlert("warn", "Background noise detected — move away from fans or AC units.");
  else if (segType === "silent" && sessionElapsed > 2)
    showAlert("info", "No voice detected. Speak clearly into your microphone.");
  else
    hideAlert();

  drawWave(data);

  // ── Completion checks ────────────────────────────────────────────────────
  if (voiceCollected >= MIN_VOICE) { stopRecording(true);  return; }
  if (sessionElapsed >= MAX_TIME)  { stopRecording(false); return; }

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

  audioCtx  = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  analyser  = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.5;

  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(analyser);

  audioChunks  = [];
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

  initSegments();
  readTextEl.querySelectorAll(".word").forEach(w => w.classList.remove("current", "done"));

  recBtn.innerHTML = '<i class="ti ti-player-stop-filled"></i> Stop Recording';
  recBtn.classList.add("recording");
  resetBtn.disabled = false;
  sendBtn.disabled  = true;
  setStatus("recording", "Recording…");
  hideAlert();

  // Advance word highlight only during active voice frames
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

  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
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
    showAlert("error", `Only ${voiceCollected.toFixed(1)}s of clean voice collected (need 10s). Try again in a quieter environment.`);
  }
}

// ── Reset ──────────────────────────────────────────────────────────────────
function resetAll() {
  stopRecording(false);
  voiceCollected = sessionElapsed = wordIndex = 0;
  initSegments();
  voiceVal.textContent  = "0.0s / 10s";
  voiceFill.style.width = "0%";
  timeVal.textContent   = "0.0s / 15s";
  timeFill.style.width  = "0%";
  rmsVal.textContent    = "—"; rmsVal.className  = "metric-val";
  noiseVal.textContent  = "—"; noiseVal.className = "metric-val";
  zcrVal.textContent    = "—"; zcrVal.className   = "metric-val";
  vadBadge.className    = "vad-badge";
  vadBadge.textContent  = "— silent";
  readTextEl.querySelectorAll(".word").forEach(w => w.classList.remove("current", "done"));
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  audioChunks = [];
  setStatus("", "Ready");
  hideAlert();
  resetBtn.disabled = true;
  sendBtn.disabled  = true;
  recBtn.disabled   = false;
}

// ── Send to backend ─────────────────────────────────────────────────────────
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
    showAlert("warn", `Backend endpoint not reachable: ${e.message}. Wire up /api/voice/upload on your server.`);
    sendBtn.disabled = false;
  }
}

// ── Event listeners ────────────────────────────────────────────────────────
recBtn.addEventListener("click",  () => recording ? stopRecording(voiceCollected >= MIN_VOICE) : startRecording());
resetBtn.addEventListener("click", resetAll);
sendBtn.addEventListener("click",  sendAudio);
