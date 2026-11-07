// SYNCBEAT sync engine: clock sync + scheduled start + drift correction (Web Audio API)
// Honest scope: this synchronises the *phone's audio clock* to the server timeline and compensates for the
// output latency the browser reports plus a manual per-device offset. It cannot measure Bluetooth speaker latency.

export class SyncEngine {
  constructor() {
    this.ctx = null;
    this.userGain = null; this.masterGain = null; this.analyser = null;
    this.offset = 0;            // serverTime = Date.now() + offset
    this.rtt = 0;               // best round-trip (ms)
    this.buffers = new Map();   // trackId -> AudioBuffer
    this.loading = new Map();   // trackId -> Promise
    this.pb = null;             // latest playback state from server
    this.src = null;
    this.anchor = null;         // {ctx, pos(sec), rate}
    this.manualOffsetMs = Number(localStorage.getItem('sb_offset') || 0);
    this.userVolume = Number(localStorage.getItem('sb_vol') || 1);
    this.masterVolume = 1;
    this.status = 'synchronized';
    this.driftMs = 0;
    this.loadingTrack = false;
    this.getUrl = null; this.getToken = null; this.onChange = () => {};
    this._timer = null;
    this._gen = 0;
  }

  // Must be called from a user gesture (tap) so mobile browsers allow audio
  async init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'playback' });
      this.userGain = this.ctx.createGain();
      this.masterGain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.userGain.connect(this.masterGain);
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.setVolume(this.userVolume);
      this._timer = setInterval(() => this.tick(), 1000);
      this.ctx.onstatechange = () => { if (this.ctx.state !== 'running') this.setStatus('delayed'); };
    }
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
  }

  now() { return Date.now() + this.offset; }
  setVolume(v) { this.userVolume = v; localStorage.setItem('sb_vol', String(v)); if (this.userGain) this.userGain.gain.value = v * v; }
  setMaster(v) { this.masterVolume = v; if (this.masterGain) this.masterGain.gain.value = v * v; }
  setManualOffset(ms) {
    this.manualOffsetMs = ms; localStorage.setItem('sb_offset', String(ms));
    if (this.pb && this.pb.state === 'playing') this.begin();
  }
  // Output latency reported by the browser (seconds). Bluetooth often under-reports -> use manual offset.
  outputLatencySec() {
    if (!this.ctx) return 0;
    const l = this.ctx.outputLatency || 0;
    return Math.max(l, this.ctx.baseLatency || 0);
  }
  get latencyMs() { return this.outputLatencySec() * 1000; }

  // NTP-style: several pings, keep samples with lowest RTT
  async syncClock(socket, n = 10) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      const r = await new Promise((res) => {
        const to = setTimeout(() => res(null), 2000);
        socket.emit('clock:ping', t0, (a) => { clearTimeout(to); res(a); });
      });
      const t1 = Date.now();
      if (r) samples.push({ rtt: t1 - t0, off: r.ts + (t1 - t0) / 2 - t1 });
      await new Promise((r2) => setTimeout(r2, 60));
    }
    if (!samples.length) return;
    samples.sort((a, b) => a.rtt - b.rtt);
    const best = samples.slice(0, Math.max(1, Math.ceil(samples.length / 3)));
    this.offset = best.reduce((s, x) => s + x.off, 0) / best.length;
    this.rtt = best.reduce((s, x) => s + x.rtt, 0) / best.length;
  }

  async preload(tracks) {
    for (const t of tracks) { try { await this.load(t.id); } catch (_) {} }
  }
  load(trackId) {
    if (this.buffers.has(trackId)) return Promise.resolve(this.buffers.get(trackId));
    if (this.loading.has(trackId)) return this.loading.get(trackId);
    const p = (async () => {
      const res = await fetch(this.getUrl(trackId), { headers: { Authorization: `Bearer ${this.getToken()}` } });
      if (!res.ok) throw new Error('audio fetch failed');
      const data = await res.arrayBuffer();
      const buf = await new Promise((ok, no) => this.ctx.decodeAudioData(data, ok, no));
      this.buffers.set(trackId, buf);
      return buf;
    })().finally(() => this.loading.delete(trackId));
    this.loading.set(trackId, p);
    return p;
  }
  forget(ids) { ids.forEach((id) => this.buffers.delete(id)); }

  setStatus(s) { if (s !== this.status) { this.status = s; this.onChange(); } }

  // Apply authoritative state from the server
  applyState(msg) {
    const same = this.pb && this.pb.version === msg.playback.version && this.pb.trackId === msg.playback.trackId;
    this.pb = msg.playback;
    this.setMaster(msg.masterVolume == null ? 1 : msg.masterVolume);
    if (!this.ctx) return;
    if (this.pb.state === 'playing') { if (!(same && this.src)) this.begin(); } // reconnect snapshots don't restart a healthy source
    else this.halt();
  }

  halt() {
    this._gen++;
    if (this.src) { try { this.src.onended = null; this.src.stop(); } catch (_) {} try { this.src.disconnect(); } catch (_) {} this.src = null; }
    this.anchor = null;
    this.driftMs = 0;
    this.setStatus('synchronized');
  }

  expectedMs(t = this.now()) {
    const pb = this.pb;
    if (!pb) return 0;
    if (pb.state !== 'playing') return pb.basePositionMs;
    return pb.basePositionMs + Math.max(0, t - pb.startAt);
  }
  positionMs() { return Math.max(0, this.expectedMs()); }

  async begin() {
    const pb = this.pb; const gen = ++this._gen;
    if (!pb || pb.state !== 'playing' || !this.ctx) return;
    let buf;
    try {
      if (!this.buffers.has(pb.trackId)) { this.loadingTrack = true; this.setStatus('delayed'); this.onChange(); }
      buf = await this.load(pb.trackId);
    } catch (e) { this.loadingTrack = false; this.setStatus('delayed'); return; }
    this.loadingTrack = false;
    if (gen !== this._gen) return; // superseded by a newer state
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    this.stopSource();

    const comp = this.manualOffsetMs / 1000 + this.outputLatencySec(); // source must run this far ahead of "heard" position
    const waitMs = pb.startAt - this.now();
    let when; let offsetSec;
    if (waitMs > 0) { // scheduled start in the future: start exactly at the shared timestamp
      when = this.ctx.currentTime + waitMs / 1000;
      offsetSec = pb.basePositionMs / 1000 + comp;
    } else { // joined/resynced mid-song: jump to the current shared position
      const lead = 0.05;
      when = this.ctx.currentTime + lead;
      offsetSec = (pb.basePositionMs - waitMs + lead * 1000) / 1000 + comp;
    }
    if (offsetSec >= buf.duration) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.userGain);
    src.start(when, Math.max(0, offsetSec));
    src.onended = () => { if (this.src === src) { this.src = null; } };
    this.src = src;
    this.anchor = { ctx: when, pos: Math.max(0, offsetSec), rate: 1 };
    this.setStatus(waitMs > 0 ? 'synchronized' : 'adjusting');
  }
  stopSource() {
    if (this.src) { try { this.src.onended = null; this.src.stop(); } catch (_) {} try { this.src.disconnect(); } catch (_) {} this.src = null; }
  }
  srcPosSec() {
    const a = this.anchor;
    if (!a) return 0;
    return a.pos + Math.max(0, this.ctx.currentTime - a.ctx) * a.rate;
  }

  // Drift detection + correction, once per second
  tick() {
    const pb = this.pb;
    if (!this.ctx || !pb || pb.state !== 'playing' || !this.src || !this.anchor) return;
    if (this.now() < pb.startAt || this.ctx.currentTime < this.anchor.ctx) return; // not started yet
    const comp = this.manualOffsetMs + this.outputLatencySec() * 1000;
    const want = this.expectedMs() + comp;
    const have = this.srcPosSec() * 1000;
    const drift = have - want; // +ve: ahead of the shared timeline
    this.driftMs = drift;
    const abs = Math.abs(drift);
    if (abs <= 25) {
      this.setRate(1);
      this.setStatus('synchronized');
    } else if (abs <= 250) {
      // inaudible rate nudge (~1%): catches up/slows down smoothly without a glitch
      this.setRate(drift > 0 ? 0.99 : 1.01);
      this.setStatus('adjusting');
    } else {
      this.setStatus('delayed');
      this.begin(); // hard resync
    }
  }
  setRate(r) {
    if (!this.src || !this.anchor || this.anchor.rate === r) return;
    const t = this.ctx.currentTime;
    this.anchor = { ctx: t, pos: this.srcPosSec(), rate: r };
    this.src.playbackRate.setValueAtTime(r, t);
  }

  telemetry(output) {
    return {
      driftMs: this.driftMs, rttMs: this.rtt, latencyMs: this.latencyMs, offsetMs: this.manualOffsetMs,
      status: this.status === 'disconnected' ? 'delayed' : this.status, output: output || null,
    };
  }

  // ---- output devices (Chrome/Android: limited by what the OS exposes) ----
  async listOutputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { supported: false, devices: [] };
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return { supported: true, canSelect: !!(this.ctx && this.ctx.setSinkId), devices: all.filter((d) => d.kind === 'audiooutput') };
    } catch (_) { return { supported: false, devices: [] }; }
  }
  async setOutput(deviceId) {
    if (this.ctx && this.ctx.setSinkId) { await this.ctx.setSinkId(deviceId === 'default' ? '' : deviceId); return true; }
    return false;
  }
  freqData(arr) { if (this.analyser) this.analyser.getByteFrequencyData(arr); }
}
