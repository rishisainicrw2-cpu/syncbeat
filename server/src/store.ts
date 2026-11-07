import pg from 'pg';
import type { RepeatMode, Track } from '../../shared/protocol';
import { SCHEMA_SQL } from './schema';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
}

export interface RoomRecord {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  passwordHash: string | null;
  locked: boolean;
  leadMs: number;
  masterVolume: number;
  repeat: RepeatMode;
  createdAt: number;
}

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;
  createUser(u: UserRecord): Promise<boolean>; // false if email exists
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  createRoom(r: RoomRecord): Promise<void>;
  getRoom(id: string): Promise<RoomRecord | null>;
  updateRoom(id: string, patch: Partial<Omit<RoomRecord, 'id' | 'ownerId' | 'createdAt'>>): Promise<void>;
  deleteRoom(id: string): Promise<void>;
  listRoomsByOwner(ownerId: string): Promise<RoomRecord[]>;
  listTracks(roomId: string): Promise<Track[]>;
  addTrack(roomId: string, t: Track): Promise<void>;
  removeTrack(roomId: string, trackId: string): Promise<void>;
  reorderTracks(roomId: string, ids: string[]): Promise<void>;
}

/* ------------------------------------------------------------------ memory */

export class MemoryStore implements Store {
  private users = new Map<string, UserRecord>();
  private rooms = new Map<string, RoomRecord>();
  private tracks = new Map<string, Track[]>();

  async init() {}
  async close() {}
  async createUser(u: UserRecord) {
    for (const x of this.users.values()) if (x.email === u.email) return false;
    this.users.set(u.id, u);
    return true;
  }
  async findUserByEmail(email: string) {
    for (const x of this.users.values()) if (x.email === email) return x;
    return null;
  }
  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }
  async createRoom(r: RoomRecord) {
    this.rooms.set(r.id, { ...r });
    this.tracks.set(r.id, []);
  }
  async getRoom(id: string) {
    const r = this.rooms.get(id);
    return r ? { ...r } : null;
  }
  async updateRoom(id: string, patch: Partial<RoomRecord>) {
    const r = this.rooms.get(id);
    if (r) Object.assign(r, patch);
  }
  async deleteRoom(id: string) {
    this.rooms.delete(id);
    this.tracks.delete(id);
  }
  async listRoomsByOwner(ownerId: string) {
    return [...this.rooms.values()].filter((r) => r.ownerId === ownerId).map((r) => ({ ...r }));
  }
  async listTracks(roomId: string) {
    return (this.tracks.get(roomId) ?? []).map((t) => ({ ...t }));
  }
  async addTrack(roomId: string, t: Track) {
    const list = this.tracks.get(roomId);
    if (list) list.push({ ...t });
  }
  async removeTrack(roomId: string, trackId: string) {
    const list = this.tracks.get(roomId);
    if (list)
      this.tracks.set(
        roomId,
        list.filter((t) => t.id !== trackId),
      );
  }
  async reorderTracks(roomId: string, ids: string[]) {
    const list = this.tracks.get(roomId);
    if (!list) return;
    const byId = new Map(list.map((t) => [t.id, t]));
    const ordered = ids.map((i) => byId.get(i)).filter((t): t is Track => !!t);
    const rest = list.filter((t) => !ids.includes(t.id));
    this.tracks.set(roomId, [...ordered, ...rest]);
  }
}

/* ---------------------------------------------------------------- postgres */

export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  async init() {
    await this.pool.query(SCHEMA_SQL);
  }
  async close() {
    await this.pool.end();
  }

  private static user(r: any): UserRecord {
    return { id: r.id, email: r.email, displayName: r.display_name, passwordHash: r.password_hash };
  }
  private static room(r: any): RoomRecord {
    return {
      id: r.id,
      name: r.name,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      passwordHash: r.password_hash,
      locked: r.locked,
      leadMs: r.lead_ms,
      masterVolume: r.master_volume,
      repeat: r.repeat_mode,
      createdAt: new Date(r.created_at).getTime(),
    };
  }

  async createUser(u: UserRecord) {
    const res = await this.pool.query(
      'INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING',
      [u.id, u.email, u.displayName, u.passwordHash],
    );
    return (res.rowCount ?? 0) > 0;
  }
  async findUserByEmail(email: string) {
    const r = await this.pool.query('SELECT * FROM users WHERE email=$1', [email]);
    return r.rows[0] ? PgStore.user(r.rows[0]) : null;
  }
  async findUserById(id: string) {
    const r = await this.pool.query('SELECT * FROM users WHERE id=$1', [id]);
    return r.rows[0] ? PgStore.user(r.rows[0]) : null;
  }
  async createRoom(r: RoomRecord) {
    await this.pool.query(
      `INSERT INTO rooms (id,name,owner_id,owner_name,password_hash,locked,lead_ms,master_volume,repeat_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.id, r.name, r.ownerId, r.ownerName, r.passwordHash, r.locked, r.leadMs, r.masterVolume, r.repeat],
    );
  }
  async getRoom(id: string) {
    const r = await this.pool.query('SELECT * FROM rooms WHERE id=$1', [id]);
    return r.rows[0] ? PgStore.room(r.rows[0]) : null;
  }
  async updateRoom(id: string, patch: Partial<RoomRecord>) {
    const map: Record<string, string> = {
      name: 'name',
      ownerName: 'owner_name',
      passwordHash: 'password_hash',
      locked: 'locked',
      leadMs: 'lead_ms',
      masterVolume: 'master_volume',
      repeat: 'repeat_mode',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k]) continue;
      vals.push(v);
      sets.push(`${map[k]}=$${vals.length}`);
    }
    if (!sets.length) return;
    vals.push(id);
    await this.pool.query(`UPDATE rooms SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  }
  async deleteRoom(id: string) {
    await this.pool.query('DELETE FROM rooms WHERE id=$1', [id]);
  }
  async listRoomsByOwner(ownerId: string) {
    const r = await this.pool.query('SELECT * FROM rooms WHERE owner_id=$1 ORDER BY created_at DESC', [ownerId]);
    return r.rows.map(PgStore.room);
  }
  async listTracks(roomId: string) {
    const r = await this.pool.query('SELECT * FROM tracks WHERE room_id=$1 ORDER BY position, created_at', [roomId]);
    return r.rows.map(
      (x): Track => ({
        id: x.id,
        title: x.title,
        artist: x.artist,
        durationMs: x.duration_ms,
        url: x.url,
        kind: x.kind,
      }),
    );
  }
  async addTrack(roomId: string, t: Track) {
    await this.pool.query(
      `INSERT INTO tracks (id,room_id,position,title,artist,duration_ms,url,kind)
       VALUES ($1,$2,COALESCE((SELECT MAX(position)+1 FROM tracks WHERE room_id=$2),0),$3,$4,$5,$6,$7)`,
      [t.id, roomId, t.title, t.artist, t.durationMs, t.url, t.kind],
    );
  }
  async removeTrack(roomId: string, trackId: string) {
    await this.pool.query('DELETE FROM tracks WHERE room_id=$1 AND id=$2', [roomId, trackId]);
  }
  async reorderTracks(roomId: string, ids: string[]) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      for (let i = 0; i < ids.length; i++) {
        await c.query('UPDATE tracks SET position=$1 WHERE room_id=$2 AND id=$3', [i, roomId, ids[i]]);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}

export function createStore(databaseUrl: string): Store {
  return databaseUrl ? new PgStore(databaseUrl) : new MemoryStore();
}
