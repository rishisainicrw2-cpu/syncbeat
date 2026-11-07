import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AdminCommand, CommandResponse, JoinResponse, Role, RoomSnapshot } from '../../../shared/protocol';
import { SyncEngine } from '../audio/SyncEngine';
import { session } from '../lib/session';

export type Conn = 'connecting' | 'connected' | 'reconnecting';

export interface UseRoomOpts { roomId: string; name: string; password?: string; adminToken?: string | null }

export function useRoom(opts: UseRoomOpts) {
  const engine = useMemo(() => new SyncEngine(), []);
  const engineStatus = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.status());
  const [conn, setConn] = useState<Conn>('connecting');
  const [snap, setSnap] = useState<RoomSnapshot | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 4000 });
    socketRef.current = socket;
    const deviceId = session.deviceId;

    const apply = (s: RoomSnapshot) => {
      engine.clock.seed(s.serverTime);
      setSnap(s);
      const me = s.members.find((m) => m.deviceId === deviceId);
      engine.setAdminOffset(me?.adminOffsetMs ?? 0);
      engine.setRoomState({ playback: s.playback, tracks: s.tracks, calibration: s.calibration, masterVolume: s.masterVolume });
    };

    const join = () => {
      const o = optsRef.current;
      socket.emit('room:join', { roomId: o.roomId, name: o.name, password: o.password, deviceId, adminToken: o.adminToken || undefined }, (r: JoinResponse) => {
        if (!r.ok) { setFatal(r.error); socket.disconnect(); return; }
        setRole(r.role);
        setConn('connected');
        apply(r.snapshot);
        engine.clock.attach(socket); // (re)start clock sync after every (re)connect
      });
    };

    socket.on('connect', join);
    socket.on('disconnect', (reason) => { if (reason !== 'io client disconnect') setConn('reconnecting'); });
    socket.io.on('reconnect_attempt', () => setConn('reconnecting'));
    socket.on('snapshot', apply);
    socket.on('kicked', () => setFatal('kicked'));
    socket.on('replaced', () => setFatal('replaced'));
    socket.on('room:closed', () => setFatal('closed'));

    // 1 Hz heartbeat + sync report (also feeds the admin's device list).
    const rep = setInterval(() => { if (socket.connected) socket.emit('member:report', engine.report()); }, 1000);

    return () => {
      clearInterval(rep);
      socket.removeAllListeners();
      socket.disconnect();
      engine.dispose();
    };
  }, [engine, opts.roomId]);

  const send = (cmd: AdminCommand) =>
    new Promise<CommandResponse>((resolve) => {
      const s = socketRef.current;
      if (!s?.connected) return resolve({ ok: false, error: 'offline' });
      s.timeout(5000).emit('admin:cmd', cmd, (err: unknown, r: CommandResponse) => resolve(err ? { ok: false, error: 'timeout' } : r));
    });

  const leave = () => { socketRef.current?.emit('room:leave'); socketRef.current?.disconnect(); };

  return { engine, engineStatus, conn, snap, role, fatal, send, leave };
}

/** Live position of the shared timeline (ms), updated ~10×/s. */
export function usePosition(engine: SyncEngine, active: boolean) {
  const [pos, setPos] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setPos(engine.timelinePosition()), 100);
    return () => clearInterval(id);
  }, [engine, active]);
  return pos;
}
