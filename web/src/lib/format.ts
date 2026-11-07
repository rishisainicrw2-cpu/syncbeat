export const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/** Deterministic gradient "artwork" from a string (uploads rarely carry cover art). */
export const artGradient = (seed: string) => {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 70 + (h >> 8) % 60) % 360;
  return `radial-gradient(circle at 25% 20%, hsl(${a} 90% 62%), transparent 60%), radial-gradient(circle at 80% 85%, hsl(${b} 95% 55%), transparent 55%), #0b0b16`;
};
