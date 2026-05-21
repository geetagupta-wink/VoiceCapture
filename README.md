# Voice Capture App

Browser-based voice recorder with real-time VAD, cough detection, noise rejection, and clean audio export.

## Features
- Real-time waveform + voice activity detection (RMS + ZCR + spectral centroid)
- Cough detection and exclusion from clean audio
- Fan/AC noise rejection
- Dual recorder: full audio for playback, clean voice-only for backend
- Play back and download both tracks independently
- Configurable session time and voice target
- Segment timeline showing voice / cough / noise / silence

## Deploy to Vercel

### Vercel CLI
```bash
npm i -g vercel
cd voice-capture-app
vercel --prod
```

### GitHub auto-deploy
Push to GitHub → connect repo in vercel.com/new → auto-deploys on every push.

### Drag & drop
vercel.com/new → Deploy without Git → upload this folder.

## Backend
Send button POSTs `voice_clean.webm` to `/api/voice/upload` with:
- `audio` — clean WebM blob (16 kHz, speech only)
- `duration` — seconds of clean speech
- `sampleRate` — "16000"
- `filtered` — "true"

## Local dev
```bash
npx serve .
# open http://localhost:3000
```
