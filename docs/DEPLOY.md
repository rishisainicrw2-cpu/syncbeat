# Deployment

The server serves the built PWA, REST API, media and WebSocket from **one origin**, so deployment is one container. **HTTPS is required** in production (camera QR scan, wake lock, PWA install and `wss://` all need a secure context; the CSP also upgrades insecure requests).

## Requirements
* Persistent disk for uploads (`DATA_DIR`) — uploaded audio lives on disk.
* PostgreSQL (`DATABASE_URL`) so accounts/rooms/playlists survive restarts. Without it, an in-memory store is used (fine for a demo).
* A host that supports WebSockets and a single long-lived instance (live room state is in memory).
* `JWT_SECRET` set (server refuses to start in production without it).

## Option A — Render (Blueprint included)
1. Push this repo to GitHub. 2. Render → *New → Blueprint* → select the repo (`render.yaml`). 3. Deploy; Render generates `JWT_SECRET`, provisions Postgres and a 5 GB disk at `/data`. 4. Open the `https://…onrender.com` URL on your phones.
(Persistent disks need a paid instance type.)

## Option B — Docker anywhere
```bash
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
docker compose up --build -d        # app :4000 + Postgres
```
Put it behind a TLS reverse proxy that forwards WebSocket upgrades, e.g. Caddy:
```
syncbeat.example.com { reverse_proxy localhost:4000 }
```
and set `TRUST_PROXY=1` so rate limiting sees real client IPs.

## Option C — plain Node
`npm ci && npm run build && NODE_ENV=production JWT_SECRET=… DATABASE_URL=… DATA_DIR=/var/lib/syncbeat npm start`

## Split hosting (optional)
Static web on a CDN + API elsewhere: set `CLIENT_ORIGIN=https://web.example.com` on the server and proxy/rewrites `/api`, `/media`, `/socket.io` to the API (the web app uses same-origin relative URLs).

## Operations notes
* Health check: `GET /api/health`.
* Uploads are not auto-pruned except when a track is removed or a room is closed.
* Scale-out requires Socket.IO's Redis adapter and moving `Room` state out of process (not implemented).
