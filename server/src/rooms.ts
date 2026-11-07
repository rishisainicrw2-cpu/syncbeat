import { randomInt, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_NAME,
  SYNC,
  positionAt,
  qualityFromRtt,
  type AdminCommand,
  type CommandResponse,
  type JoinError,
  type MemberInfo,
  type MemberReport,
  type PlaybackState,
  type Role,
  type RoomSnapshot,
  type SyncStatus,
  type Track,
} from '../../shared/protocol';
import { config } from './config';
import type { RoomRecord, Store } from './store';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export const newRoomId = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

export const cleanName = (s: unknown, fallback = 'Guest'): string => {
  const v = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, MAX_NAME);
  return v || fallback;
};

export interface Member {
  deviceId: string;
  name: string;
  role: Role;
  socketId: string | null;
  joinedAt: number;
  lastSeen: number;
  report: MemberReport | null;
  adminOffsetMs: number;
}

export class Room {
  playback: PlaybackState = { status: 'stopped', trackId: null, positionMs: 0, startAtServerMs: 0, version: 0 };
  members = new Map<string, Member>();
  banned = new Set<string>();
  calibration = false;
  timer: NodeJS.Timeout | null = null;
  dirty = false;
  lastActivity = Date.now();
  constructor(
    public rec: RoomRecord,
    public tracks: Track[],
  ) {}
}

export type Notify = (room: Room, immediate: boolean) => void;

export class RoomManager {
  rooms = new Map<string, Room>();
  notify: Notify = () => {};
  onKick: (socketId: string, reason: 'kicked' | 'closed') => void = () => {};
  private sweepTimer: NodeJS.Timeout;

  constructor(
    public store: Store,
    private now: () => number = Date.now,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref();
  }

  dispose() {
    clearInterval(this.sweepTimer);
    for (const r of this.rooms.values()) if (r.timer) clearTimeout(r.timer);
  }

  /* ------------------------------------------------------------ lifecycle */

  async create(opts: { name: string; password?: string; ownerId: string; ownerName: string }): Promise<Room> {
    let id = newRoomId();
    for (let i = 0; i < 10 && (await this.store.getRoom(id)); i++) id = newRoomId();
    const rec: RoomRecord = {
      id,
      name: cleanName(opts.name, 'My room'),
      ownerId: opts.ownerId,
      ownerName: opts.ownerName,
      passwordHash: opts.password ? await bcrypt.hash(opts.password, 10) : null,
      locked: false,
      leadMs: config.defaultLeadMs,
      masterVolume: 1,
      repeat: 'off',
      createdAt: this.now(),
    };
    await this.store.createRoom(rec);
    const room = new Room(rec, []);
    this.rooms.set(id, room);
    return room;
  }

  async get(id: string): Promise<Room | null> {
    id = id.toUpperCase();
    const live = this.rooms.get(id);
    if (live) return live;
    const rec = await this.store.getRoom(id);
    if (!rec) return null;
    const existing = this.rooms.get(id); // lost a race?
    if (existing) return existing;
    const room = new Room(rec, await this.store.listTracks(id));
    this.rooms.set(id, room);
    return room;
  }

  async close(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    for (const m of room.members.values()) if (m.socketId) this.onKick(m.socketId, 'closed');
    this.rooms.delete(room.rec.id);
    for (const t of room.tracks) this.deleteFile(t);
    await this.store.deleteRoom(room.rec.id);
  }

  private deleteFile(t: Track) {
    if (t.kind !== 'upload') return;
    const f = path.join(config.dataDir, 'uploads', path.basename(t.url));
    fs.promises.unlink(f).catch(() => {});
  }

  /* ----------------------------------------------------------- membership */

  async join(
    room: Room,
    p: { deviceId: string; name: string; password?: string; socketId: string; isAdmin: boolean },
  ): Promise<{ ok: true; member: Member; replacedSocket?: string } | { ok: false; error: JoinError }> {
    const now = this.now();
    if (room.banned.has(p.deviceId) && !p.isAdmin) return { ok: false, error: 'banned' };
    const existing = room.members.get(p.deviceId);
    if (!p.isAdmin) {
      if (room.rec.passwordHash && !(existing && existing.role === 'participant')) {
        const ok = p.password ? await bcrypt.compare(p.password, room.rec.passwordHash) : false;
        if (!ok) return { ok: false, error: 'bad_password' };
      }
      if (room.rec.locked && !existing) return { ok: false, error: 'room_locked' };
      if (!existing && room.members.size >= config.maxMembersPerRoom) return { ok: false, error: 'room_full' };
    }

    let replacedSocket: string | undefined;
    if (p.isAdmin) {
      // Only one admin per room: a new admin connection replaces the old one.
      for (const m of room.members.values()) {
        if (m.role === 'admin' && m.deviceId !== p.deviceId) {
          if (m.socketId) replacedSocket = m.socketId;
          room.members.delete(m.deviceId);
        }
      }
      if (existing?.socketId && existing.socketId !== p.socketId) replacedSocket = existing.socketId;
    } else if (existing?.role === 'admin') {
      return { ok: false, error: 'bad_request' };
    }

    const member: Member = existing ?? {
      deviceId: p.deviceId,
      name: p.name,
      role: p.isAdmin ? 'admin' : 'participant',
      socketId: null,
      joinedAt: now,
      lastSeen: now,
      report: null,
      adminOffsetMs: 0,
    };
    member.socketId = p.socketId;
    member.name = p.isAdmin ? room.rec.ownerName : p.name;
    member.lastSeen = now;
    room.members.set(p.deviceId, member);
    room.lastActivity = now;
    this.notify(room, true);
    return { ok: true, member, replacedSocket };
  }

  disconnect(room: Room, deviceId: string, socketId: string) {
    const m = room.members.get(deviceId);
    if (m && m.socketId === socketId) {
      m.socketId = null;
      m.lastSeen = this.now();
      this.notify(room, true);
    }
  }

  leave(room: Room, deviceId: string) {
    if (room.members.get(deviceId)?.role === 'admin') return;
    room.members.delete(deviceId);
    this.notify(room, true);
  }

  report(room: Room, deviceId: string, r: MemberReport) {
    const m = room.members.get(deviceId);
    if (!m) return;
    m.report = r;
    m.lastSeen = this.now();
    room.dirty = true;
    this.notify(room, false);
  }

  /* ------------------------------------------------------------- snapshot */

  private statusOf(room: Room, m: Member, now: number): SyncStatus {
    if (!m.socketId || now - m.lastSeen > SYNC.staleMs) return 'disconnected';
    const r = m.report;
    if (!r) return 'adjusting';
    if (!r.playsAudio) return 'synchronized'; // DJ-only device: nothing to sync
    if (room.playback.status !== 'playing' || room.calibration) {
      return r.audioState === 'running' || r.audioState === 'idle' ? 'synchronized' : 'adjusting';
    }
    if (r.audioState !== 'running') return 'delayed';
    if (r.loading || r.trackId !== room.playback.trackId) return 'adjusting';
    const d = Math.abs(r.driftMs);
    if (d > SYNC.delayedMs) return 'delayed';
    if (r.correcting || d > SYNC.inSyncMs) return 'adjusting';
    return 'synchronized';
  }

  snapshot(room: Room): RoomSnapshot {
    const now = this.now();
    const members: MemberInfo[] = [...room.members.values()]
      .sort((a, b) => (a.role === b.role ? a.joinedAt - b.joinedAt : a.role === 'admin' ? -1 : 1))
      .map((m) => ({
        deviceId: m.deviceId,
        name: m.name,
        role: m.role,
        connected: !!m.socketId,
        status: this.statusOf(room, m, now),
        quality: qualityFromRtt(m.report?.rttMs),
        adminOffsetMs: m.adminOffsetMs,
        report: m.report,
        joinedAt: m.joinedAt,
      }));
    return {
      id: room.rec.id,
      name: room.rec.name,
      adminName: room.rec.ownerName,
      locked: room.rec.locked,
      requiresPassword: !!room.rec.passwordHash,
      leadMs: room.rec.leadMs,
      masterVolume: room.rec.masterVolume,
      repeat: room.rec.repeat,
      calibration: room.calibration,
      tracks: room.tracks,
      playback: room.playback,
      members,
      serverTime: now,
    };
  }

  /* ------------------------------------------------------------ transport */

  private trackById = (room: Room, id: string | null | undefined) => room.tracks.find((t) => t.id === id) ?? null;

  /** Position the shared timeline is at right now, clamped to the track. */
  private currentPosition(room: Room): number {
    const pos = positionAt(room.playback, this.now());
    const dur = this.trackById(room, room.playback.trackId)?.durationMs ?? 0;
    return dur > 0 ? Math.min(pos, dur) : pos;
  }

  private setPlayback(room: Room, p: Omit<PlaybackState, 'version'>) {
    room.playback = { ...p, version: room.playback.version + 1 };
    this.armTimer(room);
    this.notify(room, true);
  }

  private startPlayback(room: Room, trackId: string, positionMs: number, startAt?: number) {
    const lead = room.rec.leadMs;
    this.setPlayback(room, {
      status: 'playing',
      trackId,
      positionMs: Math.max(0, Math.round(positionMs)),
      startAtServerMs: Math.round(startAt ?? this.now() + lead),
    });
  }

  /** Auto-advance: arm a timer shortly before the current track ends so the next start can be scheduled gaplessly. */
  private armTimer(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    const p = room.playback;
    const track = this.trackById(room, p.trackId);
    if (p.status !== 'playing' || !track || track.durationMs <= 0) return;
    const endsAt = p.startAtServerMs + (track.durationMs - p.positionMs);
    const version = p.version;
    const delay = Math.max(0, endsAt - room.rec.leadMs - this.now());
    room.timer = setTimeout(() => {
      room.timer = null;
      if (room.playback.version !== version) return;
      const idx = room.tracks.findIndex((t) => t.id === track.id);
      const mode = room.rec.repeat;
      let next: Track | undefined;
      if (mode === 'one') next = track;
      else if (idx >= 0 && idx + 1 < room.tracks.length) next = room.tracks[idx + 1];
      else if (mode === 'all') next = room.tracks[0];
      const startAt = Math.max(endsAt, this.now() + 300);
      if (next) this.startPlayback(room, next.id, 0, startAt);
      else {
        // Let the last track finish, then stop.
        room.timer = setTimeout(
          () => {
            room.timer = null;
            if (room.playback.version === version) this.setPlayback(room, { status: 'stopped', trackId: track.id, positionMs: 0, startAtServerMs: 0 });
          },
          Math.max(0, endsAt - this.now()),
        );
        room.timer.unref?.();
      }
    }, delay);
    room.timer.unref?.();
  }

  async command(room: Room, cmd: AdminCommand): Promise<CommandResponse> {
    room.lastActivity = this.now();
    const p = room.playback;
    switch (cmd.type) {
      case 'play': {
        const id = cmd.trackId ?? p.trackId ?? room.tracks[0]?.id;
        if (!id || !this.trackById(room, id)) return { ok: false, error: 'no_track' };
        const sameTrack = id === p.trackId;
        const pos = cmd.positionMs ?? (sameTrack && p.status !== 'stopped' ? this.currentPosition(room) : 0);
        this.startPlayback(room, id, pos);
        return { ok: true };
      }
      case 'schedule': {
        const id = cmd.trackId ?? p.trackId ?? room.tracks[0]?.id;
        if (!id || !this.trackById(room, id)) return { ok: false, error: 'no_track' };
        const now = this.now();
        if (cmd.startAtServerMs < now + 500) return { ok: false, error: 'start_time_too_soon' };
        if (cmd.startAtServerMs > now + 24 * 3600_000) return { ok: false, error: 'start_time_too_far' };
        const sameTrack = id === p.trackId;
        const pos = sameTrack && p.status === 'paused' ? p.positionMs : 0;
        this.startPlayback(room, id, pos, cmd.startAtServerMs);
        return { ok: true };
      }
      case 'pause':
        if (p.status !== 'playing') return { ok: true };
        this.setPlayback(room, { status: 'paused', trackId: p.trackId, positionMs: Math.round(this.currentPosition(room)), startAtServerMs: 0 });
        return { ok: true };
      case 'stop':
        this.setPlayback(room, { status: 'stopped', trackId: p.trackId, positionMs: 0, startAtServerMs: 0 });
        return { ok: true };
      case 'seek': {
        if (!p.trackId) return { ok: false, error: 'no_track' };
        const dur = this.trackById(room, p.trackId)?.durationMs ?? 0;
        const pos = Math.max(0, dur > 0 ? Math.min(cmd.positionMs, dur - 100) : cmd.positionMs);
        if (p.status === 'playing') this.startPlayback(room, p.trackId, pos);
        else this.setPlayback(room, { ...p, positionMs: Math.round(pos), startAtServerMs: 0 });
        return { ok: true };
      }
      case 'next':
      case 'prev': {
        if (!room.tracks.length) return { ok: false, error: 'no_track' };
        const idx = room.tracks.findIndex((t) => t.id === p.trackId);
        let target: Track;
        if (cmd.type === 'prev') {
          // Standard player behaviour: restart the track if we're more than 3 s in.
          if (idx >= 0 && this.currentPosition(room) > 3000) target = room.tracks[idx];
          else target = room.tracks[idx > 0 ? idx - 1 : room.rec.repeat === 'all' ? room.tracks.length - 1 : 0];
        } else {
          if (idx + 1 < room.tracks.length) target = room.tracks[idx + 1];
          else if (room.rec.repeat === 'all' || idx < 0) target = room.tracks[0];
          else {
            this.setPlayback(room, { status: 'stopped', trackId: p.trackId, positionMs: 0, startAtServerMs: 0 });
            return { ok: true };
          }
        }
        if (p.status === 'playing') this.startPlayback(room, target.id, 0);
        else this.setPlayback(room, { status: 'paused', trackId: target.id, positionMs: 0, startAtServerMs: 0 });
        return { ok: true };
      }
      case 'lock':
        room.rec.locked = cmd.locked;
        await this.store.updateRoom(room.rec.id, { locked: cmd.locked });
        this.notify(room, true);
        return { ok: true };
      case 'master': {
        const v = Math.max(0, Math.min(1, cmd.volume));
        room.rec.masterVolume = v;
        await this.store.updateRoom(room.rec.id, { masterVolume: v });
        this.notify(room, true);
        return { ok: true };
      }
      case 'lead': {
        const v = Math.round(Math.max(500, Math.min(10_000, cmd.leadMs)));
        room.rec.leadMs = v;
        await this.store.updateRoom(room.rec.id, { leadMs: v });
        this.notify(room, true);
        return { ok: true };
      }
      case 'repeat':
        room.rec.repeat = cmd.mode;
        await this.store.updateRoom(room.rec.id, { repeat: cmd.mode });
        this.armTimer(room);
        this.notify(room, true);
        return { ok: true };
      case 'calibration':
        room.calibration = cmd.on;
        this.notify(room, true);
        return { ok: true };
      case 'setOffset': {
        const m = room.members.get(cmd.deviceId);
        if (!m) return { ok: false, error: 'no_device' };
        m.adminOffsetMs = Math.round(Math.max(-1000, Math.min(2000, cmd.offsetMs)));
        this.notify(room, true);
        return { ok: true };
      }
      case 'kick': {
        const m = room.members.get(cmd.deviceId);
        if (!m || m.role === 'admin') return { ok: false, error: 'no_device' };
        if (m.socketId) {
          room.banned.add(m.deviceId); // only ban devices that were actually connected
          this.onKick(m.socketId, 'kicked');
        }
        room.members.delete(m.deviceId);
        this.notify(room, true);
        return { ok: true };
      }
      case 'reorder': {
        const known = new Set(room.tracks.map((t) => t.id));
        const ids = cmd.trackIds.filter((i) => known.has(i));
        const byId = new Map(room.tracks.map((t) => [t.id, t]));
        const ordered = ids.map((i) => byId.get(i)!);
        room.tracks = [...ordered, ...room.tracks.filter((t) => !ids.includes(t.id))];
        await this.store.reorderTracks(room.rec.id, room.tracks.map((t) => t.id));
        this.notify(room, true);
        return { ok: true };
      }
      case 'removeTrack': {
        const t = this.trackById(room, cmd.trackId);
        if (!t) return { ok: false, error: 'no_track' };
        room.tracks = room.tracks.filter((x) => x.id !== t.id);
        await this.store.removeTrack(room.rec.id, t.id);
        this.deleteFile(t);
        if (p.trackId === t.id) this.setPlayback(room, { status: 'stopped', trackId: null, positionMs: 0, startAtServerMs: 0 });
        else this.notify(room, true);
        return { ok: true };
      }
      case 'addUrl': {
        let u: URL;
        try {
          u = new URL(cmd.url);
        } catch {
          return { ok: false, error: 'bad_url' };
        }
        if (u.protocol !== 'https:') return { ok: false, error: 'https_required' };
        return this.addTrack(room, {
          id: randomUUID(),
          title: cleanName(cmd.title, 'Untitled').slice(0, 120),
          artist: cleanName(cmd.artist, '').slice(0, 120),
          durationMs: Math.max(0, Math.min(Math.round(cmd.durationMs || 0), 4 * 3600_000)),
          url: u.toString(),
          kind: 'url',
        });
      }
      case 'rename': {
        const name = cleanName(cmd.name, room.rec.name);
        room.rec.name = name;
        await this.store.updateRoom(room.rec.id, { name });
        this.notify(room, true);
        return { ok: true };
      }
      case 'setPassword': {
        const hash = cmd.password ? await bcrypt.hash(cmd.password, 10) : null;
        room.rec.passwordHash = hash;
        await this.store.updateRoom(room.rec.id, { passwordHash: hash });
        this.notify(room, true);
        return { ok: true };
      }
      case 'closeRoom':
        await this.close(room);
        return { ok: true };
    }
  }

  async addTrack(room: Room, t: Track): Promise<CommandResponse> {
    if (room.tracks.length >= config.maxTracksPerRoom) return { ok: false, error: 'playlist_full' };
    room.tracks.push(t);
    await this.store.addTrack(room.rec.id, t);
    this.notify(room, true);
    return { ok: true };
  }

  /** Housekeeping: drop long-gone devices and unload idle rooms from memory. */
  sweep() {
    const now = this.now();
    for (const [id, room] of this.rooms) {
      for (const [did, m] of room.members) {
        if (!m.socketId && m.role !== 'admin' && now - m.lastSeen > 3600_000) room.members.delete(did);
      }
      const anyConnected = [...room.members.values()].some((m) => m.socketId);
      if (!anyConnected && now - room.lastActivity > 30 * 60_000) {
        if (room.timer) clearTimeout(room.timer);
        this.rooms.delete(id); // reloaded from the store on next access
      }
    }
  }
}
