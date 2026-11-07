import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';

// Isolated data dir + secret before the app config is imported.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbeat-test-'));
process.env.JWT_SECRET = 'test-secret';
process.env.DEFAULT_LEAD_MS = '1500';

const { createApp } = await import('../src/app');
const { MemoryStore } = await import('../src/store');
const { positionAt } = await import('../../shared/protocol');
import type { RoomSnapshot, JoinResponse, CommandResponse } from '../../shared/protocol';

/** Build a valid mono 8 kHz 16-bit PCM WAV of the given length. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), 44 + i * 2);
  return b;
}

let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
const sockets: Socket[] = [];

before(async () => {
  app = await createApp({ store: new MemoryStore() });
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => {
  sockets.forEach((s) => s.close());
  await app.close();
});

const json = async (p: string, init?: RequestInit & { token?: string }) => {
  const res = await fetch(base + p, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}), ...init?.headers },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const client = () => {
  const s = connect(base, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
};
const emitAck = <T>(s: Socket, ev: string, payload?: unknown) => new Promise<T>((res) => s.emit(ev, payload, res));
const waitSnap = (s: Socket, pred: (x: RoomSnapshot) => boolean, ms = 3000) =>
  new Promise<RoomSnapshot>((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for snapshot')), ms);
    const h = (x: RoomSnapshot) => {
      if (pred(x)) {
        clearTimeout(t);
        s.off('snapshot', h);
        res(x);
      }
    };
    s.on('snapshot', h);
  });

test('end-to-end: rooms, roles, scheduled sync, upload validation', async () => {
  // --- auth + room
  const reg = await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'dj@example.com', password: 'hunter2hunter2', displayName: 'DJ Test' }) });
  assert.equal(reg.status, 201);
  const dup = await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'dj@example.com', password: 'hunter2hunter2', displayName: 'x' }) });
  assert.equal(dup.status, 409);
  const bad = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'dj@example.com', password: 'wrongwrong' }) });
  assert.equal(bad.status, 401);

  const created = await json('/api/rooms', { method: 'POST', token: reg.body.token, body: JSON.stringify({ name: 'Party', password: 'letmein' }) });
  assert.equal(created.status, 201);
  const roomId: string = created.body.room.id;
  assert.match(roomId, /^[A-Z2-9]{6}$/);
  assert.equal((await json('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status, 401, 'creating rooms requires login');
  const pub = await json(`/api/rooms/${roomId}`);
  assert.deepEqual(Object.keys(pub.body).sort(), ['adminName', 'id', 'locked', 'name', 'requiresPassword']);
  assert.equal(pub.body.requiresPassword, true);

  // --- upload validation (content-based)
  const upload = async (data: Buffer, filename: string, token: string) => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(data)]), filename);
    const r = await fetch(`${base}/api/rooms/${roomId}/tracks`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as any };
  };
  const fake = await upload(Buffer.from('<?php echo 1; ?> definitely not audio'), 'evil.mp3', created.body.adminToken);
  assert.equal(fake.status, 415, 'a text file renamed .mp3 must be rejected');
  const noAuth = await upload(wav(2), 'a.wav', reg.body.token); // user token ≠ room admin token
  assert.equal(noAuth.status, 403);
  const t1 = await upload(wav(3), 'first.wav', created.body.adminToken);
  assert.equal(t1.status, 201);
  assert.ok(Math.abs(t1.body.track.durationMs - 3000) < 50);
  assert.match(t1.body.track.url, /^\/media\/[0-9a-f-]+\.wav$/);
  const t2 = await upload(wav(3), 'second.wav', created.body.adminToken);
  const media = await fetch(base + t1.body.track.url, { headers: { range: 'bytes=0-99' } });
  assert.equal(media.status, 206, 'media supports Range requests for seeking');

  // --- sockets
  const admin = client();
  const p1 = client();
  const p2 = client();
  const adminRes = await emitAck<JoinResponse>(admin, 'room:join', { roomId, name: 'x', deviceId: 'admin-device-1', adminToken: created.body.adminToken });
  assert.ok(adminRes.ok && adminRes.role === 'admin');

  const noPw = await emitAck<JoinResponse>(p1, 'room:join', { roomId, name: 'Ann', deviceId: 'device-ann-0001' });
  assert.deepEqual(noPw, { ok: false, error: 'bad_password' });
  const forged = await emitAck<JoinResponse>(p1, 'room:join', { roomId, name: 'Ann', deviceId: 'device-ann-0001', adminToken: reg.body.token });
  assert.deepEqual(forged, { ok: false, error: 'bad_admin_token' }, 'a user token is not an admin token');
  const j1 = await emitAck<JoinResponse>(p1, 'room:join', { roomId, name: 'Ann', deviceId: 'device-ann-0001', password: 'letmein' });
  const j2 = await emitAck<JoinResponse>(p2, 'room:join', { roomId, name: 'Bob', deviceId: 'device-bob-0001', password: 'letmein' });
  assert.ok(j1.ok && j1.role === 'participant' && j2.ok);

  // --- participants cannot control playback
  const denied = await emitAck<CommandResponse>(p1, 'admin:cmd', { type: 'play' });
  assert.deepEqual(denied, { ok: false, error: 'forbidden' });

  // --- admin PLAY → every device gets the same track + a *future* start timestamp
  const trackId = t1.body.track.id as string;
  const w1 = waitSnap(p1, (s) => s.playback.status === 'playing');
  const w2 = waitSnap(p2, (s) => s.playback.status === 'playing');
  const before = Date.now();
  assert.deepEqual(await emitAck<CommandResponse>(admin, 'admin:cmd', { type: 'play', trackId }), { ok: true });
  const [s1, s2] = await Promise.all([w1, w2]);
  assert.equal(s1.playback.trackId, trackId);
  assert.deepEqual(s1.playback, s2.playback, 'identical playback state for all devices');
  assert.ok(s1.playback.startAtServerMs >= before + 1400, 'start is scheduled in the future (lead time)');
  assert.ok(s1.serverTime < s1.playback.startAtServerMs);
  assert.equal(positionAt(s1.playback, s1.playback.startAtServerMs - 500), 0, 'position holds at 0 until the start time');
  assert.equal(positionAt(s1.playback, s1.playback.startAtServerMs + 700), 700);
  assert.equal(s1.members.length, 3);

  // --- device reports drive the status shown to the admin
  const report = { driftMs: 5, rttMs: 40, clockOffsetMs: 3, outputLatencyMs: 0, userOffsetMs: 0, outputLabel: 'Default', outputKind: 'default', audioState: 'running', loading: false, correcting: false, trackId, playsAudio: true };
  p1.emit('member:report', report);
  p2.emit('member:report', { ...report, driftMs: 400 });
  const stat = await waitSnap(admin, (s) => s.members.find((m) => m.name === 'Bob')?.status === 'delayed' && s.members.find((m) => m.name === 'Ann')?.status === 'synchronized');
  assert.ok(stat);

  // --- pause keeps position; seek; scheduling validation
  await new Promise((r) => setTimeout(r, 1700)); // pass the start time
  await emitAck(admin, 'admin:cmd', { type: 'pause' });
  const paused = await waitSnap(p1, (s) => s.playback.status === 'paused');
  assert.ok(paused.playback.positionMs >= 100 && paused.playback.positionMs < 1500, `paused at ${paused.playback.positionMs}`);
  assert.deepEqual(await emitAck(admin, 'admin:cmd', { type: 'schedule', startAtServerMs: Date.now() + 10 }), { ok: false, error: 'start_time_too_soon' });
  const future = Date.now() + 5000;
  assert.deepEqual(await emitAck(admin, 'admin:cmd', { type: 'schedule', startAtServerMs: future, trackId }), { ok: true });
  assert.equal((await waitSnap(p2, (s) => s.playback.status === 'playing')).playback.startAtServerMs, future);

  // --- clock ping returns server time
  const t = await new Promise<number>((r) => p1.emit('clock:ping', r));
  assert.ok(Math.abs(t - Date.now()) < 500);

  // --- reconnect: same deviceId resumes, no duplicate member
  p2.disconnect();
  await waitSnap(admin, (s) => s.members.find((m) => m.name === 'Bob')?.connected === false);
  const p2b = client();
  const back = await emitAck<JoinResponse>(p2b, 'room:join', { roomId, name: 'Bob', deviceId: 'device-bob-0001', password: 'letmein' });
  assert.ok(back.ok && back.snapshot.members.filter((m) => m.name === 'Bob').length === 1);
  assert.equal(back.snapshot.playback.trackId, trackId, 'reconnecting device gets current playback state');

  // --- lock room: newcomers refused, known device allowed
  await emitAck(admin, 'admin:cmd', { type: 'lock', locked: true });
  const late = await emitAck<JoinResponse>(client(), 'room:join', { roomId, name: 'Eve', deviceId: 'device-eve-0001', password: 'letmein' });
  assert.deepEqual(late, { ok: false, error: 'room_locked' });

  // --- kick = removed + banned
  const kicked = new Promise((r) => p1.once('kicked', r));
  await emitAck(admin, 'admin:cmd', { type: 'kick', deviceId: 'device-ann-0001' });
  await kicked;
  const again = await emitAck<JoinResponse>(client(), 'room:join', { roomId, name: 'Ann', deviceId: 'device-ann-0001', password: 'letmein' });
  assert.deepEqual(again, { ok: false, error: 'banned' });

  // --- second admin connection replaces the first (only one admin)
  const replaced = new Promise((r) => admin.once('replaced', r));
  const admin2 = client();
  const a2 = await emitAck<JoinResponse>(admin2, 'room:join', { roomId, name: 'x', deviceId: 'admin-device-2', adminToken: created.body.adminToken });
  assert.ok(a2.ok && a2.snapshot.members.filter((m) => m.role === 'admin').length === 1);
  await replaced;
  void t2;
});

test('auto-advance schedules the next track at the end of the current one', async () => {
  const { RoomManager } = await import('../src/rooms');
  let clock = 1_000_000;
  const mgr = new RoomManager(new MemoryStore(), () => clock);
  const room = await mgr.create({ name: 'R', ownerId: 'u', ownerName: 'DJ' });
  const mk = (id: string, durationMs: number) => ({ id, title: id, artist: '', durationMs, url: `/media/${id}.wav`, kind: 'upload' as const });
  await mgr.addTrack(room, mk('a', 10_000));
  await mgr.addTrack(room, mk('b', 10_000));
  await mgr.command(room, { type: 'play', trackId: 'a' });
  const startAt = room.playback.startAtServerMs;
  assert.equal(startAt, clock + room.rec.leadMs);
  // seek while playing re-anchors the timeline
  await mgr.command(room, { type: 'seek', positionMs: 4000 });
  assert.equal(room.playback.positionMs, 4000);
  // next → track b, position 0
  await mgr.command(room, { type: 'next' });
  assert.equal(room.playback.trackId, 'b');
  assert.equal(room.playback.positionMs, 0);
  // prev within first 3s of playback → previous track
  clock += room.rec.leadMs + 1000;
  await mgr.command(room, { type: 'prev' });
  assert.equal(room.playback.trackId, 'a');
  mgr.dispose();
});
