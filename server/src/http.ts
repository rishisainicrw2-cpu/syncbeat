import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseFile } from 'music-metadata';
import { config } from './config';
import { requireRoomAdmin, requireUser, signAdmin, signUser, verifyUser } from './auth';
import { cleanName, type RoomManager } from './rooms';
import type { Track } from '../../shared/protocol';

const asyncH =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});
const registerBody = credentials.extend({ displayName: z.string().trim().min(1).max(32) });
const createRoomBody = z.object({
  name: z.string().trim().min(1).max(48),
  password: z.string().min(4).max(64).optional().or(z.literal('')),
});

/** Container → file extension. The *server* picks the extension, never the client filename. */
const EXT_BY_CONTAINER: [RegExp, string][] = [
  [/^MPEG/i, 'mp3'],
  [/^WAVE?$/i, 'wav'],
  [/^FLAC/i, 'flac'],
  [/^Ogg/i, 'ogg'],
  [/^(M4A|mp4|mp42|isom|M4B|iso\d)/i, 'm4a'],
  [/^(EBML|matroska|webm)/i, 'webm'],
];

export function buildApi(mgr: RoomManager) {
  const api = express.Router();
  const uploadsDir = path.join(config.dataDir, 'uploads');
  const tmpDir = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const limiter = (windowMs: number, max: number) =>
    rateLimit({ windowMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false });
  api.use(limiter(15 * 60_000, 600));
  const authLimiter = limiter(15 * 60_000, 30);
  const roomLookupLimiter = limiter(60_000, 40); // slows room-code guessing
  const uploadLimiter = limiter(60_000, 15);

  api.get('/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

  /* ---------------------------------------------------------------- auth */
  api.post(
    '/auth/register',
    authLimiter,
    asyncH(async (req, res) => {
      const b = registerBody.safeParse(req.body);
      if (!b.success) return void res.status(400).json({ error: 'invalid_input', details: b.error.flatten().fieldErrors });
      const user = {
        id: randomUUID(),
        email: b.data.email,
        displayName: cleanName(b.data.displayName),
        passwordHash: await bcrypt.hash(b.data.password, 11),
      };
      if (!(await mgr.store.createUser(user))) return void res.status(409).json({ error: 'email_taken' });
      res.status(201).json({ token: signUser(user.id, user.displayName), user: { id: user.id, displayName: user.displayName, email: user.email } });
    }),
  );

  api.post(
    '/auth/login',
    authLimiter,
    asyncH(async (req, res) => {
      const b = credentials.safeParse(req.body);
      if (!b.success) return void res.status(400).json({ error: 'invalid_input' });
      const u = await mgr.store.findUserByEmail(b.data.email);
      // Compare even on unknown user to keep timing similar.
      const ok = await bcrypt.compare(b.data.password, u?.passwordHash ?? '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
      if (!u || !ok) return void res.status(401).json({ error: 'bad_credentials' });
      res.json({ token: signUser(u.id, u.displayName), user: { id: u.id, displayName: u.displayName, email: u.email } });
    }),
  );

  api.get(
    '/auth/me',
    requireUser,
    asyncH(async (req, res) => {
      const u = await mgr.store.findUserById(req.user!.sub);
      if (!u) return void res.status(401).json({ error: 'unauthorized' });
      res.json({ user: { id: u.id, displayName: u.displayName, email: u.email } });
    }),
  );

  /* --------------------------------------------------------------- rooms */
  api.post(
    '/rooms',
    requireUser,
    asyncH(async (req, res) => {
      const b = createRoomBody.safeParse(req.body);
      if (!b.success) return void res.status(400).json({ error: 'invalid_input' });
      const room = await mgr.create({
        name: b.data.name,
        password: b.data.password || undefined,
        ownerId: req.user!.sub,
        ownerName: req.user!.name,
      });
      res.status(201).json({ room: { id: room.rec.id, name: room.rec.name }, adminToken: signAdmin(req.user!.sub, room.rec.id) });
    }),
  );

  api.get(
    '/rooms/mine',
    requireUser,
    asyncH(async (req, res) => {
      const rooms = await mgr.store.listRoomsByOwner(req.user!.sub);
      res.json({ rooms: rooms.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt })) });
    }),
  );

  /** Public, minimal info used by the Join screen. Never reveals tokens, members or passwords. */
  api.get(
    '/rooms/:id',
    roomLookupLimiter,
    asyncH(async (req, res) => {
      const room = await mgr.get(String(req.params.id));
      if (!room) return void res.status(404).json({ error: 'not_found' });
      res.json({ id: room.rec.id, name: room.rec.name, adminName: room.rec.ownerName, locked: room.rec.locked, requiresPassword: !!room.rec.passwordHash });
    }),
  );

  /** The room's owner can obtain a fresh admin token (e.g. after the 12h token expired). */
  api.post(
    '/rooms/:id/admin-token',
    requireUser,
    asyncH(async (req, res) => {
      const room = await mgr.get(String(req.params.id));
      if (!room || room.rec.ownerId !== req.user!.sub) return void res.status(403).json({ error: 'forbidden' });
      res.json({ adminToken: signAdmin(req.user!.sub, room.rec.id) });
    }),
  );

  /* -------------------------------------------------------------- upload */
  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  });

  api.post(
    '/rooms/:id/tracks',
    uploadLimiter,
    requireRoomAdmin,
    upload.single('file'),
    asyncH(async (req, res) => {
      const file = req.file;
      if (!file) return void res.status(400).json({ error: 'no_file' });
      const discard = () => fs.promises.unlink(file.path).catch(() => {});
      try {
        const room = await mgr.get(String(req.params.id));
        if (!room) return void (await discard(), res.status(404).json({ error: 'not_found' }));
        // Validate by *content*, not by extension or the client-supplied MIME type.
        let meta;
        try {
          meta = await parseFile(file.path, { duration: true });
        } catch {
          return void (await discard(), res.status(415).json({ error: 'not_audio' }));
        }
        const container = meta.format.container ?? '';
        const ext = EXT_BY_CONTAINER.find(([re]) => re.test(container))?.[1];
        const durationMs = Math.round((meta.format.duration ?? 0) * 1000);
        if (!ext || durationMs <= 0 || durationMs > 4 * 3600_000 || !meta.format.codec && !meta.format.container) {
          return void (await discard(), res.status(415).json({ error: 'unsupported_audio', container }));
        }
        const name = `${randomUUID()}.${ext}`;
        await fs.promises.rename(file.path, path.join(uploadsDir, name));
        const base = path.basename(file.originalname || 'Untitled', path.extname(file.originalname || ''));
        const track: Track = {
          id: randomUUID(),
          title: cleanName(meta.common.title || base, 'Untitled').slice(0, 120),
          artist: cleanName(meta.common.artist || '', '').slice(0, 120),
          durationMs,
          url: `/media/${name}`,
          kind: 'upload',
        };
        const r = await mgr.addTrack(room, track);
        if (!r.ok) {
          fs.promises.unlink(path.join(uploadsDir, name)).catch(() => {});
          return void res.status(409).json(r);
        }
        res.status(201).json({ track });
      } catch (e) {
        await discard();
        throw e;
      }
    }),
  );

  api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      return void res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code });
    }
    console.error('[api]', err);
    res.status(500).json({ error: 'server_error' });
  });

  return { api, uploadsDir };
}

export { verifyUser };
