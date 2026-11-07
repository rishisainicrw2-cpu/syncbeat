import type { Socket } from 'socket.io-client';

interface Sample {
  offset: number;
  rtt: number;
}

/**
 * NTP-style server clock estimation.
 *
 * For each ping we record t0 (send), ts (server time) and t1 (receive). Assuming a symmetric path,
 * the server clock read `ts` at the midpoint of the round trip, so offset = ts - (t0 + rtt/2).
 * Samples with the lowest RTT are the least affected by queueing/asymmetry, so we take the median
 * offset of the best few recent samples.
 */
export class ClockSync {
  offsetMs = 0;
  rttMs = 0;
  ready = false;
  private samples: Sample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private socket: Socket | null = null;

  /** Current server time in ms. */
  now(): number {
    return Date.now() + this.offsetMs;
  }

  /** Seed the offset from a snapshot's serverTime so UI has *something* before the first ping returns. */
  seed(serverTime: number) {
    if (!this.ready) this.offsetMs = serverTime - Date.now();
  }

  attach(socket: Socket) {
    this.detach();
    this.socket = socket;
    // Fast burst to converge, then a slow trickle to track drift.
    void this.burst(8, 120);
    this.timer = setInterval(() => void this.sample(), 4000);
  }

  detach() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket = null;
  }

  private async burst(n: number, gap: number) {
    for (let i = 0; i < n; i++) {
      await this.sample();
      await new Promise((r) => setTimeout(r, gap));
    }
  }

  private sample(): Promise<void> {
    const socket = this.socket;
    if (!socket || !socket.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = Date.now();
      const p0 = performance.now();
      socket.timeout(2500).emit('clock:ping', (err: unknown, serverTime?: number) => {
        if (err || typeof serverTime !== 'number') return resolve();
        const rtt = performance.now() - p0; // monotonic RTT
        const offset = serverTime - (t0 + rtt / 2);
        this.samples.push({ offset, rtt });
        if (this.samples.length > 16) this.samples.shift();
        this.recompute();
        resolve();
      });
    });
  }

  private recompute() {
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 5);
    const offs = best.map((s) => s.offset).sort((a, b) => a - b);
    const median = offs[Math.floor(offs.length / 2)];
    // Smooth after the first estimate to avoid audible jumps from noisy samples.
    this.offsetMs = this.ready ? this.offsetMs * 0.6 + median * 0.4 : median;
    const rtts = this.samples.map((s) => s.rtt).sort((a, b) => a - b);
    this.rttMs = rtts[Math.floor(rtts.length / 2)];
    this.ready = true;
  }
}
