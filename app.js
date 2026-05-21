// ═══════════════════════════════════════════════════════════════════════════
//  Voice Capture — app.js
//  Two-recorder architecture:
//    fullRecorder  → raw mic stream → full playback + download
//    voiceRecorder → VAD-gated stream → clean speech only → send + download
// ═══════════════════════════════════════════════════════════════════════════

// ── Config ─────────────────────────────────────────────────────────────────
var CONFIG = {
  maxSessionTime: 15,
  minVoiceTarget: 10
};

var SAMPLE_TEXT =
  "The quick brown fox jumped over the lazy dog near the riverbank. " +
  "Artificial intelligence systems are transforming how we interact with technology every single day. " +
  "Please speak this passage clearly and at a natural pace for the best recording quality.";

// ── DSP thresholds ─────────────────────────────────────────────────────────
var SILENCE_RMS       = 0.005;
var VOICE_RMS         = 0.018;
var FAN_RMS_MAX       = 0.025;
var FAN_ZCR_MIN       = 0.28;
var NOISE_ZCR         = 0.35;
var COUGH_RMS_MIN     = 0.12;
var COUGH_ZCR_MAX     = 0.55;
var COUGH_ZCR_MIN     = 0.18;
var COUGH_BURST_MS    = 350;
var COUGH_COOLDOWN_MS = 800;
var VOICE_OPEN_FRAMES  = 3;
var VOICE_CLOSE_FRAMES = 8;

// ── State ──────────────────────────────────────────────────────────────────
var fullRecorder      = null;
var voiceRecorder     = null;
var voiceDest         = null;
var audioCtx          = null;
var analyser          = null;
var freqAnalyser      = null;
var animId            = null;
var micStream         = null;

var recording         = false;
var startTime         = 0;
var sessionElapsed    = 0;
var voiceCollected    = 0;
var lastTick          = 0;

var fullChunks        = [];
var voiceChunks       = [];
var voiceRecOpen      = false;
var voiceOpenCounter  = 0;
var voiceCloseCounter = 0;

var segments          = [];
var currentSegType    = "silent";
var wordIndex         = 0;
var wordTimer         = null;
var playbackBlob      = null;
var cleanBlob         = null;

var coughBurstStart   = 0;
var coughCooldownEnd  = 0;
var inCoughBurst      = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
var readTextEl      = document.getElementById("readText");
var recBtn          = document.getElementById("recBtn");
var resetBtn        = document.getElementById("resetBtn");
var sendBtn         = document.getElementById("sendBtn");
var statusPill      = document.getElementById("statusPill");
var statusDot       = document.getElementById("statusDot");
var statusText      = document.getElementById("statusText");
var vadBadge        = document.getElementById("vadBadge");
var voiceValEl      = document.getElementById("voiceVal");
var voiceFill       = document.getElementById("voiceFill");
var timeValEl       = document.getElementById("timeVal");
var timeFill        = document.getElementById("timeFill");
var rmsVal          = document.getElementById("rmsVal");
var noiseVal        = document.getElementById("noiseVal");
var zcrVal          = document.getElementById("zcrVal");
var alertBox        = document.getElementById("alertBox");
var alertMsg        = document.getElementById("alertMsg");
var segmentsRow     = document.getElementById("segmentsRow");
var canvas          = document.getElementById("waveCanvas");
var ctx2d           = canvas.getContext("2d");
var cfgMaxTime      = document.getElementById("cfgMaxTime");
var cfgMinVoice     = document.getElementById("cfgMinVoice");
var cfgMaxTimeVal   = document.getElementById("cfgMaxTimeVal");
var cfgMinVoiceVal  = document.getElementById("cfgMinVoiceVal");
var applyConfigBtn  = document.getElementById("applyConfigBtn");
var playerSection   = document.getElementById("playerSection");
var playbackTime    = document.getElementById("playbackTime");
var cleanSizeEl     = document.getElementById("cleanSize");
var cleanDurEl      = document.getElementById("cleanDur");

var fullAudio       = document.getElementById("fullAudio");
var cleanAudio      = document.getElementById("cleanAudio");
var fullPlayBtn     = document.getElementById("fullPlayBtn");
var cleanPlayBtn    = document.getElementById("cleanPlayBtn");
var fullScrubber    = document.getElementById("fullScrubber");
var cleanScrubber   = document.getElementById("cleanScrubber");
var fullTimeEl      = document.getElementById("fullTime");
var cleanTimeEl     = document.getElementById("cleanTime");
var fullDlBtn       = document.getElementById("fullDlBtn");
var cleanDlBtn      = document.getElementById("cleanDlBtn");

// ── Config sliders ─────────────────────────────────────────────────────────
cfgMaxTime.value           = CONFIG.maxSessionTime;
cfgMinVoice.value          = CONFIG.minVoiceTarget;
cfgMaxTimeVal.textContent  = CONFIG.maxSessionTime + "s";
cfgMinVoiceVal.textContent = CONFIG.minVoiceTarget + "s";

cfgMaxTime.addEventListener("input", function() {
  var v = parseInt(cfgMaxTime.value);
  cfgMaxTimeVal.textContent = v + "s";
  if (parseInt(cfgMinVoice.value) >= v) {
    cfgMinVoice.value = v - 1;
    cfgMinVoiceVal.textContent = (v - 1) + "s";
  }
  cfgMinVoice.max = v - 1;
});

cfgMinVoice.addEventListener("input", function() {
  cfgMinVoiceVal.textContent = cfgMinVoice.value + "s";
});

applyConfigBtn.addEventListener("click", function() {
  CONFIG.maxSessionTime = parseInt(cfgMaxTime.value);
  CONFIG.minVoiceTarget = parseInt(cfgMinVoice.value);
  showAlert("info", "Config applied — max: " + CONFIG.maxSessionTime + "s, target: " + CONFIG.minVoiceTarget + "s");
  setTimeout(hideAlert, 2500);
});

// ── Word spans ─────────────────────────────────────────────────────────────
var words = SAMPLE_TEXT.split(" ");
readTextEl.innerHTML = words.map(function(w, i) {
  return '<span class="word" data-idx="' + i + '">' + w + " </span>";
}).join("");

// ── UI helpers ─────────────────────────────────────────────────────────────
function setStatus(type, txt) {
  statusPill.className = "status-pill";
  statusDot.className  = "dot";
  if (type === "recording") { statusPill.classList.add("active"); statusDot.classList.add("pulse"); }
  else if (type === "warn")   statusPill.classList.add("warn-state");
  else if (type === "error")  statusPill.classList.add("error-state");
  statusText.textContent = txt;
}

function showAlert(type, msg) {
  alertBox.className   = "alert-box " + type;
  alertMsg.textContent = msg;
}

function hideAlert() {
  alertBox.className = "alert-box hidden";
}

// ── Segment timeline ───────────────────────────────────────────────────────
function initSegments() {
  segmentsRow.innerHTML = "";
  segments = [];
  for (var i = 0; i < 60; i++) {
    var bar = document.createElement("div");
    bar.className = "seg-bar silent-seg";
    bar.style.height = "3px";
    segmentsRow.appendChild(bar);
    segments.push({ el: bar, type: "silent" });
  }
}
initSegments();

function updateSegmentBar(elapsed, type) {
  var idx = Math.min(Math.floor((elapsed / CONFIG.maxSessionTime) * 60), 59);
  var bar = segments[idx];
  if (!bar) return;
  bar.type = type;
  bar.el.className = "seg-bar";
  var h = type === "voice" ? 18 : type === "cough" ? 14 : type === "noise" ? 9 : 3;
  bar.el.style.height = h + "px";
  bar.el.classList.add(
    type === "voice" ? "voice-seg" :
    type === "cough" ? "cough-seg" :
    type === "noise" ? "noise-seg" : "silent-seg"
  );
}

// ── DSP ────────────────────────────────────────────────────────────────────
function computeRMS(data) {
  var sum = 0;
  for (var i = 0; i < data.length; i++) {
    var v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

function computeZCR(data) {
  var c = 0;
  for (var i = 1; i < data.length; i++) {
    var p = data[i - 1] - 128, n = data[i] - 128;
    if ((p > 0 && n <= 0) || (p <= 0 && n > 0)) c++;
  }
  return c / data.length;
}

function computeSpectralCentroid(freqData) {
  var ws = 0, tm = 0;
  for (var i = 0; i < freqData.length; i++) {
    var m = freqData[i] / 255;
    ws += i * m;
    tm += m;
  }
  return tm > 0 ? ws / (freqData.length * tm) : 0;
}

function classifyFrame(rms, zcr, sc, nowMs) {
  if (rms < SILENCE_RMS) { inCoughBurst = false; return "silent"; }
  if (rms < FAN_RMS_MAX && zcr > FAN_ZCR_MIN) return "noise";
  if (zcr > NOISE_ZCR && sc > 0.4) return "noise";
  if (rms < VOICE_RMS) return "silent";

  var coughCandidate =
    rms >= COUGH_RMS_MIN &&
    zcr >= COUGH_ZCR_MIN &&
    zcr <= COUGH_ZCR_MAX &&
    sc  >= 0.12 &&
    sc  <= 0.45;

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
function openVoiceRecorder() {
  if (voiceRecOpen || !voiceDest) return;
  voiceRecorder = new MediaRecorder(voiceDest.stream);
  voiceRecorder.ondataavailable = function(e) {
    if (e.data && e.data.size > 0) voiceChunks.push(e.data);
  };
  voiceRecorder.start(50);
  voiceRecOpen = true;
}

function closeVoiceRecorder() {
  if (!voiceRecOpen || !voiceRecorder) return;
  try { if (voiceRecorder.state !== "inactive") voiceRecorder.stop(); } catch(e) {}
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
  var els = readTextEl.querySelectorAll(".word");
  if (wordIndex > 0 && wordIndex - 1 < els.length) {
    els[wordIndex - 1].classList.remove("current");
    els[wordIndex - 1].classList.add("done");
  }
  if (wordIndex < els.length) {
    els[wordIndex].classList.add("current");
    els[wordIndex].scrollIntoView({ behavior: "smooth", block: "nearest" });
    wordIndex++;
  }
}

// ── Waveform ───────────────────────────────────────────────────────────────
function drawWave(data) {
  var W = canvas.width, H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);
  var sw = W / data.length;
  var x  = 0;
  ctx2d.beginPath();
  ctx2d.strokeStyle =
    currentSegType === "voice" ? "#3ecf8e" :
    currentSegType === "cough" ? "#c084fc" :
    currentSegType === "noise" ? "#f5a623" : "#3a4155";
  ctx2d.lineWidth = 1.5;
  for (var i = 0; i < data.length; i++) {
    var y = H / 2 + ((data[i] - 128) / 128) * (H / 2.5);
    if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    x += sw;
  }
  ctx2d.stroke();
}

// ── Audio player wiring helper ─────────────────────────────────────────────
function wirePlayer(audioEl, playBtnEl, scrubberEl, timeEl, dlBtnEl, filename, isClean) {
  var url = URL.createObjectURL(
    isClean
      ? new Blob(voiceChunks, { type: "audio/webm" })
      : new Blob(fullChunks,  { type: "audio/webm" })
  );

  audioEl.src = url;

  dlBtnEl.onclick = function() {
    var a = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  audioEl.addEventListener("timeupdate", function() {
    var c = audioEl.currentTime.toFixed(1);
    var d = isNaN(audioEl.duration) ? "?" : audioEl.duration.toFixed(1);
    timeEl.textContent = c + "s / " + d + "s";
    if (!isNaN(audioEl.duration) && audioEl.duration > 0)
      scrubberEl.value = (audioEl.currentTime / audioEl.duration) * 100;
  });

  audioEl.addEventListener("loadedmetadata", function() { scrubberEl.value = 0; });

  audioEl.addEventListener("play", function() {
    playBtnEl.innerHTML = '<i class="ti ti-player-pause"></i> Pause';
    playBtnEl.classList.add("playing");
  });
  audioEl.addEventListener("pause", function() {
    playBtnEl.innerHTML = isClean
      ? '<i class="ti ti-player-play"></i> Play clean'
      : '<i class="ti ti-player-play"></i> Play full';
    playBtnEl.classList.remove("playing");
  });
  audioEl.addEventListener("ended", function() {
    playBtnEl.innerHTML = isClean
      ? '<i class="ti ti-player-play"></i> Play clean'
      : '<i class="ti ti-player-play"></i> Play full';
    playBtnEl.classList.remove("playing");
  });

  scrubberEl.addEventListener("input", function() {
    if (!isNaN(audioEl.duration))
      audioEl.currentTime = (scrubberEl.value / 100) * audioEl.duration;
  });

  playBtnEl.onclick = function() {
    if (!audioEl.src) return;
    if (audioEl.paused) audioEl.play(); else audioEl.pause();
  };
}

// ── Playback setup ─────────────────────────────────────────────────────────
function setupPlayback() {
  if (!fullChunks.length) return;

  // Full recording player
  wirePlayer(fullAudio, fullPlayBtn, fullScrubber, fullTimeEl, fullDlBtn, "recording_full.webm", false);

  // Clean voice-only player
  if (voiceChunks.length) {
    cleanBlob = new Blob(voiceChunks, { type: "audio/webm" });
    cleanSizeEl.textContent = (cleanBlob.size / 1024).toFixed(1) + " KB";
    cleanDurEl.textContent  = voiceCollected.toFixed(1) + "s";
    wirePlayer(cleanAudio, cleanPlayBtn, cleanScrubber, cleanTimeEl, cleanDlBtn, "voice_clean.webm", true);
  }

  playerSection.classList.remove("hidden");
}

// ── Main tick ──────────────────────────────────────────────────────────────
var freqBuf = new Uint8Array(512);

function tick() {
  if (!recording) return;

  var now = performance.now();
  var dt  = (now - lastTick) / 1000;
  lastTick       = now;
  sessionElapsed = Math.min((now - startTime) / 1000, CONFIG.maxSessionTime);

  var timeBuf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(timeBuf);
  freqAnalyser.getByteFrequencyData(freqBuf);

  var rms  = computeRMS(timeBuf);
  var zcr  = computeZCR(timeBuf);
  var sc   = computeSpectralCentroid(freqBuf);
  var type = classifyFrame(rms, zcr, sc, now);
  currentSegType = type;

  gateVoiceRecorder(type === "voice");

  if (type === "voice") voiceCollected = Math.min(voiceCollected + dt, CONFIG.minVoiceTarget);

  updateSegmentBar(sessionElapsed, type);

  var voicePct = Math.min((voiceCollected / CONFIG.minVoiceTarget) * 100, 100);
  var timePct  = (sessionElapsed / CONFIG.maxSessionTime) * 100;

  voiceValEl.textContent  = voiceCollected.toFixed(1) + "s / " + CONFIG.minVoiceTarget + "s";
  voiceFill.style.width   = voicePct.toFixed(1) + "%";
  timeValEl.textContent   = sessionElapsed.toFixed(1) + "s / " + CONFIG.maxSessionTime + "s";
  timeFill.style.width    = timePct.toFixed(1) + "%";

  timeFill.className = "fill fill-time";
  if (timePct > 80) timeFill.classList.add("crit");
  else if (timePct > 60) timeFill.classList.add("warn");

  rmsVal.textContent = rms.toFixed(3);
  rmsVal.className   = "metric-val " + (rms > VOICE_RMS ? "good" : rms > SILENCE_RMS ? "warn" : "");

  var totalActive = segments.filter(function(s) { return s.type !== "silent"; }).length || 1;
  var rejectCount = segments.filter(function(s) { return s.type === "noise" || s.type === "cough"; }).length;
  var rejectRatio = rejectCount / totalActive;
  noiseVal.textContent = (rejectRatio * 100).toFixed(0) + "%";
  noiseVal.className   = "metric-val " + (rejectRatio < 0.2 ? "good" : rejectRatio < 0.5 ? "warn" : "bad");

  zcrVal.textContent = zcr.toFixed(3);
  zcrVal.className   = "metric-val " + (zcr < NOISE_ZCR ? "good" : "warn");

  vadBadge.className = "vad-badge";
  if      (type === "voice") { vadBadge.classList.add("voice"); vadBadge.textContent = "\u2726 voice"; }
  else if (type === "cough") { vadBadge.classList.add("cough"); vadBadge.textContent = "\u26a0 cough"; }
  else if (type === "noise") { vadBadge.classList.add("noise"); vadBadge.textContent = "\u26a1 noise"; }
  else                       {                                   vadBadge.textContent = "\u2014 silent"; }

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
function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showAlert("error", "Microphone API not available. Make sure you are on HTTPS.");
    setStatus("error", "No API");
    return;
  }

  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    video: false
  }).then(function(stream) {
    micStream  = stream;
    audioCtx   = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    analyser   = audioCtx.createAnalyser();
    freqAnalyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;     analyser.smoothingTimeConstant = 0.4;
    freqAnalyser.fftSize = 1024; freqAnalyser.smoothingTimeConstant = 0.3;

    voiceDest = audioCtx.createMediaStreamAudioDestinationNode
      ? audioCtx.createMediaStreamAudioDestinationNode()
      : audioCtx.createMediaStreamDestination();

    var src = audioCtx.createMediaStreamSource(stream);
    src.connect(analyser);
    src.connect(freqAnalyser);
    src.connect(voiceDest);

    // Full recorder — always on
    fullChunks   = [];
    fullRecorder = new MediaRecorder(stream);
    fullRecorder.ondataavailable = function(e) {
      if (e.data && e.data.size > 0) fullChunks.push(e.data);
    };
    fullRecorder.start(100);

    // Voice recorder — gate-controlled
    voiceChunks       = [];
    voiceRecOpen      = false;
    voiceOpenCounter  = 0;
    voiceCloseCounter = 0;

    // Reset player UI
    cleanBlob = null; playbackBlob = null;
    playerSection.classList.add("hidden");
    fullAudio.src  = ""; cleanAudio.src = "";
    fullPlayBtn.innerHTML  = '<i class="ti ti-player-play"></i> Play full';
    cleanPlayBtn.innerHTML = '<i class="ti ti-player-play"></i> Play clean';
    fullPlayBtn.classList.remove("playing");
    cleanPlayBtn.classList.remove("playing");
    fullScrubber.value  = 0;
    cleanScrubber.value = 0;
    cleanSizeEl.textContent = "\u2014";
    cleanDurEl.textContent  = "\u2014";

    canvas.width  = (canvas.offsetWidth  || 640) * (window.devicePixelRatio || 1);
    canvas.height = (canvas.offsetHeight || 88)  * (window.devicePixelRatio || 1);

    recording        = true;
    startTime        = performance.now();
    lastTick         = startTime;
    voiceCollected   = 0;
    sessionElapsed   = 0;
    wordIndex        = 0;
    inCoughBurst     = false;
    coughCooldownEnd = 0;

    initSegments();
    var wels = readTextEl.querySelectorAll(".word");
    wels.forEach(function(w) { w.classList.remove("current", "done"); });

    recBtn.innerHTML  = '<i class="ti ti-player-stop-filled"></i> Stop Recording';
    recBtn.classList.add("recording");
    resetBtn.disabled = false;
    sendBtn.disabled  = true;
    setStatus("recording", "Recording\u2026");
    hideAlert();

    wordTimer = setInterval(function() {
      if (currentSegType === "voice") advanceWord();
    }, 600);

    animId = requestAnimationFrame(tick);

  }).catch(function(e) {
    showAlert("error", "Microphone access denied. Please allow microphone permission and reload.");
    setStatus("error", "No mic");
  });
}

// ── Stop recording ─────────────────────────────────────────────────────────
function stopRecording(success) {
  if (!recording) return;
  recording = false;
  cancelAnimationFrame(animId);
  clearInterval(wordTimer);

  closeVoiceRecorder();

  if (fullRecorder && fullRecorder.state !== "inactive") {
    fullRecorder.stop();
    setTimeout(setupPlayback, 400);
  } else {
    setupPlayback();
  }

  if (micStream) micStream.getTracks().forEach(function(t) { t.stop(); });
  if (audioCtx && audioCtx.state !== "closed") audioCtx.close();

  recBtn.innerHTML = '<i class="ti ti-microphone"></i> Start Recording';
  recBtn.classList.remove("recording");
  recBtn.disabled = false;

  if (success) {
    setStatus("", "Complete \u2713");
    showAlert("success", "Complete \u2014 " + voiceCollected.toFixed(1) + "s of clean speech. Coughs & noise excluded.");
    sendBtn.disabled = false;
  } else {
    setStatus("error", "Incomplete");
    showAlert("error", "Only " + voiceCollected.toFixed(1) + "s clean voice collected (need " + CONFIG.minVoiceTarget + "s). Try again.");
    sendBtn.disabled = voiceChunks.length === 0;
  }
}

// ── Reset ──────────────────────────────────────────────────────────────────
function resetAll() {
  if (recording) stopRecording(false);

  voiceCollected = 0; sessionElapsed = 0; wordIndex = 0;
  inCoughBurst = false; coughCooldownEnd = 0;
  voiceOpenCounter = 0; voiceCloseCounter = 0;

  initSegments();
  voiceValEl.textContent  = "0.0s / " + CONFIG.minVoiceTarget + "s";
  voiceFill.style.width   = "0%";
  timeValEl.textContent   = "0.0s / " + CONFIG.maxSessionTime + "s";
  timeFill.style.width    = "0%";
  rmsVal.textContent  = "\u2014"; rmsVal.className  = "metric-val";
  noiseVal.textContent = "\u2014"; noiseVal.className = "metric-val";
  zcrVal.textContent  = "\u2014"; zcrVal.className  = "metric-val";
  vadBadge.className  = "vad-badge";
  vadBadge.textContent = "\u2014 silent";

  var wels = readTextEl.querySelectorAll(".word");
  wels.forEach(function(w) { w.classList.remove("current", "done"); });
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);

  fullChunks = []; voiceChunks = [];
  cleanBlob = null; playbackBlob = null;
  playerSection.classList.add("hidden");
  fullAudio.src = ""; cleanAudio.src = "";
  fullPlayBtn.innerHTML  = '<i class="ti ti-player-play"></i> Play full';
  cleanPlayBtn.innerHTML = '<i class="ti ti-player-play"></i> Play clean';
  fullPlayBtn.classList.remove("playing");
  cleanPlayBtn.classList.remove("playing");
  fullScrubber.value = 0; cleanScrubber.value = 0;
  cleanSizeEl.textContent = "\u2014";
  cleanDurEl.textContent  = "\u2014";

  setStatus("", "Ready");
  hideAlert();
  resetBtn.disabled = true;
  sendBtn.disabled  = true;
  recBtn.disabled   = false;
}

// ── Send clean audio to backend ────────────────────────────────────────────
function sendAudio() {
  if (!voiceChunks.length) { showAlert("error", "No clean voice data to send."); return; }

  var blob = new Blob(voiceChunks, { type: "audio/webm" });
  showAlert("info", "Sending " + (blob.size / 1024).toFixed(1) + " KB of clean voice audio\u2026");
  sendBtn.disabled = true;

  var fd = new FormData();
  fd.append("audio",      blob,                     "voice_clean.webm");
  fd.append("duration",   voiceCollected.toFixed(2));
  fd.append("sampleRate", "16000");
  fd.append("filtered",   "true");

  fetch("/api/voice/upload", { method: "POST", body: fd })
    .then(function(res) {
      if (res.ok) {
        showAlert("success", "Clean audio sent successfully!");
      } else {
        throw new Error("Server responded with " + res.status);
      }
    })
    .catch(function(e) {
      showAlert("warn", "Backend not reachable: " + e.message + ". Wire up /api/voice/upload on your server.");
      sendBtn.disabled = false;
    });
}

// ── Event listeners ────────────────────────────────────────────────────────
recBtn.addEventListener("click", function() {
  if (recording) stopRecording(voiceCollected >= CONFIG.minVoiceTarget);
  else startRecording();
});
resetBtn.addEventListener("click", resetAll);
sendBtn.addEventListener("click",  sendAudio);
