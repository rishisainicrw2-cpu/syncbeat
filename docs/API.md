# API reference

Base: same origin. JSON unless noted. Errors: `{ "error": "<code>" }`.
Auth header: `Authorization: Bearer <token>`.

## REST

| Method & path | Auth | Body → Response |
|---|---|---|
| `GET /api/health` | – | → `{ok,time}` |
| `POST /api/auth/register` | – | `{email,password(≥8),displayName}` → `201 {token,user}` · `409 email_taken` |
| `POST /api/auth/login` | – | `{email,password}` → `{token,user}` · `401 bad_credentials` |
| `GET /api/auth/me` | user | → `{user}` |
| `POST /api/rooms` | user | `{name,password?(≥4)}` → `201 {room:{id,name}, adminToken}` |
| `GET /api/rooms/mine` | user | → `{rooms:[{id,name,createdAt}]}` |
| `POST /api/rooms/:id/admin-token` | user (owner) | → `{adminToken}` (12 h) |
| `GET /api/rooms/:id` | – | → `{id,name,adminName,locked,requiresPassword}` (public, rate-limited) |
| `POST /api/rooms/:id/tracks` | adminToken | multipart `file` → `201 {track}` · `415 not_audio / unsupported_audio` · `413` · `409 playlist_full` |
| `GET /media/<uuid>.<ext>` | – (unguessable name) | audio, supports `Range` |

Rate limits: 600 req/15 min/IP overall; auth 30/15 min; room lookup 40/min; upload 15/min.

## Socket.IO events (path `/socket.io`)

Client → server
* `clock:ping` `(ack(serverTimeMs))`
* `room:join` `{roomId,name,deviceId,password?,adminToken?}` `(ack JoinResponse)` → `{ok:true,role,deviceId,snapshot}` or `{ok:false,error: not_found|bad_password|room_locked|banned|room_full|bad_admin_token|bad_request}`
* `member:report` `MemberReport` every 1 s (drift, rtt, output latency, audio state…) – doubles as heartbeat
* `admin:cmd` `AdminCommand` `(ack {ok}|{ok:false,error})` – **admin sockets only** (`forbidden` otherwise)
* `room:leave`

Server → client
* `snapshot` `RoomSnapshot` – full room state (playback, tracks, members + sync status, settings, `serverTime`). Sent immediately on any change, throttled to 1 Hz for reports.
* `kicked`, `replaced` (another admin connection took over), `room:closed`

`AdminCommand` types: `play{trackId?,positionMs?}` `schedule{startAtServerMs,trackId?}` `pause` `stop` `next` `prev` `seek{positionMs}` `lock{locked}` `kick{deviceId}` `master{volume 0..1}` `lead{leadMs}` `repeat{off|all|one}` `calibration{on}` `setOffset{deviceId,offsetMs}` `reorder{trackIds}` `removeTrack{trackId}` `addUrl{title,artist,url(https),durationMs}` `rename{name}` `setPassword{password|null}` `closeRoom`.

Full types: [`shared/protocol.ts`](../shared/protocol.ts).

## Database schema

[`server/db/schema.sql`](../server/db/schema.sql) — `users`, `rooms` (password hash, lock, lead time, master volume, repeat), `tracks` (ordered by `position`). Applied automatically at startup when `DATABASE_URL` is set. Live state (members, playback position) is deliberately not persisted.
