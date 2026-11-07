# SYNCBEAT

Play the **same track on many phones at once, each phone feeding its own Bluetooth speaker**. One phone is the DJ; everyone else joins by room code or QR. Playback is driven by a server-authoritative timeline and a shared clock, with automatic drift correction and per-speaker latency calibration.

> **Status:** working MVP (web/PWA). Server logic, auth, uploads, real-time sync and the browser audio engine are implemented and tested (see [docs/TESTING.md](docs/TESTING.md)). **Not yet done:** the physical multi-phone/multi-speaker field test (Stage 8), the production deployment (Stage 9) and the native Android app (planned in [docs/ANDROID.md](docs/ANDROID.md)). These need real hardware / your hosting account.

## How it works (architecture in one page)

```
 DJ phone (admin)            Server (Node + Socket.IO)                Participant phones
 ┌────────────┐  admin:cmd   ┌──────────────────────────┐  snapshot   ┌────────────────────┐
 │ React PWA  │─────────────▶│ RoomManager              │────────────▶│ React PWA          │
 │ controls   │              │  • PlaybackState (truth) │             │ SyncEngine         │
 └────────────┘              │  • members, status       │◀────────────│  • ClockSync (NTP) │
                             │  • auto-advance timers   │ clock:ping  │  • Web Audio       │
   REST: auth, rooms, upload │ Express: auth/upload/API │ member:     │  • drift loop      │
                             │ Store: Postgres | memory │ report 1 Hz │  → phone's current │
                             └──────────────────────────┘             │    audio output ⇒  │
                                                                      │    Bluetooth speaker│
                                                                      └────────────────────┘
```

**Shared timeline.** The server stores `{trackId, positionMs, startAtServerMs, status, version}`. While playing, the position at server time *T* is `positionMs + max(0, T − startAtServerMs)`. Pressing **Play** sets `startAtServerMs = now + leadMs` (default 2 s). Nobody "starts on receipt"; every phone schedules its start for that same future instant.

**Server clock sync.** Each client runs NTP-style pings (`offset = serverTime − (t0 + rtt/2)`), keeps the lowest-RTT samples, and takes their median, smoothed. All scheduling uses `serverNow = Date.now() + offset`.

**Audio engine** (`web/src/audio/SyncEngine.ts`). Tracks are fetched and decoded to an `AudioBuffer`; playback uses `AudioBufferSourceNode.start(when, offset)` on the audio clock, so start precision is sample-level rather than "whenever a JS timer fires". Every 250 ms the engine compares the real position with the shared timeline:

| drift | action | status shown |
|---|---|---|
| < 15 ms | none | Synchronized |
| 15–120 ms | nudge `playbackRate` by up to ±2 % (inaudible) | Adjusting |
| > 120 ms | hard resync: restart source at the correct offset | Adjusting |
| > 150 ms, audio suspended, or track not ready | — | Delayed |
| no heartbeat for 10 s / socket gone | — | Disconnected |

**Latency compensation.** `comp = AudioContext.outputLatency (if the browser reports it) + user offset + admin remote offset`. Each phone renders its audio `comp` ms early so the sound *leaves the speaker* on time. **Calibration mode** makes every phone click on the same server beat so you can tune each speaker by ear.

**Reconnection.** Devices have a persistent `deviceId`; Socket.IO auto-reconnects, re-joins, re-syncs the clock and receives the current snapshot. Audio keeps playing locally during a drop and re-aligns when the link returns. Auto-advance is server-side, so tracks keep rolling with no DJ connected.

## Honest limitations

* **Bluetooth is not synchronized "perfectly".** Speakers/codecs add 100–300 ms (differs per device); two phones can't know each other's. We align the phones precisely, estimate output latency where the browser exposes it (often it reports 0 for Bluetooth), and give you manual + remote calibration. Realistic result: a few tens of ms after calibration, enough for a party, not for studio work. Different speakers' latency can drift when codecs renegotiate.
* **A web page cannot choose/see Bluetooth routing on every phone.** It plays to whichever output Android has active. Where the browser exposes outputs (`enumerateDevices` + `AudioContext.setSinkId`, Chrome ≥110, mostly desktop) we show a picker; the UI only says "Bluetooth detected" when the OS-reported device *label* says so, and otherwise says "Phone default output". Pair the speaker in Android settings first.
* **Background/lock-screen playback is best-effort in a browser** (screen wake lock + silent keep-alive `<audio>`). Android Chrome may still throttle or suspend a backgrounded tab. Reliable background playback, real route detection (`AudioDeviceInfo`), `AudioTrack` latency measurement and Bluetooth reconnect handling need the **native Android app** (plan in [docs/ANDROID.md](docs/ANDROID.md)).
* **Music sources:** your own uploads (content-validated) or direct HTTPS audio URLs that allow CORS. No Spotify/YouTube ripping; upload only audio you have rights to.
* **One queue per room** (reorderable) rather than multiple saved playlists.
* Live room state is in server memory (one server instance). Horizontal scaling needs the Socket.IO Redis adapter + moving `Room` state to Redis.

## Quick start

Requires Node ≥ 20.

```bash
npm install
npm run dev            # server :4000 + web :5173 (proxied). Open http://localhost:5173
```

Phones on your Wi-Fi can use `http://<laptop-ip>:5173`, but note **secure-context APIs (camera QR scan, wake lock, install-as-app) need HTTPS** — use a tunnel (e.g. `cloudflared tunnel --url http://localhost:5173`) or deploy.

Production-style, single process serving the PWA:

```bash
cp .env.example server/.env   # set JWT_SECRET at least
npm run build && npm start    # http://localhost:4000
```

Tests: `npm test` (server unit + Socket.IO integration + upload validation), `npm run typecheck`.

## Repo layout

```
shared/protocol.ts      wire types, timeline math, sync thresholds (server + web share it)
server/src/rooms.ts     RoomManager: playback state machine, members, status, auto-advance
server/src/socket.ts    Socket.IO: join, admin commands (authz bound to socket), reports, flood limit
server/src/http.ts      REST: auth, rooms, upload (content validation), rate limits
server/src/store.ts     MemoryStore | PgStore        server/db/schema.sql   PostgreSQL schema
web/src/audio/          ClockSync.ts, SyncEngine.ts (Web Audio scheduling, drift, calibration)
web/src/pages/          Landing, Auth(login/guest), CreateRoom, JoinRoom, Admin/ParticipantDashboard
docs/                   API, DEPLOY, TESTING, ANDROID
Dockerfile, docker-compose.yml, render.yaml, .env.example
```

## Screens → code

Welcome `Landing` · Login/Guest `Auth` · Create Room `CreateRoom` · Join Room `JoinRoom` (+QR scan) · Admin Dashboard `AdminDashboard` (tabs: Music Player, Connected Devices, Playlist Management, Room Settings) · Participant Dashboard `ParticipantDashboard`.

## Security summary

Unique 6-char room IDs from a 31-symbol alphabet via `crypto.randomInt`; bcrypt passwords & access codes; admin = signed JWT bound to *(room, owner)* and verified on socket join — playback commands are authorized by the socket's verified role, never by payload; zod validation on every message; uploads validated by parsing the audio (not extension/MIME), server-chosen filename, size cap, `nosniff`; HTTP rate limits (stricter on auth, room lookup and upload) + per-socket event limit; helmet CSP; kicked devices are banned for the room's lifetime; secrets only from env.
Known gaps: media URLs are unguessable-UUID capability links (not per-request authenticated); admin tokens live in `localStorage` (XSS would expose them; CSP mitigates); no email verification / password reset.
