import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Logo, Page } from '../components/ui';
import { api, ApiError, errorText } from '../lib/api';
import { session } from '../lib/session';

export default function CreateRoom() {
  const nav = useNavigate();
  const user = session.user;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!session.token) return void nav('/login?next=/create', { replace: true });
    api.myRooms().then((r) => setMine(r.rooms)).catch((e) => { if (e instanceof ApiError && e.status === 401) { session.clearAuth(); nav('/login?next=/create', { replace: true }); } });
  }, [nav]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.createRoom(name, password || undefined);
      session.setAdminToken(r.room.id, r.adminToken);
      nav(`/room/${r.room.id}`);
    } catch (e) { setErr(errorText(e instanceof ApiError ? e.code : '')); } finally { setBusy(false); }
  };

  const reopen = async (id: string) => {
    try { const r = await api.adminToken(id); session.setAdminToken(id, r.adminToken); nav(`/room/${id}`); } catch (e) { setErr(errorText(e instanceof ApiError ? e.code : '')); }
  };

  return (
    <Page>
      <header className="flex items-center justify-between py-5"><Logo />{user && <button className="text-sm text-white/50 hover:text-white" onClick={() => { session.clearAuth(); nav('/'); }}>Sign out</button>}</header>
      <form onSubmit={create} className="glass mt-4 animate-rise space-y-4 p-6">
        <h1 className="font-display text-2xl font-bold">Create a room</h1>
        <div><label className="label" htmlFor="rn">Room name</label><input id="rn" className="field" value={name} onChange={(e) => setName(e.target.value)} required maxLength={48} placeholder="Rooftop party" /></div>
        <div><label className="label" htmlFor="rp">Access code <span className="normal-case text-white/30">(optional)</span></label><input id="rp" className="field" value={password} onChange={(e) => setPassword(e.target.value)} minLength={4} maxLength={64} placeholder="Guests must enter this to join" autoComplete="off" /></div>
        {err && <p role="alert" className="text-sm text-rose-300">{err}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Creating…' : 'Create room'}</button>
      </form>
      {mine.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-white/45">Your rooms</h2>
          <div className="space-y-2">{mine.map((r) => (
            <button key={r.id} onClick={() => reopen(r.id)} className="glass flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition hover:bg-white/10">
              <span className="font-medium">{r.name}</span><span className="font-display tracking-widest text-white/50">{r.id}</span>
            </button>))}</div>
        </div>
      )}
      <p className="mt-6 text-center text-sm text-white/40"><Link to="/join" className="hover:text-white">Joining someone else's room?</Link></p>
    </Page>
  );
}
