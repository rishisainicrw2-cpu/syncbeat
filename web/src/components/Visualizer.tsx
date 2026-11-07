import { useEffect, useRef } from 'react';

/** Frequency-bar visualizer driven by the engine's AnalyserNode; gentle idle animation otherwise. */
export default function Visualizer({ analyser, active, height = 96 }: { analyser: AnalyserNode | null; active: boolean; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    const data = new Uint8Array(analyser?.frequencyBinCount ?? 64);
    const bars = 40;
    const draw = (t: number) => {
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (analyser && active) analyser.getByteFrequencyData(data);
      const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#2f6bff'); grad.addColorStop(1, '#a855f7');
      g.fillStyle = grad;
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const bin = Math.floor(Math.pow(i / bars, 1.6) * (data.length * 0.75));
        const v = analyser && active ? data[bin] / 255 : 0.06 + 0.05 * Math.sin(t / 700 + i * 0.5);
        const bh = Math.max(3, v * h);
        const x = i * bw + bw * 0.18, ww = bw * 0.64;
        g.beginPath();
        g.roundRect(x, h - bh, ww, bh, ww / 2);
        g.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyser, active]);
  return <canvas ref={ref} className="w-full" style={{ height }} aria-hidden />;
}
