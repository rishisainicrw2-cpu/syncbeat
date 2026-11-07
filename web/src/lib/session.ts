// Small localStorage helpers. Everything is wrapped: storage can be blocked or empty (private mode).
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };
const sget = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const sset = (k: string, v: string | null) => { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* ignore */ } };

export interface User { id: string; displayName: string; email: string }

export const session = {
  get token() { return get('syncbeat.token'); },
  get user(): User | null { try { return JSON.parse(get('syncbeat.user') || 'null'); } catch { return null; } },
  setAuth(token: string, user: User) { set('syncbeat.token', token); set('syncbeat.user', JSON.stringify(user)); },
  clearAuth() { set('syncbeat.token', null); set('syncbeat.user', null); },
  get guestName() { return get('syncbeat.guest') || ''; },
  set guestName(v: string) { set('syncbeat.guest', v); },
  /** Stable per-browser device id so a reconnect resumes the same member slot. */
  get deviceId(): string {
    let id = get('syncbeat.device');
    if (!id) {
      id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^\w-]/g, '');
      set('syncbeat.device', id);
    }
    return id;
  },
  adminToken: (roomId: string) => get(`syncbeat.admin.${roomId}`),
  setAdminToken: (roomId: string, t: string | null) => set(`syncbeat.admin.${roomId}`, t),
  joinInfo: (roomId: string): { name: string; password?: string } | null => { try { return JSON.parse(sget(`syncbeat.join.${roomId}`) || 'null'); } catch { return null; } },
  setJoinInfo: (roomId: string, v: { name: string; password?: string } | null) => sset(`syncbeat.join.${roomId}`, v && JSON.stringify(v)),
};
