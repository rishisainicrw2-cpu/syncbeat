'use strict';
/**
 * SYNCBEAT server
 * - Express REST API (auth, rooms, uploads, audio streaming)
 * - Socket.IO realtime layer (clock sync, server-authoritative playback state)
 * Storage in this MVP is in-memory (see docs/schema.sql for the PostgreSQL schema to persist it).
 */
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PROD = process.env.NODE_ENV === 'production';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const MAX_TRACKS = Number(process.env.MAX_TRACKS_PER_ROOM || 50);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_HOURS || 24) * 3600 * 1000;
const DEFAULT_LEAD_MS = Number(process.env.START_LEAD_MS || 1500);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (PROD) throw new Error('JWT_SECRET must be set in production');
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[syncbeat] JWT_SECRET not set - using a random dev secret (sessions reset on restart).');
}

const now = () => Date.now();
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const cleanStr = (v, max = 60) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');

function createApp() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // ---------- in-memory stores ----------
  const users = new Map(); // email -> {id,email,name,hash}
  const rooms = new Map(); // id -> room

  function newRoomId() {
    for (;;) {
      let id = '';
      for (let i = 0; i < 6; i++) id += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
      if (!rooms.has(id)) return id;
    }
  }

  // ---------- app ----------
  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined,
    maxHttpBufferSize: 1e5,
    pingInterval: 5000,
    pingTimeout: 8000,
  });

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'upgrade-insecure-requests': PROD ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  if (process.env.CORS_ORIGIN) app.use('/api', cors({ origin: process.env.CORS_ORIGIN.split(',') }));
  app.use(express.json({ limit: '20kb' }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN || 600), standardHeaders: true, legacyHeaders: false }));
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: Number(process.env.AUTH_RATE_LIMIT || 30), standardHeaders: true, legacyHeaders: false });
  const joinLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.JOIN_RATE_LIMIT || 30), standardHeaders: true, legacyHeaders: false });

  // ---------- helpers ----------
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const fail = (res, code, msg) => res.status(code).json({ error: msg });

  function signUser(u) { return jwt.sign({ typ: 'user', uid: u.id, name: u.name }, JWT_SECRET, { expiresIn: '7d' }); }
  function signRoom(room, did, role, name) {
    return jwt.sign({ typ: 'room', rid: room.id, did, role, name }, JWT_SECRET, { expiresIn: '12h' });
  }
  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
  }
  function verify(token, typ) {
    try { const p = jwt.verify(token, JWT_SECRET); return p.typ === typ ? p : null; } catch (_) { return null; }
  }
  function requireUser(req, res, next) {
    const p = verify(bearer(req), 'user');
    if (!p) return fail(res, 401, 'Login required');
    req.user = p; next();
  }
  function roomAuth(req, res, next) {
    const p = verify(bearer(req), 'room');
    const room = p && rooms.get(p.rid);
    if (!p || !room || room.id !== req.params.id) return fail(res, 401, 'Not a member of this room');
    if (room.banned.has(p.did)) return fail(res, 403, 'You were removed from this room');
    req.room = room; req.member = p; next();
  }
  function adminOnly(req, res, next) {
    if (req.member.role !== 'admin') return fail(res, 403, 'Admin only');
    next();
  }

  const publicTrack = (t) => ({ id: t.id, title: t.title, artist: t.artist, durationMs: t.durationMs, size: t.size });
  const publicRoom = (r) => ({ id: r.id, name: r.name, adminName: r.adminName, locked: r.locked, requiresCode: !!r.accessHash });

  function playbackPosition(pb, t = now()) {
    if (pb.state !== 'playing') return pb.basePositionMs;
    return pb.basePositionMs + Math.max(0, t - pb.startAt);
  }
  function statePayload(room) {
    const tr = room.tracks.find((t) => t.id === room.playback.trackId);
    return {
      roomId: room.id,
      playback: { ...room.playback },
      positionMs: playbackPosition(room.playback),
      track: tr ? publicTrack(tr) : null,
      masterVolume: room.masterVolume,
      serverTime: now(),
    };
  }
  function snapshot(room) {
    return { room: publicRoom(room), state: statePayload(room), tracks: room.tracks.map(publicTrack), devices: deviceList(room) };
  }
  function deviceStatus(d) {
    if (!d.connected) return 'disconnected';
    if (d.status === 'delayed' || Math.abs(d.driftMs) > 150) return 'delayed';
    if (d.status === 'adjusting' || Math.abs(d.driftMs) > 40) return 'adjusting';
    return 'synchronized';
  }
  function deviceList(room) {
    return [...room.devices.values()].map((d) => ({
      id: d.id, name: d.name, role: d.role, connected: d.connected, status: deviceStatus(d),
      driftMs: Math.round(d.driftMs), rttMs: Math.round(d.rttMs), latencyMs: Math.round(d.latencyMs),
      offsetMs: Math.round(d.offsetMs), output: d.output, joinedAt: d.joinedAt,
    }));
  }
  function broadcastState(room) { io.to(room.id).emit('state', statePayload(room)); }
  function broadcastTracks(room) { io.to(room.id).emit('tracks', room.tracks.map(publicTrack)); }
  function pushDevices(room) {
    room.devicesDirty = false;
    for (const d of room.devices.values()) {
      if (d.role === 'admin' && d.socketId) io.to(d.socketId).emit('devices', deviceList(room));
    }
  }
  function markDevices(room) {
    if (room.devicesDirty) return;
    room.devicesDirty = true;
    setTimeout(() => pushDevices(room), 700);
  }

  // ---------- playback control (server-authoritative) ----------
  function currentIndex(room) { return room.tracks.findIndex((t) => t.id === room.playback.trackId); }

  function scheduleEnd(room) {
    clearTimeout(room.endTimer);
    const pb = room.playback;
    if (pb.state !== 'playing') return;
    const tr = room.tracks.find((t) => t.id === pb.trackId);
    if (!tr || !tr.durationMs) return;
    const endAt = pb.startAt + (tr.durationMs - pb.basePositionMs);
    const delay = clamp(endAt - now(), 0, 2 ** 31 - 1);
    room.endTimer = setTimeout(() => {
      if (room.playback.version !== pb.version) return;
      const idx = currentIndex(room);
      if (idx >= 0 && idx < room.tracks.length - 1) startPlayback(room, { trackId: room.tracks[idx + 1].id, positionMs: 0 });
      else stopPlayback(room);
    }, delay + 50);
  }

  function startPlayback(room, { trackId, positionMs, delayMs, at } = {}) {
    const pb = room.playback;
    let id = trackId || pb.trackId || (room.tracks[0] && room.tracks[0].id);
    const tr = room.tracks.find((t) => t.id === id);
    if (!tr) return { error: 'No track to play' };
    let base;
    if (positionMs != null) base = clamp(num(positionMs), 0, tr.durationMs || 2 ** 31);
    else if (id === pb.trackId && pb.state !== 'stopped') base = pb.basePositionMs; // resume from pause
    else base = 0;
    let startAt;
    if (at != null) {
      startAt = num(at);
      if (startAt < now() + 300) return { error: 'Scheduled time must be in the future' };
      if (startAt > now() + 24 * 3600 * 1000) return { error: 'Scheduled time too far ahead (max 24h)' };
    } else {
      startAt = now() + clamp(num(delayMs, DEFAULT_LEAD_MS), 500, 10_000);
    }
    room.playback = { state: 'playing', trackId: id, basePositionMs: base, startAt, version: pb.version + 1 };
    scheduleEnd(room);
    broadcastState(room);
    return { ok: true };
  }
  function pausePlayback(room) {
    const pb = room.playback;
    if (pb.state !== 'playing') return;
    clearTimeout(room.endTimer);
    room.playback = { ...pb, state: 'paused', basePositionMs: playbackPosition(pb), version: pb.version + 1 };
    broadcastState(room);
  }
  function stopPlayback(room) {
    clearTimeout(room.endTimer);
    room.playback = { ...room.playback, state: 'stopped', basePositionMs: 0, version: room.playback.version + 1 };
    broadcastState(room);
  }
  function skip(room, dir) {
    if (!room.tracks.length) return { error: 'Playlist is empty' };
    let idx = currentIndex(room);
    if (idx < 0) idx = dir > 0 ? -1 : room.tracks.length;
    const next = clamp(idx + dir, 0, room.tracks.length - 1);
    return startPlayback(room, { trackId: room.tracks[next].id, positionMs: 0 });
  }

  // ---------- REST: auth ----------
  const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e);
  app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
    const email = cleanStr(req.body.email, 120).toLowerCase();
    const name = cleanStr(req.body.name, 40) || 'DJ';
    const password = String(req.body.password || '');
    if (!emailOk(email)) return fail(res, 400, 'Valid email required');
    if (password.length < 8 || password.length > 128) return fail(res, 400, 'Password must be 8-128 characters');
    if (users.has(email)) return fail(res, 409, 'Account already exists');
    const u = { id: uid(8), email, name, hash: await bcrypt.hash(password, 10) };
    users.set(email, u);
    res.status(201).json({ token: signUser(u), user: { id: u.id, name: u.name, email } });
  }));
  app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
    const email = cleanStr(req.body.email, 120).toLowerCase();
    const u = users.get(email);
    const ok = u && (await bcrypt.compare(String(req.body.password || ''), u.hash));
    if (!ok) return fail(res, 401, 'Invalid email or password');
    res.json({ token: signUser(u), user: { id: u.id, name: u.name, email } });
  }));

  // ---------- REST: rooms ----------
  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
  app.get('/api/time', (_req, res) => res.json({ ts: now() }));

  app.post('/api/rooms', requireUser, wrap(async (req, res) => {
    const name = cleanStr(req.body.name, 50);
    if (!name) return fail(res, 400, 'Room name required');
    const code = cleanStr(req.body.accessCode, 64);
    const room = {
      id: newRoomId(), name, adminUserId: req.user.uid, adminName: req.user.name,
      accessHash: code ? await bcrypt.hash(code, 8) : null,
      locked: false, createdAt: now(), lastActive: now(), masterVolume: 1,
      tracks: [], devices: new Map(), banned: new Set(), devicesDirty: false,
      playback: { state: 'stopped', trackId: null, basePositionMs: 0, startAt: 0, version: 0 },
      endTimer: null,
    };
    rooms.set(room.id, room);
    res.status(201).json({ room: publicRoom(room) });
  }));

  app.get('/api/rooms/:id/public', (req, res) => {
    const room = rooms.get(String(req.params.id).toUpperCase());
    if (!room) return fail(res, 404, 'Room not found');
    res.json({ room: publicRoom(room) });
  });

  app.get('/api/rooms/:id/qr', wrap(async (req, res) => {
    const room = rooms.get(String(req.params.id).toUpperCase());
    if (!room) return fail(res, 404, 'Room not found');
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const url = `${base}/?room=${room.id}`;
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: '#0b0b12', light: '#ffffff' } });
    res.json({ url, dataUrl });
  }));

  // Owner obtains an admin room token
  app.post('/api/rooms/:id/admin-token', requireUser, (req, res) => {
    const room = rooms.get(String(req.params.id).toUpperCase());
    if (!room) return fail(res, 404, 'Room not found');
    if (room.adminUserId !== req.user.uid) return fail(res, 403, 'Only the room owner can be admin');
    const did = cleanStr(req.body.deviceId, 40) || uid(6);
    const name = cleanStr(req.body.name, 40) || req.user.name;
    res.json({ token: signRoom(room, did, 'admin', name), role: 'admin', deviceId: did, name });
  });

  // Participants join
  app.post('/api/rooms/:id/join', joinLimiter, wrap(async (req, res) => {
    const room = rooms.get(String(req.params.id).toUpperCase());
    if (!room) return fail(res, 404, 'Room not found');
    const name = cleanStr(req.body.name, 30);
    if (!name) return fail(res, 400, 'Display name required');
    const did = /^[a-f0-9]{8,40}$/.test(String(req.body.deviceId || '')) ? req.body.deviceId : uid(6);
    if (room.banned.has(did)) return fail(res, 403, 'You were removed from this room');
    const known = room.devices.has(did);
    if (room.locked && !known) return fail(res, 403, 'Room is locked');
    if (room.accessHash && !known) {
      const ok = await bcrypt.compare(String(req.body.accessCode || ''), room.accessHash);
      if (!ok) return fail(res, 401, 'Wrong access code');
    }
    if (room.devices.size >= 50) return fail(res, 429, 'Room is full');
    res.json({ token: signRoom(room, did, 'participant', name), role: 'participant', deviceId: did, name, room: publicRoom(room) });
  }));

  app.get('/api/rooms/:id/snapshot', roomAuth, (req, res) => res.json(snapshot(req.room)));

  app.patch('/api/rooms/:id/settings', roomAuth, adminOnly, wrap(async (req, res) => {
    const room = req.room;
    if (req.body.name != null) { const n = cleanStr(req.body.name, 50); if (n) room.name = n; }
    if (req.body.locked != null) room.locked = !!req.body.locked;
    if (req.body.accessCode != null) {
      const c = cleanStr(req.body.accessCode, 64);
      room.accessHash = c ? await bcrypt.hash(c, 8) : null;
    }
    io.to(room.id).emit('room', publicRoom(room));
    res.json({ room: publicRoom(room) });
  }));

  // ---------- REST: tracks ----------
  function sniff(buf) {
    if (buf.length < 12) return null;
    const s4 = buf.toString('latin1', 0, 4);
    if (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
    if (s4 === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
    if (s4 === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
    if (s4 === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
    if (buf.toString('latin1', 4, 8) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
    return null;
  }
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_r, _f, cb) => cb(null, UPLOAD_DIR),
      filename: (_r, _f, cb) => cb(null, `tmp_${uid(10)}`),
    }),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  });
  const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  app.post('/api/rooms/:id/tracks', uploadLimiter, roomAuth, adminOnly, upload.single('file'), wrap(async (req, res) => {
    const room = req.room;
    const f = req.file;
    if (!f) return fail(res, 400, 'No file uploaded');
    const drop = () => fs.unlink(f.path, () => {});
    if (room.tracks.length >= MAX_TRACKS) { drop(); return fail(res, 400, 'Playlist is full'); }
    const fd = await fs.promises.open(f.path, 'r');
    const head = Buffer.alloc(16);
    await fd.read(head, 0, 16, 0);
    await fd.close();
    const kind = sniff(head);
    if (!kind) { drop(); return fail(res, 415, 'Unsupported or invalid audio file (mp3, wav, ogg, flac, m4a)'); }
    const id = uid(6);
    const finalName = `${room.id}_${id}.${kind.ext}`;
    await fs.promises.rename(f.path, path.join(UPLOAD_DIR, finalName));
    const base = cleanStr(path.parse(f.originalname || 'Untitled').name, 80) || 'Untitled';
    const track = {
      id, title: cleanStr(req.body.title, 80) || base, artist: cleanStr(req.body.artist, 60) || 'Unknown artist',
      durationMs: clamp(Math.round(num(req.body.durationMs)), 0, 6 * 3600 * 1000),
      file: finalName, mime: kind.mime, size: f.size,
    };
    room.tracks.push(track);
    broadcastTracks(room);
    res.status(201).json({ track: publicTrack(track) });
  }));

  function removeTrackFile(t) { fs.unlink(path.join(UPLOAD_DIR, t.file), () => {}); }

  app.delete('/api/rooms/:id/tracks/:tid', roomAuth, adminOnly, (req, res) => {
    const room = req.room;
    const i = room.tracks.findIndex((t) => t.id === req.params.tid);
    if (i < 0) return fail(res, 404, 'Track not found');
    const wasCurrent = room.playback.trackId === req.params.tid;
    const [t] = room.tracks.splice(i, 1);
    removeTrackFile(t);
    if (wasCurrent) {
      clearTimeout(room.endTimer);
      room.playback = { state: 'stopped', trackId: null, basePositionMs: 0, startAt: 0, version: room.playback.version + 1 };
      broadcastState(room);
    }
    broadcastTracks(room);
    res.json({ ok: true });
  });

  app.put('/api/rooms/:id/tracks/order', roomAuth, adminOnly, (req, res) => {
    const room = req.room;
    const order = Array.isArray(req.body.order) ? req.body.order.map(String) : [];
    if (order.length !== room.tracks.length || new Set(order).size !== order.length) return fail(res, 400, 'Order must list every track once');
    const map = new Map(room.tracks.map((t) => [t.id, t]));
    if (!order.every((id) => map.has(id))) return fail(res, 400, 'Unknown track id');
    room.tracks = order.map((id) => map.get(id));
    broadcastTracks(room);
    res.json({ ok: true });
  });

  // Audio streaming (members only; Range supported by sendFile)
  app.get('/api/rooms/:id/tracks/:tid/audio', roomAuth, (req, res) => {
    const t = req.room.tracks.find((x) => x.id === req.params.tid);
    if (!t) return fail(res, 404, 'Track not found');
    res.set('Cache-Control', 'private, max-age=3600');
    res.type(t.mime);
    res.sendFile(path.join(UPLOAD_DIR, t.file));
  });

  // ---------- static PWA ----------
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { maxAge: PROD ? '1h' : 0, index: 'index.html' }));
  app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile(path.join(pub, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return fail(res, 413, `File too large (max ${MAX_UPLOAD_MB} MB)`);
    if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'Bad JSON');
    console.error('[syncbeat]', err);
    fail(res, 500, 'Server error');
  });

  // ---------- Socket.IO ----------
  io.use((socket, next) => {
    const p = verify(socket.handshake.auth && socket.handshake.auth.token, 'room');
    const room = p && rooms.get(p.rid);
    if (!p || !room) return next(new Error('unauthorized'));
    if (room.banned.has(p.did)) return next(new Error('removed'));
    socket.data = { rid: p.rid, did: p.did, role: p.role, name: p.name };
    next();
  });

  io.on('connection', (socket) => {
    const { rid, did, role, name } = socket.data;
    const room = rooms.get(rid);
    if (!room) return socket.disconnect(true);
    socket.join(rid);
    room.lastActive = now();

    let dev = room.devices.get(did);
    if (dev && dev.socketId && dev.socketId !== socket.id) io.sockets.sockets.get(dev.socketId)?.disconnect(true);
    if (!dev) {
      dev = { id: did, name, role, joinedAt: now(), driftMs: 0, rttMs: 0, latencyMs: 0, offsetMs: 0, output: null, status: 'synchronized' };
      room.devices.set(did, dev);
    }
    Object.assign(dev, { name, role, socketId: socket.id, connected: true, lastSeen: now() });
    socket.emit('snapshot', snapshot(room));
    markDevices(room);

    const isAdmin = () => role === 'admin' && room.devices.get(did) && !room.banned.has(did);
    const guard = (fn) => (payload, ack) => {
      if (!isAdmin()) return typeof ack === 'function' && ack({ error: 'Admin only' });
      room.lastActive = now();
      const r = fn(payload || {}) || { ok: true };
      if (typeof ack === 'function') ack(r);
    };

    // NTP-style clock sync: client sends its t0, server returns ts. Client computes offset.
    socket.on('clock:ping', (t0, ack) => { if (typeof ack === 'function') ack({ t0, ts: now() }); });

    socket.on('play', guard((p) => startPlayback(room, p)));
    socket.on('pause', guard(() => { pausePlayback(room); }));
    socket.on('stop', guard(() => { stopPlayback(room); }));
    socket.on('next', guard(() => skip(room, +1)));
    socket.on('prev', guard(() => skip(room, -1)));
    socket.on('seek', guard((p) => {
      const pb = room.playback;
      if (!pb.trackId) return { error: 'Nothing loaded' };
      if (pb.state === 'playing') return startPlayback(room, { trackId: pb.trackId, positionMs: num(p.positionMs) });
      room.playback = { ...pb, basePositionMs: Math.max(0, num(p.positionMs)), version: pb.version + 1 };
      broadcastState(room);
    }));
    socket.on('master:volume', guard((p) => { room.masterVolume = clamp(num(p.volume, 1), 0, 1); broadcastState(room); }));
    socket.on('kick', guard((p) => {
      const target = room.devices.get(String(p.deviceId));
      if (!target || target.role === 'admin') return { error: 'Cannot remove this device' };
      room.banned.add(target.id);
      room.devices.delete(target.id);
      if (target.socketId) {
        const s = io.sockets.sockets.get(target.socketId);
        if (s) { s.emit('kicked'); s.disconnect(true); }
      }
      pushDevices(room);
    }));
    socket.on('forget', guard((p) => { // remove a disconnected device from the list without banning
      const target = room.devices.get(String(p.deviceId));
      if (target && !target.connected) { room.devices.delete(target.id); pushDevices(room); }
    }));
    socket.on('resync:all', guard(() => { // re-broadcast authoritative state; clients hard-resync
      room.playback = { ...room.playback, version: room.playback.version + 1 };
      broadcastState(room);
    }));

    // Participant telemetry
    socket.on('report', (p) => {
      if (!p || typeof p !== 'object') return;
      const d = room.devices.get(did);
      if (!d) return;
      d.driftMs = clamp(num(p.driftMs), -60_000, 60_000);
      d.rttMs = clamp(num(p.rttMs), 0, 60_000);
      d.latencyMs = clamp(num(p.latencyMs), 0, 5_000);
      d.offsetMs = clamp(num(p.offsetMs), -2_000, 2_000);
      d.status = ['synchronized', 'adjusting', 'delayed'].includes(p.status) ? p.status : 'synchronized';
      d.output = p.output ? cleanStr(p.output, 80) : null;
      d.lastSeen = now();
      markDevices(room);
    });

    socket.on('disconnect', () => {
      const d = room.devices.get(did);
      if (d && d.socketId === socket.id) { d.connected = false; d.socketId = null; markDevices(room); }
    });
  });

  // Housekeeping: drop idle rooms (and their files)
  const sweeper = setInterval(() => {
    for (const [id, r] of rooms) {
      const anyone = [...r.devices.values()].some((d) => d.connected);
      if (!anyone && now() - r.lastActive > ROOM_TTL_MS) {
        clearTimeout(r.endTimer);
        r.tracks.forEach(removeTrackFile);
        rooms.delete(id);
      }
    }
  }, 10 * 60_000);
  sweeper.unref();

  return { app, server, io, rooms, close: () => new Promise((r) => { clearInterval(sweeper); io.close(); r(); }) };
}

if (require.main === module) {
  const { server } = createApp();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`[syncbeat] listening on :${port}`));
}

module.exports = { createApp };
