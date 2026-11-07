import { SYNC, positionAt, type AudioState, type MemberReport, type OutputKind, type PlaybackState, type Track } from '../../../shared/protocol';
import { ClockSync } from './ClockSync';

export interface EngineStatus {
  enabled: boolean;
  audioState: AudioState;
  loading: boolean;
  correcting: boolean;
  driftMs: number;
  trackId: string | null;
  outputLatencyMs: number;
  compensationMs: number;
  outputLabel: string;
  outputKind: OutputKind;
  canSelectOutput: boolean;
  outputs: { id: string; label: string }[];
  selectedOutput: string;
  loadError: string | null;
}

interface Anchor {
  ctxTime: number; // AudioContext time the anchor refers to
  bufPos: number; // position in the buffer (seconds) at that time
  rate: number;
}

const BT_RE = /bluetooth|buds|airpods|headset|a2dp|jbl|bose|soundcore|boom|megaboom|marshall|sony|ue |beats|speaker\s*\(bt/i;

/**
 * Plays the shared timeline through Web Audio and keeps it aligned.
 *
 * Alignment model (all in *server time*):
 *   comp = outputLatency + userOffset + adminOffset          (how late this device's sound reaches the air)
 *   A sample rendered at server time T is heard at T + comp, so to be heard "at timeline position P at
 *   time T" we must render position P(T + comp). Equivalently the render clock runs `comp` ahead.
 *
 * Start:  schedule `source.start()` at ctxTime(startAt - comp)  → no content is skipped, heard exactly on time.
 * Drift:  every 250 ms compare the source's real position with the target; nudge playbackRate (±2 %) for
 *         small errors, hard-resync (restart at the right offset) for big ones.
 */
export class SyncEngine {
  readonly clock = new ClockSync();
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private keepAlive: HTMLAudioElement | null = null;

  private state: PlaybackState | null = null;
  private tracks: Track[] = [];
  private calibration = false;
  private buffers = new Map<string, AudioBuffer>();
  private inflight = new Map<string, Promise<AudioBuffer>>();
  private src: AudioBufferSourceNode | null = null;
  private srcTrackId: string | null = null;
  private srcVersion = -1;
  private srcDuration = 0;
  private anchor: Anchor | null = null;
  private rate = 1;
  private lastHardResync = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private nextBeat = 0;
  private wakeLock: { release(): Promise<void> } | null = null;
  private listeners = new Set<() => void>();

  userOffsetMs = Number(safeGet('syncbeat.offset') ?? 0) || 0;
  adminOffsetMs = 0;
  autoLatency = safeGet('syncbeat.autolat') !== '0';
  volume = Number(safeGet('syncbeat.volume') ?? 1);
  master = 1;
  playsAudio = true;

  private s: EngineStatus = {
    enabled: false,
    audioState: 'idle',
    loading: false,
    correcting: false,
    driftMs: 0,
    trackId: null,
    outputLatencyMs: 0,
    compensationMs: 0,
    outputLabel: 'System default',
    outputKind: 'unknown',
    canSelectOutput: false,
    outputs: [],
    selectedOutput: 'default',
    loadError: null,
  };

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  status(): EngineStatus {
    return this.s;
  }
  private emit(patch: Partial<EngineStatus>) {
    this.s = { ...this.s, ...patch };
    this.listeners.forEach((l) => l());
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Must be called from a user gesture (autoplay policy). */
  async enable(playsAudio = true) {
    this.playsAudio = playsAudio;
    if (!playsAudio) {
      this.emit({ enabled: true, audioState: 'idle' });
      return;
    }
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'playback' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.82;
      this.gain = this.ctx.createGain();
      this.analyser.connect(this.gain).connect(this.ctx.destination);
      this.applyGain();
      this.ctx.addEventListener('statechange', () => this.onCtxState());
      (this.ctx as any).addEventListener?.('sinkchange', () => void this.refreshOutputs(true));
      navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshOutputs(true));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.recover();
      });
      this.startKeepAlive();
      this.tick = setInterval(() => this.loop(), 250);
    }
    await this.ctx.resume().catch(() => {});
    void this.requestWakeLock();
    await this.refreshOutputs(false);
    this.onCtxState();
    this.reconcile(true);
  }

  dispose() {
    if (this.tick) clearInterval(this.tick);
    this.clock.detach();
    this.stopSource();
    this.keepAlive?.pause();
    void this.wakeLock?.release().catch(() => {});
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private onCtxState() {
    const st = this.ctx?.state;
    const audioState: AudioState = !this.ctx ? 'idle' : st === 'running' ? 'running' : st === 'suspended' ? 'suspended' : 'suspended';
    this.emit({ audioState: this.playsAudio ? audioState : 'idle', enabled: true });
    if (st === 'running') this.reconcile(true);
  }

  /** After the tab returns, the OS interrupts audio, or a Bluetooth route changes: resume + realign. */
  private async recover() {
    if (!this.ctx) return;
    await this.ctx.resume().catch(() => {});
    void this.requestWakeLock();
    this.reconcile(true);
  }

  /** Android Chrome tends to freeze background tabs; a silent looping <audio> keeps a media session alive. Best effort. */
  private startKeepAlive() {
    try {
      const a = new Audio(silentWav());
      a.loop = true;
      a.volume = 0.001;
      a.setAttribute('playsinline', '');
      this.keepAlive = a;
      void a.play().catch(() => {});
    } catch {
      /* optional */
    }
  }

  private async requestWakeLock() {
    try {
      const nav = navigator as any;
      if (nav.wakeLock && document.visibilityState === 'visible') this.wakeLock = await nav.wakeLock.request('screen');
    } catch {
      /* optional */
    }
  }

  /* -------------------------------------------------------------- outputs */

  async refreshOutputs(resync: boolean) {
    const ctx = this.ctx as (AudioContext & { sinkId?: string | { type: string }; setSinkId?: (id: string) => Promise<void> }) | null;
    let outputs: { id: string; label: string }[] = [];
    try {
      const devs = await navigator.mediaDevices?.enumerateDevices?.();
      outputs = (devs ?? []).filter((d) => d.kind === 'audiooutput').map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Output ${i + 1}`) }));
    } catch {
      /* unsupported */
    }
    const canSelect = !!ctx?.setSinkId && outputs.length > 1;
    const selected = this.s.selectedOutput;
    const label = outputs.find((o) => o.id === selected)?.label ?? outputs.find((o) => o.id === 'default')?.label ?? 'System default';
    const anyBt = outputs.some((o) => BT_RE.test(o.label));
    const selBt = BT_RE.test(label) || (selected === 'default' && anyBt && outputs.find((o) => o.id === 'default') && BT_RE.test(outputs.find((o) => o.id === 'default')!.label));
    this.emit({
      outputs,
      canSelectOutput: canSelect,
      outputLabel: label,
      // The browser cannot *prove* where audio goes. We only claim "bluetooth" when the OS-reported label says so.
      outputKind: selBt ? 'bluetooth' : outputs.length ? 'default' : 'unknown',
    });
    this.updateLatency();
    if (resync) {
      await this.ctx?.resume().catch(() => {});
      setTimeout(() => this.reconcile(true), 400);
    }
  }

  async setOutput(id: string) {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return;
    try {
      await ctx.setSinkId(id === 'default' ? '' : id);
      this.emit({ selectedOutput: id });
      await this.refreshOutputs(true);
    } catch (e) {
      this.emit({ loadError: `Could not switch output: ${(e as Error).message}` });
    }
  }

  private updateLatency() {
    const ctx = this.ctx;
    const out = ctx ? ((ctx as any).outputLatency ?? 0) + (ctx.baseLatency ?? 0) : 0;
    const outputLatencyMs = this.autoLatency && isFinite(out) ? Math.round(out * 1000) : 0;
    this.emit({ outputLatencyMs, compensationMs: outputLatencyMs + this.userOffsetMs + this.adminOffsetMs });
  }
  private comp(): number {
    return this.s.outputLatencyMs + this.userOffsetMs + this.adminOffsetMs;
  }

  /* ------------------------------------------------------------- settings */

  setUserOffset(ms: number) {
    this.userOffsetMs = Math.round(ms);
    safeSet('syncbeat.offset', String(this.userOffsetMs));
    this.updateLatency();
    this.reconcile(true);
  }
  setAdminOffset(ms: number) {
    if (ms === this.adminOffsetMs) return;
    this.adminOffsetMs = ms;
    this.updateLatency();
    this.reconcile(true);
  }
  setAutoLatency(on: boolean) {
    this.autoLatency = on;
    safeSet('syncbeat.autolat', on ? '1' : '0');
    this.updateLatency();
    this.reconcile(true);
  }
  setVolume(v: number) {
    this.volume = v;
    safeSet('syncbeat.volume', String(v));
    this.applyGain();
  }
  setMaster(v: number) {
    this.master = v;
    this.applyGain();
  }
  private applyGain() {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(this.volume * this.master, this.ctx.currentTime, 0.02);
  }

  /* ---------------------------------------------------------- room state */

  setRoomState(p: { playback: PlaybackState; tracks: Track[]; calibration: boolean; masterVolume: number }) {
    const prev = this.state;
    this.state = p.playback;
    this.tracks = p.tracks;
    this.calibration = p.calibration;
    this.setMaster(p.masterVolume);
    if (!prev || prev.version !== p.playback.version || this.calibration) this.reconcile(false);
    // Warm the cache for the track after the current one so auto-advance is gapless.
    const idx = this.tracks.findIndex((t) => t.id === p.playback.trackId);
    const next = this.tracks[idx + 1];
    if (this.playsAudio && this.ctx && p.playback.status === 'playing' && next && !this.buffers.has(next.id)) void this.load(next).catch(() => {});
  }

  report(): Pick<MemberReport, 'driftMs' | 'rttMs' | 'clockOffsetMs' | 'outputLatencyMs' | 'userOffsetMs' | 'outputLabel' | 'outputKind' | 'audioState' | 'loading' | 'correcting' | 'trackId' | 'playsAudio'> {
    return {
      driftMs: Math.round(this.s.driftMs),
      rttMs: Math.round(this.clock.rttMs),
      clockOffsetMs: Math.round(this.clock.offsetMs),
      outputLatencyMs: this.s.outputLatencyMs,
      userOffsetMs: this.userOffsetMs,
      outputLabel: this.s.outputLabel.slice(0, 120),
      outputKind: this.s.outputKind,
      audioState: this.s.audioState,
      loading: this.s.loading,
      correcting: this.s.correcting,
      trackId: this.srcTrackId,
      playsAudio: this.playsAudio,
    };
  }

  /* -------------------------------------------------------------- loading */

  private load(track: Track): Promise<AudioBuffer> {
    const hit = this.buffers.get(track.id);
    if (hit) return Promise.resolve(hit);
    let p = this.inflight.get(track.id);
    if (!p) {
      p = (async () => {
        const res = await fetch(track.url, { mode: 'cors', credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        const buf = await this.ctx!.decodeAudioData(data);
        this.buffers.set(track.id, buf);
        // Keep memory bounded: at most 4 decoded tracks.
        while (this.buffers.size > 4) this.buffers.delete(this.buffers.keys().next().value as string);
        return buf;
      })().finally(() => this.inflight.delete(track.id));
      this.inflight.set(track.id, p);
    }
    return p;
  }

  /* ------------------------------------------------------- core scheduling */

  private stopSource(at?: number) {
    const s = this.src;
    if (!s) return;
    s.onended = null;
    try {
      s.stop(at ?? 0);
    } catch {
      /* already stopped */
    }
    if (at === undefined) {
      s.disconnect();
      this.src = null;
      this.anchor = null;
      this.srcTrackId = null;
    }
  }

  /** Reconcile what's playing with the shared state. `force` restarts the source. */
  reconcile(force: boolean) {
    const ctx = this.ctx;
    const st = this.state;
    if (!ctx || !this.playsAudio || ctx.state !== 'running') return;
    if (this.calibration || !st || st.status !== 'playing' || !st.trackId) {
      this.stopSource();
      this.emit({ loading: false, correcting: false, driftMs: 0, trackId: null });
      return;
    }
    const track = this.tracks.find((t) => t.id === st.trackId);
    if (!track) return this.stopSource();
    const buf = this.buffers.get(track.id);
    if (!buf) {
      this.emit({ loading: true, loadError: null });
      this.load(track)
        .then(() => this.reconcile(true))
        .catch((e) => this.emit({ loading: false, loadError: `Could not load "${track.title}": ${(e as Error).message}` }));
      return;
    }
    const needStart = force || !this.src || this.srcTrackId !== st.trackId || this.srcVersion !== st.version;
    if (needStart) this.startSource(buf, st, track.id);
    this.emit({ loading: false });
  }

  private startSource(buf: AudioBuffer, st: PlaybackState, trackId: string) {
    const ctx = this.ctx!;
    const serverNow = this.clock.now();
    const comp = this.comp();
    const renderNow = serverNow + comp; // the timeline position we must be *rendering* right now
    let wait = 0; // seconds until the source should begin
    let bufPos: number;
    if (renderNow < st.startAtServerMs) {
      wait = (st.startAtServerMs - renderNow) / 1000; // not started yet: schedule it on the audio clock
      bufPos = st.positionMs / 1000;
    } else {
      bufPos = positionAt(st, renderNow) / 1000;
    }
    if (bufPos >= buf.duration - 0.05) return this.stopSource();

    // Gapless hand-over: keep the old source until it naturally ends if the new one starts then.
    const prev = this.src;
    const startCtx = ctx.currentTime + wait;
    let keepOld = false;
    if (prev && this.anchor && wait > 0 && this.srcTrackId !== trackId) {
      const oldEnd = this.anchor.ctxTime + (this.srcDuration - this.anchor.bufPos) / this.anchor.rate;
      keepOld = Math.abs(oldEnd - startCtx) < 0.35;
    }
    if (prev && !keepOld) this.stopSource();
    else if (prev) this.stopSource(startCtx);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser!);
    src.start(startCtx, bufPos);
    src.onended = () => {
      if (this.src === src) {
        this.src = null;
        this.anchor = null;
      }
    };
    this.src = src;
    this.srcTrackId = trackId;
    this.srcVersion = st.version;
    this.srcDuration = buf.duration;
    this.rate = 1;
    this.anchor = { ctxTime: startCtx, bufPos, rate: 1 };
    this.lastHardResync = performance.now();
  }

  /* -------------------------------------------------- drift detection loop */

  private loop() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.updateLatency();
    if (ctx.state !== 'running') {
      if (this.s.audioState === 'running') this.emit({ audioState: 'suspended' });
      void ctx.resume().catch(() => {});
      return;
    }
    if (this.s.audioState !== 'running' && this.playsAudio) this.emit({ audioState: 'running' });
    if (this.calibration) return this.scheduleClicks();

    const st = this.state;
    if (!st || st.status !== 'playing' || !this.src || !this.anchor) {
      if (this.s.driftMs !== 0 || this.s.correcting) this.emit({ driftMs: 0, correcting: false });
      // A playing state with no source (e.g. after resume) → try to start.
      if (st?.status === 'playing' && !this.src && !this.s.loading) this.reconcile(true);
      return;
    }
    const comp = this.comp();
    const renderNow = this.clock.now() + comp;
    if (renderNow < st.startAtServerMs) return; // still waiting for the scheduled start
    const target = positionAt(st, renderNow) / 1000;
    if (target >= this.srcDuration) return;
    const a = this.anchor;
    const actual = a.bufPos + (ctx.currentTime - a.ctxTime) * a.rate;
    const drift = (actual - target) * 1000; // + ⇒ we are ahead of the shared timeline
    const abs = Math.abs(drift);
    const now = performance.now();

    if (abs > SYNC.hardResyncMs && now - this.lastHardResync > 1500) {
      // Too far off for a pitch nudge: restart at the correct position.
      const buf = this.buffers.get(this.srcTrackId!);
      if (buf) this.startSource(buf, st, this.srcTrackId!);
      this.emit({ driftMs: drift, correcting: true });
      return;
    }
    let rate = 1;
    if (abs > (this.s.correcting ? 6 : 15)) rate = 1 - Math.max(-0.02, Math.min(0.02, drift / 1500));
    if (Math.abs(rate - this.rate) > 0.0015 && this.src) {
      this.src.playbackRate.setValueAtTime(rate, ctx.currentTime);
      this.anchor = { ctxTime: ctx.currentTime, bufPos: actual, rate };
      this.rate = rate;
    }
    this.emit({ driftMs: drift, correcting: rate !== 1 });
  }

  /* --------------------------------------------------- calibration clicks */

  /**
   * Calibration: every device clicks on the same server-time beat (every second). The listener
   * hears whether the speakers click together and adjusts each device's offset until they do.
   */
  private scheduleClicks() {
    const ctx = this.ctx!;
    const comp = this.comp();
    const serverNow = this.clock.now();
    const horizon = serverNow + 700;
    let beat = Math.max(this.nextBeat, Math.ceil(serverNow / 1000) * 1000);
    for (; beat < horizon; beat += 1000) {
      const when = ctx.currentTime + (beat - comp - serverNow) / 1000; // render early by `comp`
      if (when < ctx.currentTime) continue;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const accent = Math.round(beat / 1000) % 4 === 0;
      o.frequency.value = accent ? 1760 : 1100;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.9, when + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      o.connect(g).connect(this.analyser!);
      o.start(when);
      o.stop(when + 0.06);
    }
    this.nextBeat = beat;
  }

  /* --------------------------------------------------------- UI helpers */

  /** Position (ms) of the shared timeline *as heard on this device*. */
  timelinePosition(): number {
    const st = this.state;
    if (!st) return 0;
    const track = this.tracks.find((t) => t.id === st.trackId);
    const p = positionAt(st, this.clock.now());
    return track && track.durationMs > 0 ? Math.min(p, track.durationMs) : p;
  }
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

let silentUrl: string | null = null;
function silentWav(): string {
  if (silentUrl) return silentUrl;
  const rate = 8000,
    n = rate; // 1 s of silence
  const b = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  b.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVEfmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, rate, true);
  b.setUint32(28, rate * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  w(36, 'data');
  b.setUint32(40, n * 2, true);
  silentUrl = URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' }));
  return silentUrl;
}
