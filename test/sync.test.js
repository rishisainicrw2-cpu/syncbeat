'use strict';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), `syncbeat-test-${process.pid}`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');
const { createApp } = require('../server/index.js');

let ctx, base;
const j = async (method, url, body, token) => {
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
};
const connect = (token) => new Promise((resolve, reject) => {
  const s = ioc(base, { auth: { token }, transports: ['websocket'], reconnection: false });
  s.once('snapshot', (snap) => resolve({ s, snap }));
  s.once('connect_error', reject);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const nextState = (s, pred = () => true) => new Promise((r) => { const h = (st) => { if (pred(st)) { s.off('state', h); r(st); } }; s.on('state', h); });
const upload = async (roomId, token, bytes, name = 'song.mp3') => {
  const fd = new FormData();
  fd.append('durationMs', '5000');
  fd.append('file', new Blob([bytes]), name);
  const r = await fetch(`${base}/api/rooms/${roomId}/tracks`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  return { status: r.status, data: await r.json() };
};

test.before(async () => {
  ctx = createApp();
  await new Promise((r) => ctx.server.listen(0, r));
  base = `http://127.0.0.1:${ctx.server.address().port}`;
});
test.after(async () => { await ctx.close(); ctx.server.close(); });

test('full flow: auth, room, roles, synchronized scheduled playback', async () => {
  // auth
  const reg = await j('POST', '/api/auth/register', { email: 'dj@example.com', password: 'supersecret1', name: 'DJ Test' });
  assert.equal(reg.status, 201);
  assert.equal((await j('POST', '/api/auth/login', { email: 'dj@example.com', password: 'wrong-password' })).status, 401);
  const userToken = reg.data.token;

  // room creation needs login
  assert.equal((await j('POST', '/api/rooms', { name: 'x' })).status, 401);
  const created = await j('POST', '/api/rooms', { name: 'Party', accessCode: 'letmein' }, userToken);
  assert.equal(created.status, 201);
  const id = created.data.room.id;
  assert.match(id, /^[A-Z2-9]{6}$/);

  // join rules
  assert.equal((await j('POST', `/api/rooms/${id}/join`, { name: 'Bob', accessCode: 'nope' })).status, 401);
  const bob = await j('POST', `/api/rooms/${id}/join`, { name: 'Bob', accessCode: 'letmein' });
  const amy = await j('POST', `/api/rooms/${id}/join`, { name: 'Amy', accessCode: 'letmein' });
  assert.equal(bob.status, 200);
  assert.equal(bob.data.role, 'participant');

  // only owner gets admin token
  const other = await j('POST', '/api/auth/register', { email: 'other@example.com', password: 'supersecret2' });
  assert.equal((await j('POST', `/api/rooms/${id}/admin-token`, {}, other.data.token)).status, 403);
  const adm = await j('POST', `/api/rooms/${id}/admin-token`, {}, userToken);
  assert.equal(adm.data.role, 'admin');

  // QR
  const qr = await j('GET', `/api/rooms/${id}/qr`);
  assert.ok(qr.data.dataUrl.startsWith('data:image/png'));

  // uploads: invalid rejected, valid accepted, participant forbidden
  const id3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.alloc(64, 1)]);
  assert.equal((await upload(id, adm.data.token, Buffer.from('<html>not audio at all</html>'), 'evil.mp3')).status, 415);
  assert.equal((await upload(id, bob.data.token, id3)).status, 403);
  const t1 = await upload(id, adm.data.token, id3, 'one.mp3');
  const t2 = await upload(id, adm.data.token, id3, 'two.mp3');
  assert.equal(t1.status, 201);

  // audio: members only
  const audioUrl = `/api/rooms/${id}/tracks/${t1.data.track.id}/audio`;
  const noAuth = await fetch(base + audioUrl);
  assert.equal(noAuth.status, 401);
  const withAuth = await fetch(base + audioUrl, { headers: { authorization: `Bearer ${bob.data.token}` } });
  assert.equal(withAuth.status, 200);

  // sockets
  const A = await connect(adm.data.token);
  const B = await connect(bob.data.token);
  const C = await connect(amy.data.token);
  assert.equal(A.snap.tracks.length, 2);

  // clock sync
  const ping = await emit(B.s, 'clock:ping', 123);
  assert.equal(ping.t0, 123);
  assert.ok(Math.abs(ping.ts - Date.now()) < 1000);

  // participant cannot control
  const denied = await emit(B.s, 'play', {});
  assert.equal(denied.error, 'Admin only');

  // admin plays: everyone gets same state with FUTURE start time
  const pB = nextState(B.s, (x) => x.playback.state === 'playing'); const pC = nextState(C.s, (x) => x.playback.state === 'playing');
  const before = Date.now();
  const ok = await emit(A.s, 'play', { trackId: t1.data.track.id });
  assert.ok(ok.ok);
  const [sB, sC] = await Promise.all([pB, pC]);
  assert.equal(sB.playback.state, 'playing');
  assert.deepEqual(sB.playback, sC.playback);
  assert.equal(sB.playback.trackId, t1.data.track.id);
  assert.ok(sB.playback.startAt >= before + 500, 'start must be scheduled in the future');
  assert.equal(sB.roomId, id);

  // pause captures position; resume keeps it
  await new Promise((r) => setTimeout(r, sB.playback.startAt - Date.now() + 300));
  const pp = nextState(B.s, (x) => x.playback.state === 'paused');
  await emit(A.s, 'pause');
  const paused = await pp;
  assert.equal(paused.playback.state, 'paused');
  assert.ok(paused.playback.basePositionMs >= 200 && paused.playback.basePositionMs < 1500, `pos ${paused.playback.basePositionMs}`);

  // scheduled future play
  const target = Date.now() + 3000;
  const ps = nextState(C.s, (x) => x.playback.state === 'playing');
  await emit(A.s, 'play', { at: target });
  assert.equal((await ps).playback.startAt, target);
  assert.equal((await emit(A.s, 'play', { at: Date.now() - 5000 })).error, 'Scheduled time must be in the future');

  // next/prev
  let st = nextState(B.s, (x) => x.playback.trackId === t2.data.track.id); await emit(A.s, 'next');
  assert.equal((await st).playback.trackId, t2.data.track.id);
  st = nextState(B.s, (x) => x.playback.trackId === t1.data.track.id); await emit(A.s, 'prev');
  assert.equal((await st).playback.trackId, t1.data.track.id);

  // telemetry -> admin devices list with statuses
  const devs = new Promise((r) => A.s.on('devices', (d) => { if (d.some((x) => x.name === 'Bob' && x.driftMs === 120)) r(d); }));
  B.s.emit('report', { driftMs: 120, rttMs: 30, latencyMs: 180, offsetMs: 0, status: 'adjusting', output: 'Test speaker' });
  const list = await devs;
  assert.equal(list.find((x) => x.name === 'Bob').status, 'adjusting');

  // lock room blocks new joiners
  assert.equal((await j('PATCH', `/api/rooms/${id}/settings`, { locked: true }, bob.data.token)).status, 403);
  assert.equal((await j('PATCH', `/api/rooms/${id}/settings`, { locked: true }, adm.data.token)).status, 200);
  assert.equal((await j('POST', `/api/rooms/${id}/join`, { name: 'Late', accessCode: 'letmein' })).status, 403);

  // kick
  const kicked = new Promise((r) => C.s.once('kicked', r));
  const k = await emit(A.s, 'kick', { deviceId: amy.data.deviceId });
  assert.ok(k.ok);
  await kicked;
  assert.equal((await j('POST', `/api/rooms/${id}/join`, { name: 'Amy', deviceId: amy.data.deviceId, accessCode: 'letmein' })).status, 403);

  // forged token rejected on socket
  await assert.rejects(connect('garbage'));

  [A, B, C].forEach((x) => x.s.close());
});
