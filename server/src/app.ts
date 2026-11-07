import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { buildApi } from './http';
import { RoomManager } from './rooms';
import { attachSocket } from './socket';
import { createStore, type Store } from './store';

export async function createApp(opts: { store?: Store } = {}) {
  const store = opts.store ?? createStore(config.databaseUrl);
  await store.init();
  const mgr = new RoomManager(store);

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:', 'data:', 'https:'],
          connectSrc: ["'self'", 'ws:', 'wss:', 'https:'],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  if (config.clientOrigins.length) app.use(cors({ origin: config.clientOrigins, credentials: true }));
  app.use(express.json({ limit: '32kb' }));

  const { api, uploadsDir } = buildApi(mgr);
  app.use('/api', api);
  // Uploaded files have unguessable UUID names and are served with Range support for seeking.
  app.use(
    '/media',
    express.static(uploadsDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: '7d',
      immutable: true,
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
    }),
  );

  // Serve the built PWA (single-origin deployment).
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/media') || req.path.startsWith('/socket.io')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  const server = http.createServer(app);
  const io = attachSocket(server, mgr);

  return {
    app,
    server,
    io,
    mgr,
    store,
    async close() {
      mgr.dispose();
      await new Promise<void>((r) => io.close(() => r()));
      if (server.listening) await new Promise<void>((r) => server.close(() => r()));
      await store.close();
    },
  };
}
