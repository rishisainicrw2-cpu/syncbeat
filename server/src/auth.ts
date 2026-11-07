import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';

export interface UserClaims {
  typ: 'user';
  sub: string;
  name: string;
}
export interface AdminClaims {
  typ: 'admin';
  sub: string;
  roomId: string;
}

export const signUser = (id: string, name: string) =>
  jwt.sign({ typ: 'user', sub: id, name } satisfies UserClaims, config.jwtSecret, { expiresIn: '7d' });

export const signAdmin = (userId: string, roomId: string) =>
  jwt.sign({ typ: 'admin', sub: userId, roomId } satisfies AdminClaims, config.jwtSecret, { expiresIn: '12h' });

export function verifyUser(token: string | undefined): UserClaims | null {
  try {
    if (!token) return null;
    const c = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as UserClaims;
    return c.typ === 'user' ? c : null;
  } catch {
    return null;
  }
}

export function verifyAdmin(token: string | undefined, roomId: string): AdminClaims | null {
  try {
    if (!token) return null;
    const c = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as AdminClaims;
    return c.typ === 'admin' && c.roomId === roomId ? c : null;
  } catch {
    return null;
  }
}

const bearer = (req: Request) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
};

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserClaims;
    admin?: AdminClaims;
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const u = verifyUser(bearer(req));
  if (!u) return void res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  next();
}

export function requireRoomAdmin(req: Request, res: Response, next: NextFunction) {
  const a = verifyAdmin(bearer(req), String(req.params.id ?? '').toUpperCase());
  if (!a) return void res.status(403).json({ error: 'forbidden' });
  req.admin = a;
  next();
}
