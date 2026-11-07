import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Logo, Modal, Page } from '../components/ui';
import { api, ApiError, errorText, type PublicRoom } from '../lib/api';
import { session } from '../lib/session';

export default function JoinRoom() {
  const { id: paramId } = useParams();
  const nav = useNavigate();
  const [code, setCode] = useState((paramId || '').toUpperCase());
  const [name, setName] = useState(session.guestName || session.user?.displayName || '');
  const [password, setPassword] = useState('');
  const [info, setInfo] = useState<PublicRoom | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false);

  // Look the room up as soon as a full code is present, so we know whether to ask for the access code.
  useEffect(() => {
    setInfo(null);
    if (code.length !== 6) return;
    let live = true;
    api.room(code).then((r) => live && (setInfo(r), setErr(''))).catch((e) => live && setErr(errorText(e instanceof ApiError ? e.code : '')));
    return () => { live = false; };
  }, [code]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const room = info ?? (await api.room(code));
      if (room.locked) throw new ApiError(403, 'room_locked');
      session.guestName = name.trim();
      // Owners opening their own room via the link keep admin rights if they hold a token.
      session.setJoinInfo(room.id, { name: name.trim(), password: password || undefined });
      nav(`/room/${room.id}`);
    } catch (e) { setErr(errorText(e instanceof ApiError ? e.code : '')); } finally { setBusy(false); }
  };

  return (
    <Page>
      <header className="py-5"><Logo /></header>
      <form onSubmit={submit} className="glass mt-4 animate-rise space-y-4 p-6">
        <h1 className="font-display text-2xl font-bold">Join a room</h1>
        <div>
          <label className="label" htmlFor="c">Room code</label>
          <div className="flex gap-2">
            <input id="c" className="field text-center font-display text-xl tracking-[0.3em]" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} placeholder="ABC234" inputMode="text" autoCapitalize="characters" autoComplete="off" required minLength={6} />
            <button type="button" className="btn-ghost px-4" onClick={() => setScan(true)} aria-label="Scan QR code">▣</button>
          </div>
          {info && <p className="mt-2 text-sm text-emerald-300">{info.name} · hosted by {info.adminName}{info.locked ? ' · 🔒 locked' : ''}</p>}
        </div>
        <div><label className="label" htmlFor="dn">Your name</label><input id="dn" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required placeholder="e.g. Sam's phone" autoComplete="nickname" /></div>
        {info?.requiresPassword && <div><label className="label" htmlFor="pw">Access code</label><input id="pw" className="field" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="off" /></div>}
        {err && <p role="alert" className="text-sm text-rose-300">{err}</p>}
        <button className="btn-primary w-full" disabled={busy || code.length !== 6 || !name.trim()}>{busy ? 'Joining…' : 'Join room'}</button>
        <p className="text-center text-xs leading-relaxed text-white/40">Pair your Bluetooth speaker in Android settings <em>before</em> joining so audio goes to it.</p>
      </form>
      <p className="mt-6 text-center text-sm text-white/40"><Link to="/login?next=/create" className="hover:text-white">Want to be the DJ? Create a room</Link></p>
      <Scanner open={scan} onClose={() => setScan(false)} onCode={(c) => { setCode(c); setScan(false); }} />
    </Page>
  );
}

/** QR scanning via the browser's BarcodeDetector (Chrome on Android). Falls back to a hint elsewhere. */
function Scanner({ open, onClose, onCode }: { open: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!open) return;
    const BD = (window as any).BarcodeDetector;
    if (!BD) { setMsg("This browser can't scan QR codes in-app. Open your camera app and scan the code, or type the 6-letter code."); return; }
    let stream: MediaStream | null = null, raf = 0, stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        const det = new BD({ formats: ['qr_code'] });
        const loop = async () => {
          if (stopped || !video.current) return;
          try {
            const r = await det.detect(video.current);
            const m = r[0]?.rawValue?.match(/\/join\/([A-Za-z0-9]{6})\b/) || r[0]?.rawValue?.match(/^([A-Za-z0-9]{6})$/);
            if (m) return onCode(m[1].toUpperCase());
          } catch { /* keep trying */ }
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch { setMsg('Camera permission was denied or unavailable.'); }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); setMsg(''); };
  }, [open, onCode]);
  return (
    <Modal open={open} onClose={onClose} title="Scan room QR">
      {msg ? <p className="text-sm text-white/70">{msg}</p> : <video ref={video} className="aspect-square w-full rounded-2xl bg-black object-cover" playsInline muted />}
    </Modal>
  );
}
