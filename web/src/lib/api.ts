import { session } from './session';

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function req<T>(path: string, init: RequestInit & { auth?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}) };
  const token = init.auth === undefined ? session.token : init.auth;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'error');
  return data as T;
}

export interface PublicRoom { id: string; name: string; adminName: string; locked: boolean; requiresPassword: boolean }

export const api = {
  register: (email: string, password: string, displayName: string) => req<{ token: string; user: any }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName }) }),
  login: (email: string, password: string) => req<{ token: string; user: any }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  createRoom: (name: string, password?: string) => req<{ room: { id: string; name: string }; adminToken: string }>('/rooms', { method: 'POST', body: JSON.stringify({ name, password }) }),
  myRooms: () => req<{ rooms: { id: string; name: string; createdAt: number }[] }>('/rooms/mine'),
  room: (id: string) => req<PublicRoom>(`/rooms/${encodeURIComponent(id.toUpperCase())}`, { auth: null }),
  adminToken: (id: string) => req<{ adminToken: string }>(`/rooms/${id}/admin-token`, { method: 'POST' }),
  upload: (roomId: string, file: File, adminToken: string) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ track: unknown }>(`/rooms/${roomId}/tracks`, { method: 'POST', body: fd, auth: adminToken });
  },
};

export const errorText = (code: string): string => ({
  invalid_input: 'Please check the details you entered.',
  email_taken: 'That email is already registered.',
  bad_credentials: 'Wrong email or password.',
  unauthorized: 'Please sign in first.',
  not_found: "We couldn't find that room.",
  bad_password: 'Wrong access code.',
  room_locked: 'This room is locked by the DJ.',
  banned: 'You were removed from this room.',
  room_full: 'This room is full.',
  bad_admin_token: 'Your DJ session expired — reopen the room from Create Room.',
  not_audio: "That file isn't valid audio.",
  unsupported_audio: 'Unsupported audio format (use MP3, M4A/AAC, WAV, FLAC or OGG).',
  LIMIT_FILE_SIZE: 'File is too large.',
  playlist_full: 'The playlist is full.',
  rate_limited: 'Too many requests — slow down a moment.',
  kicked: 'The DJ removed you from the room.',
  replaced: 'The DJ opened this room on another device.',
  closed: 'The DJ closed the room.',
}[code] ?? 'Something went wrong. Please try again.');
