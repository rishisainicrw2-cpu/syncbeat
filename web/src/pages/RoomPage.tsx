import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Backdrop, Logo } from '../components/ui';
import { errorText } from '../lib/api';
import { session } from '../lib/session';
import { useRoom } from '../hooks/useRoom';
import AdminDashboard from './AdminDashboard';
import ParticipantDashboard from './ParticipantDashboard';

export default function RoomPage() {
  const roomId = (useParams().id || '').toUpperCase();
  const adminToken = session.adminToken(roomId);
  const joinInfo = session.joinInfo(roomId);
  if (!adminToken && !joinInfo) return <Navigate to={`/join/${roomId}`} replace />;
  return <Room roomId={roomId} adminToken={adminToken} name={joinInfo?.name || session.user?.displayName || 'DJ'} password={joinInfo?.password} />;
}

function Room({ roomId, adminToken, name, password }: { roomId: string; adminToken: string | null; name: string; password?: string }) {
  const nav = useNavigate();
  const room = useRoom({ roomId, adminToken, name, password });
  const { engine, engineStatus, snap, role, fatal, conn } = room;
  const [started, setStarted] = useState(false);

  const exit = (to = '/') => { room.leave(); session.setJoinInfo(roomId, null); nav(to); };

  if (fatal) {
    if (fatal === 'bad_admin_token') session.setAdminToken(roomId, null);
    return (
      <Center>
        <h1 className="font-display text-2xl font-bold">{fatal === 'kicked' ? 'Removed from room' : fatal === 'closed' ? 'Room closed' : 'Cannot join room'}</h1>
        <p className="mt-2 text-white/60">{errorText(fatal)}</p>
        <button className="btn-primary mt-6" onClick={() => { session.setJoinInfo(roomId, null); nav(fatal === 'bad_password' ? `/join/${roomId}` : '/'); }}>{fatal === 'bad_password' ? 'Try again' : 'Back home'}</button>
      </Center>
    );
  }
  if (!snap || !role) return <Center><div className="h-10 w-10 animate-spin rounded-full border-2 border-white/15 border-t-violet-400" /><p className="mt-4 text-white/60">Connecting to room {roomId}…</p></Center>;

  // Browsers only allow audio after a tap, so every device starts here.
  if (!started) {
    return (
      <Center>
        <div className="grad-bg mb-6 flex h-20 w-20 items-center justify-center rounded-3xl shadow-[0_20px_60px_-15px_rgba(99,102,241,.9)]"><svg width="36" height="36" viewBox="0 0 24 24" fill="white"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg></div>
        <h1 className="font-display text-2xl font-bold">{snap.name}</h1>
        <p className="mt-1 text-white/55">{role === 'admin' ? 'You are the DJ' : `Hosted by ${snap.adminName}`}</p>
        <p className="mx-auto mt-5 max-w-xs text-sm leading-relaxed text-white/50">Connect your Bluetooth speaker in Android settings first, then tap below to start audio on this phone.</p>
        <button className="btn-primary mt-7 w-full max-w-xs py-4 text-base" onClick={async () => { await engine.enable(true); setStarted(true); }}>Start audio on this phone</button>
        {role === 'admin' && <button className="btn-ghost mt-3 w-full max-w-xs" onClick={async () => { await engine.enable(false); setStarted(true); }}>DJ only — no audio here</button>}
        <button className="mt-4 text-sm text-white/40 hover:text-white" onClick={() => exit()}>Leave</button>
      </Center>
    );
  }

  return role === 'admin'
    ? <AdminDashboard room={room} snap={snap} exit={exit} />
    : <ParticipantDashboard room={room} snap={snap} exit={exit} connLost={conn !== 'connected'} engineStatus={engineStatus} />;
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <Backdrop />
      <div className="mb-10"><Logo /></div>
      {children}
    </div>
  );
}
