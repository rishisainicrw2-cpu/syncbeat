import dotenv from 'dotenv';
import crypto from 'node:crypto';
import path from 'node:path';

dotenv.config({ path: ['.env', '../.env'] });

const prod = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (prod) throw new Error('JWT_SECRET must be set when NODE_ENV=production');
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET not set — using a random dev secret (tokens reset on restart).');
}

export const config = {
  prod,
  port: Number(process.env.PORT || 4000),
  jwtSecret,
  databaseUrl: process.env.DATABASE_URL || '',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  webDist: path.resolve(process.env.WEB_DIST || '../web/dist'),
  clientOrigins: (process.env.CLIENT_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 40),
  maxTracksPerRoom: Number(process.env.MAX_TRACKS_PER_ROOM || 100),
  maxMembersPerRoom: Number(process.env.MAX_MEMBERS_PER_ROOM || 50),
  defaultLeadMs: Number(process.env.DEFAULT_LEAD_MS || 2000),
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : prod ? 1 : false,
};
