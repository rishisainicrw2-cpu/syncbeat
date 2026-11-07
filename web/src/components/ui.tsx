import { type ReactNode, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { ConnectionQuality, SyncStatus } from '../../../shared/protocol';

export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink">
      <div className="absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-violet-600/30 blur-[110px] animate-floaty" />
      <div className="absolute -right-40 top-1/3 h-[30rem] w-[30rem] rounded-full bg-electric-500/25 blur-[120px] animate-floaty [animation-delay:-6s]" />
      <div className="absolute bottom-[-12rem] left-1/4 h-[26rem] w-[26rem] rounded-full bg-fuchsia-600/15 blur-[120px] animate-floaty [animation-delay:-10s]" />
    </div>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <Link to="/" className="inline-flex items-center gap-2.5 font-display font-bold tracking-tight">
      <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
        <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8b5cf6" /><stop offset="1" stopColor="#2f6bff" /></linearGradient></defs>
        <g fill="none" stroke="url(#lg)" strokeWidth="40" strokeLinecap="round"><path d="M96 256h40M176 196v120M256 130v252M336 196v120M376 256h40" /></g>
      </svg>
      <span className="text-lg">SYNC<span className="grad-text">BEAT</span></span>
    </Link>
  );
}

export function Page({ children, narrow = true }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className="min-h-screen">
      <Backdrop />
      <div className={`mx-auto w-full px-5 safe-t safe-b ${narrow ? 'max-w-md' : 'max-w-5xl'}`}>{children}</div>
    </div>
  );
}

const STATUS: Record<SyncStatus, { label: string; cls: string; dot: string }> = {
  synchronized: { label: 'Synchronized', cls: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/25', dot: 'bg-emerald-400' },
  adjusting: { label: 'Adjusting', cls: 'text-amber-300 bg-amber-400/10 border-amber-400/25', dot: 'bg-amber-400 animate-pulse' },
  delayed: { label: 'Delayed', cls: 'text-orange-300 bg-orange-400/10 border-orange-400/25', dot: 'bg-orange-400' },
  disconnected: { label: 'Disconnected', cls: 'text-rose-300 bg-rose-400/10 border-rose-400/25', dot: 'bg-rose-400' },
};
export function StatusPill({ status }: { status: SyncStatus }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function Signal({ quality, rtt }: { quality: ConnectionQuality; rtt?: number }) {
  const n = { good: 3, fair: 2, poor: 1, unknown: 0 }[quality];
  const color = { good: 'bg-emerald-400', fair: 'bg-amber-400', poor: 'bg-rose-400', unknown: 'bg-white/20' }[quality];
  return (
    <span className="inline-flex items-center gap-2 text-xs text-white/60" title={`Network round-trip ${rtt ?? '?'} ms`}>
      <span className="flex items-end gap-0.5" aria-hidden>
        {[1, 2, 3].map((i) => <span key={i} className={`w-1 rounded-sm ${i <= n ? color : 'bg-white/15'}`} style={{ height: 4 + i * 3 }} />)}
      </span>
      {quality === 'unknown' ? '—' : `${quality[0].toUpperCase()}${quality.slice(1)}${rtt ? ` · ${rtt} ms` : ''}`}
    </span>
  );
}

export function Slider({ value, min, max, step = 1, onChange, onCommit, disabled, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: (v: number) => void; disabled?: boolean; label: string }) {
  const p = ((value - min) / (max - min)) * 100;
  return (
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled} style={{ ['--p' as any]: `${p}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))} />
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} className="glass max-h-[90vh] w-full max-w-md animate-rise overflow-auto rounded-b-none bg-[#0c0c16]/95 p-6 outline-none sm:rounded-b-3xl">
        <div className="mb-4 flex items-center justify-between"><h2 className="font-display text-lg font-semibold">{title}</h2><button className="text-white/50 hover:text-white" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export const Icon = {
  play: <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>,
  pause: <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.2" /><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" /></svg>,
  stop: <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>,
  next: <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 6.2v11.6a.8.8 0 0 0 1.25.66l8.3-5.8a.8.8 0 0 0 0-1.32l-8.3-5.8A.8.8 0 0 0 6 6.2zM17 6h2v12h-2z" /></svg>,
  prev: <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M18 6.2v11.6a.8.8 0 0 1-1.25.66l-8.3-5.8a.8.8 0 0 1 0-1.32l8.3-5.8A.8.8 0 0 1 18 6.2zM5 6h2v12H5z" /></svg>,
  vol: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></svg>,
};
