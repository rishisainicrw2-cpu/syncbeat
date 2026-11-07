/**
 * SYNCBEAT wire protocol — shared by the server, the web PWA and (as a spec) the Android app.
 *
 * Timeline model
 * --------------
 * The server owns one PlaybackState per room. While status === 'playing', the track position
 * at server time T is:
 *
 *     positionMs + max(0, T - startAtServerMs)
 *
 * i.e. the track is at `positionMs` at the instant `startAtServerMs` (which is normally a
 * *future* server timestamp), and advances in real time afterwards. Every client converts
 * server time to its own clock using an NTP-style offset estimate, so all devices agree on
 * "where in the song we are" without depending on when each one happened to receive a message.
 */

export const MAX_NAME = 32;

export type Role = 'admin' | 'participant';
export type SyncStatus = 'synchronized' | 'adjusting' | 'delayed' | 'disconnected';
export type ConnectionQuality = 'good' | 'fair' | 'poor' | 'unknown';
export type RepeatMode = 'off' | 'all' | 'one';
export type AudioState = 'idle' | 'locked' | 'running' | 'suspended';
export type OutputKind = 'bluetooth' | 'default' | 'unknown';

export interface Track {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  /** Same-origin path for uploads (/media/<uuid>.mp3) or an https URL for linked audio. */
  url: string;
  kind: 'upload' | 'url';
}

export interface PlaybackState {
  status: 'stopped' | 'paused' | 'playing';
  trackId: string | null;
  positionMs: number;
  startAtServerMs: number;
  /** Increments on every transport change; clients restart their audio source when it changes. */
  version: number;
}

/** What a device reports about itself once per second (also serves as heartbeat). */
export interface MemberReport {
  driftMs: number;
  rttMs: number;
  clockOffsetMs: number;
  outputLatencyMs: number;
  userOffsetMs: number;
  outputLabel: string;
  outputKind: OutputKind;
  audioState: AudioState;
  loading: boolean;
  correcting: boolean;
  trackId: string | null;
  playsAudio: boolean;
}

export interface MemberInfo {
  deviceId: string;
  name: string;
  role: Role;
  connected: boolean;
  status: SyncStatus;
  quality: ConnectionQuality;
  adminOffsetMs: number;
  report: MemberReport | null;
  joinedAt: number;
}

export interface RoomSnapshot {
  id: string;
  name: string;
  adminName: string;
  locked: boolean;
  requiresPassword: boolean;
  leadMs: number;
  masterVolume: number;
  repeat: RepeatMode;
  calibration: boolean;
  tracks: Track[];
  playback: PlaybackState;
  members: MemberInfo[];
  serverTime: number;
}

export interface JoinRequest {
  roomId: string;
  name: string;
  deviceId: string;
  password?: string;
  adminToken?: string;
}

export type JoinError =
  | 'not_found'
  | 'bad_password'
  | 'room_locked'
  | 'banned'
  | 'room_full'
  | 'bad_request'
  | 'bad_admin_token'
  | 'rate_limited';

export type JoinResponse =
  | { ok: true; role: Role; deviceId: string; snapshot: RoomSnapshot }
  | { ok: false; error: JoinError };

export type AdminCommand =
  | { type: 'play'; trackId?: string; positionMs?: number }
  | { type: 'schedule'; startAtServerMs: number; trackId?: string }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'seek'; positionMs: number }
  | { type: 'lock'; locked: boolean }
  | { type: 'kick'; deviceId: string }
  | { type: 'master'; volume: number }
  | { type: 'lead'; leadMs: number }
  | { type: 'repeat'; mode: RepeatMode }
  | { type: 'calibration'; on: boolean }
  | { type: 'setOffset'; deviceId: string; offsetMs: number }
  | { type: 'reorder'; trackIds: string[] }
  | { type: 'removeTrack'; trackId: string }
  | { type: 'addUrl'; title: string; artist: string; url: string; durationMs: number }
  | { type: 'rename'; name: string }
  | { type: 'setPassword'; password: string | null }
  | { type: 'closeRoom' };

export type CommandResponse = { ok: true } | { ok: false; error: string };

/** Position of the shared timeline at a given server time. */
export function positionAt(s: PlaybackState, serverNow: number): number {
  if (s.status !== 'playing') return s.positionMs;
  return s.positionMs + Math.max(0, serverNow - s.startAtServerMs);
}

export function qualityFromRtt(rttMs: number | undefined | null): ConnectionQuality {
  if (rttMs == null || !isFinite(rttMs) || rttMs <= 0) return 'unknown';
  if (rttMs < 100) return 'good';
  if (rttMs < 250) return 'fair';
  return 'poor';
}

/** Drift thresholds (ms) shared by server status derivation and the client engine. */
export const SYNC = {
  /** Below this, a device is considered synchronized. */
  inSyncMs: 30,
  /** Above this, the engine hard-resyncs (restarts the source at the right position). */
  hardResyncMs: 120,
  /** Above this, a device is shown as "Delayed". */
  delayedMs: 150,
  /** No report for this long ⇒ Disconnected. */
  staleMs: 10_000,
} as const;
