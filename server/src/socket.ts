import { Server as IOServer, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod';
import { MAX_NAME, type CommandResponse, type JoinResponse, type MemberReport } from '../../shared/protocol';
import { verifyAdmin } from './auth';
import { config } from './config';
import { cleanName, type Room, type RoomManager } from './rooms';

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const joinSchema = z.object({
  roomId: z.string().trim().min(4).max(8),
  name: z.string().max(200).default(''),
  deviceId: z.string().trim().min(8).max(64).regex(/^[\w-]+$/),
  password: z.string().max(100).optional(),
  adminToken: z.string().max(2000).optional(),
});
const reportSchema = z.object({
  driftMs: num(-60_000, 60_000),
  rttMs: num(0, 60_000),
  clockOffsetMs: num(-1e12, 1e12),
  outputLatencyMs: num(0, 5000),
  userOffsetMs: num(-2000, 5000),
  outputLabel: z.string().max(120),
  outputKind: z.enum(['bluetooth', 'default', 'unknown']),
  audioState: z.enum(['idle', 'locked', 'running', 'suspended']),
  loading: z.boolean(),
  correcting: z.boolean(),
  trackId: z.string().max(64).nullable(),
  playsAudio: z.boolean(),
});

const cmdSchema: z.ZodType<any> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play'), trackId: z.string().max(64).optional(), positionMs: num(0, 14_400_000).optional() }),
  z.object({ type: z.literal('schedule'), startAtServerMs: num(0, 1e14), trackId: z.string().max(64).optional() }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('next') }),
  z.object({ type: z.literal('prev') }),
  z.object({ type: z.literal('seek'), positionMs: num(0, 14_400_000) }),
  z.object({ type: z.literal('lock'), locked: z.boolean() }),
  z.object({ type: z.literal('kick'), deviceId: z.string().max(64) }),
  z.object({ type: z.literal('master'), volume: num(0, 1) }),
  z.object({ type: z.literal('lead'), leadMs: num(0, 60_000) }),
  z.object({ type: z.literal('repeat'), mode: z.enum(['off', 'all', 'one']) }),
  z.object({ type: z.literal('calibration'), on: z.boolean() }),
  z.object({ type: z.literal('setOffset'), deviceId: z.string().max(64), offsetMs: num(-5000, 5000) }),
  z.object({ type: z.literal('reorder'), trackIds: z.array(z.string().max(64)).max(500) }),
  z.object({ type: z.literal('removeTrack'), trackId: z.string().max(64) }),
  z.object({ type: z.literal('addUrl'), title: z.string().max(200), artist: z.string().max(200), url: z.string().max(2000), durationMs: num(0, 14_400_000) }),
  z.object({ type: z.literal('rename'), name: z.string().max(MAX_NAME * 2) }),
  z.object({ type: z.literal('setPassword'), password: z.string().min(4).max(64).nullable() }),
  z.object({ type: z.literal('closeRoom') }),
]);

interface SocketData {
  roomId?: string;
  deviceId?: string;
  isAdmin?: boolean;
}

export function attachSocket(httpServer: HttpServer, mgr: RoomManager) {
  const io = new IOServer<any, any, any, SocketData>(httpServer, {
    cors: config.clientOrigins.length ? { origin: config.clientOrigins, credentials: true } : undefined,
    maxHttpBufferSize: 64 * 1024, // control messages only; audio never travels over the socket
    pingInterval: 5000,
    pingTimeout: 8000,
    transports: ['websocket', 'polling'],
  });

  const emitSnapshot = (room: Room) => io.to(room.rec.id).emit('snapshot', mgr.snapshot(room));
  mgr.notify = (room, immediate) => {
    if (immediate) {
      room.dirty = false;
      emitSnapshot(room);
    }
  };
  mgr.onKick = (socketId, reason) => {
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    s.emit(reason === 'kicked' ? 'kicked' : 'room:closed');
    s.disconnect(true);
  };
  // Throttled flush of the high-frequency device reports (1 Hz per room) + stale-device detection.
  const flush = setInterval(() => {
    for (const room of mgr.rooms.values()) {
      if (room.dirty || room.members.size) {
        room.dirty = false;
        emitSnapshot(room);
      }
    }
  }, 1000);
  flush.unref();
  io.engine.on('close', () => {});

  io.on('connection', (socket: Socket<any, any, any, SocketData>) => {
    // Per-socket flood protection: ≤ 40 events/sec.
    let bucket = 40;
    const refill = setInterval(() => (bucket = 40), 1000);
    socket.use((_ev, next) => (--bucket < 0 ? next(new Error('rate_limited')) : next()));

    socket.on('clock:ping', (cb?: (t: number) => void) => typeof cb === 'function' && cb(Date.now()));

    socket.on('room:join', async (raw: unknown, cb?: (r: JoinResponse) => void) => {
      const reply = (r: JoinResponse) => typeof cb === 'function' && cb(r);
      try {
        const p = joinSchema.safeParse(raw);
        if (!p.success) return reply({ ok: false, error: 'bad_request' });
        const room = await mgr.get(p.data.roomId);
        if (!room) return reply({ ok: false, error: 'not_found' });

        let isAdmin = false;
        if (p.data.adminToken) {
          const claims = verifyAdmin(p.data.adminToken, room.rec.id);
          if (!claims || claims.sub !== room.rec.ownerId) return reply({ ok: false, error: 'bad_admin_token' });
          isAdmin = true;
        }
        const res = await mgr.join(room, {
          deviceId: p.data.deviceId,
          name: cleanName(p.data.name),
          password: p.data.password,
          socketId: socket.id,
          isAdmin,
        });
        if (!res.ok) return reply({ ok: false, error: res.error });

        if (res.replacedSocket) {
          const old = io.sockets.sockets.get(res.replacedSocket);
          old?.emit('replaced');
          old?.disconnect(true);
        }
        // Leave any previous room on this socket (e.g. re-join after reconnect).
        if (socket.data.roomId && socket.data.roomId !== room.rec.id) socket.leave(socket.data.roomId);
        socket.data = { roomId: room.rec.id, deviceId: p.data.deviceId, isAdmin };
        await socket.join(room.rec.id);
        reply({ ok: true, role: isAdmin ? 'admin' : 'participant', deviceId: p.data.deviceId, snapshot: mgr.snapshot(room) });
      } catch (e) {
        console.error('[socket] join', e);
        reply({ ok: false, error: 'bad_request' });
      }
    });

    const withRoom = async () => {
      const { roomId, deviceId } = socket.data;
      if (!roomId || !deviceId) return null;
      const room = await mgr.get(roomId);
      return room ? { room, deviceId } : null;
    };

    socket.on('member:report', async (raw: unknown) => {
      const p = reportSchema.safeParse(raw);
      const ctx = p.success ? await withRoom() : null;
      if (ctx && p.success) mgr.report(ctx.room, ctx.deviceId, p.data as MemberReport);
    });

    socket.on('admin:cmd', async (raw: unknown, cb?: (r: CommandResponse) => void) => {
      const reply = (r: CommandResponse) => typeof cb === 'function' && cb(r);
      try {
        // Authorization is bound to the *socket* (set only by a verified admin token on join), never to the payload.
        if (!socket.data.isAdmin) return reply({ ok: false, error: 'forbidden' });
        const ctx = await withRoom();
        if (!ctx) return reply({ ok: false, error: 'no_room' });
        const cmd = cmdSchema.safeParse(raw);
        if (!cmd.success) return reply({ ok: false, error: 'invalid_command' });
        reply(await mgr.command(ctx.room, cmd.data));
      } catch (e) {
        console.error('[socket] cmd', e);
        reply({ ok: false, error: 'server_error' });
      }
    });

    socket.on('room:leave', async () => {
      const ctx = await withRoom();
      if (ctx) {
        mgr.leave(ctx.room, ctx.deviceId);
        socket.leave(ctx.room.rec.id);
      }
      socket.data = {};
    });

    socket.on('disconnect', async () => {
      clearInterval(refill);
      const ctx = await withRoom();
      if (ctx) mgr.disconnect(ctx.room, ctx.deviceId, socket.id);
    });
  });

  return io;
}
