import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function QRCard({ roomId, size = 176 }: { roomId: string; size?: number }) {
  const url = `${location.origin}/join/${roomId}`;
  const [svg, setSvg] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#05050a', light: '#ffffff' } }).then(setSvg); }, [url]);
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="rounded-2xl bg-white p-2.5 shadow-[0_0_60px_-10px_rgba(99,102,241,.8)]" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg width="100%" height="100%" ') }} aria-label={`QR code to join room ${roomId}`} />
      <div className="text-center">
        <div className="font-display text-3xl font-bold tracking-[0.25em] grad-text">{roomId}</div>
        <button onClick={copy} className="mt-1 text-xs text-white/50 hover:text-white">{copied ? 'Link copied ✓' : 'Copy join link'}</button>
      </div>
    </div>
  );
}
