# Testing

## Automated (run here)
```bash
npm test             # server: node:test + real Socket.IO clients + real HTTP
npm run typecheck    # server + web
```
`server/test/sync.test.ts` covers: registration/login, room creation, public lookup leaks nothing, **upload validation (a PHP file renamed .mp3 is rejected; a real WAV is accepted; user tokens can't upload)**, Range requests, wrong/missing access code, forged admin token, participants denied admin commands, **PLAY → identical playback state on all devices with a future `startAtServerMs`**, position maths, status derivation from reports, pause/schedule validation, clock ping, reconnect without duplicate members, room lock, kick+ban, single-admin replacement, seek/next/prev.

## Browser end-to-end (run here, headless Chromium)
`scripts/e2e-browser.cjs` drives a DJ + two participants through the real UI with a real 40 s WAV: join by code, start audio, upload, play, seek.
```bash
npm run build && (cd server && WEB_DIST=../web/dist npx tsx src/index.ts &)
NODE_PATH=$(npm root -g) node scripts/e2e-browser.cjs     # needs playwright + a WAV at /tmp/tone.wav (or TONE=…)
```
Result of the run during development (all on one machine, so network latency ≈ 0 and this only validates the engine, not Bluetooth): both participants reported **Synchronized with |drift| ≤ 13 ms** during playback and after a seek to 0:20.

## Field test you must run (Stage 8 — requires hardware)
Goal: ≥ 3 different Android phones, 3 Bluetooth speakers, ideally different brands/codecs.

1. Deploy over HTTPS (or tunnel). Pair each phone to its own speaker in **Android Settings → Bluetooth**. Put speakers ~1–2 m apart.
2. DJ creates a room; others join by QR. Everyone taps **Start audio on this phone**.
3. **Baseline:** upload a track with a clear transient beat (e.g. a click track). Press Play. Note which speaker is early/late.
4. **Calibrate:** Room tab → *Start calibration clicks*. Adjust each phone's **Speaker delay** (or remotely via Devices → Delay) until the clicks sound like one. Stop calibration. Record the offsets — they're stable per speaker+phone pair, so you can reuse them.
5. **Checks** (record pass/fail + notes):
   * all phones start within ~50 ms of each other after calibration; admin Devices tab shows *Synchronized*
   * seek, pause/resume, next/prev keep everyone together
   * scheduled start (30 s) — all phones start together, including one that joined during the countdown
   * switch phone to airplane mode 10 s then back — audio continues, reconnects, status returns to *Synchronized*
   * power-cycle a speaker mid-song — note whether audio falls back to the phone speaker, and that re-sync happens after reconnection
   * lock the screen 2 min — note whether playback survives (expected to be unreliable in Chrome; this is the case for the native app)
   * kick a device; lock room and try joining; wrong access code
6. **Measure objectively** (optional): record all speakers with one phone/laptop mic, open in Audacity and measure the spacing between clicks from the same beat on each speaker's waveform.

Log the phone models, Android/Chrome versions, speakers, codecs (Developer options shows the active Bluetooth codec) and the calibrated offsets.
