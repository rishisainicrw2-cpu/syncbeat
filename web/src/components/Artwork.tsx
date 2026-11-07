import { artGradient } from '../lib/format';
export default function Artwork({ seed, playing, className = '' }: { seed: string; playing?: boolean; className?: string }) {
  return (
    <div className={`relative aspect-square overflow-hidden rounded-[2rem] border border-white/10 shadow-[0_30px_80px_-30px_rgba(99,102,241,.8)] ${className}`} style={{ background: artGradient(seed || 'syncbeat') }}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(0,0,0,.55),transparent_60%)]" />
      {playing && <span className="absolute bottom-3 right-3 h-3 w-3 rounded-full bg-emerald-400 animate-pulseRing" />}
    </div>
  );
}
