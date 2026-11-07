# Android implementation plan (native app)

Not built yet — this is the plan and the key code, written against the same protocol (`shared/protocol.ts`) so the existing server needs **no changes**. The native app exists because a web page can't do the following reliably:

| Need | Browser | Native Android |
|---|---|---|
| Playback with screen off / app backgrounded | best-effort | `MediaSessionService` + foreground service (type `mediaPlayback`) |
| Know the real output route (Bluetooth speaker vs phone speaker) | label heuristics only | `AudioManager.getDevices(GET_DEVICES_OUTPUTS)`, `AudioDeviceCallback` |
| Measure true output latency | `outputLatency` (often 0 for BT) | `AudioTrack.getTimestamp()`, `AudioManager.getProperty(PROPERTY_OUTPUT_LATENCY)` hidden/OEM-dependent → measure with timestamps, plus calibration clicks |
| Detect speaker disconnect/reconnect and resume | indirect | `AudioDeviceCallback.onAudioDevicesAdded/Removed`, `ACTION_AUDIO_BECOMING_NOISY` |
| Pin audio to a specific output | `setSinkId` (limited) | `ExoPlayer.setPreferredAudioDevice(AudioDeviceInfo)` / `AudioTrack.setPreferredDevice` |

## Stack
Kotlin, Jetpack Compose (screens mirror the web ones), **Media3 (ExoPlayer + MediaSessionService)**, **Socket.IO Java client** (`io.socket:socket.io-client`) or OkHttp WebSocket, DataStore for device id/offset, ZXing/ML Kit for QR scanning. `minSdk 26`.

## Modules
```
app/
  data/   SyncSocket.kt (same events as docs/API.md)  ClockSync.kt  Api.kt (Retrofit: auth, rooms, upload)
  audio/  SyncPlayerService.kt (MediaSessionService)  SyncController.kt  OutputMonitor.kt
  ui/     Welcome, Auth, Create, Join(+scan), AdminDashboard, ParticipantDashboard, Devices, Playlist, Settings
```
Permissions: `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS` (13+), `BLUETOOTH_CONNECT` (12+, to read device names), `CAMERA` (QR). No location permission needed.

## Clock sync (identical algorithm)
```kotlin
// offset = serverTime - (t0 + rtt/2); median of the 5 lowest-RTT of the last 16 samples
fun serverNow() = System.currentTimeMillis() + offsetMs
```
Prefer `SystemClock.elapsedRealtime()` deltas for RTT; use wall clock only for the offset itself.

## Synchronized start with ExoPlayer
ExoPlayer can't be told "start at wall-clock T" directly, so: prepare the item, `seekTo(position)`, keep `playWhenReady=false`, then fire `play()` from a high-priority handler at the computed instant, and let the drift loop trim the remainder.
```kotlin
class SyncController(private val player: ExoPlayer, private val clock: ClockSync, private val out: OutputMonitor) {
  private val handler = Handler(player.applicationLooper)
  private val userOffsetMs get() = prefs.offsetMs + adminOffsetMs

  fun apply(s: PlaybackState, track: Track) {
    handler.removeCallbacksAndMessages(null)
    if (s.status != "playing") { player.pause(); return }
    if (player.currentMediaItem?.mediaId != track.id) player.setMediaItem(MediaItem.Builder().setMediaId(track.id).setUri(track.absUrl).build())
    player.prepare()
    // Heard-on-time: start earlier by output latency + calibration offset.
    val comp = out.latencyMs + userOffsetMs
    val renderStart = s.startAtServerMs - comp
    val wait = renderStart - clock.serverNow()
    if (wait > 0) {
      player.seekTo(s.positionMs); player.playWhenReady = false
      handler.postDelayed({ player.play() }, wait)            // ±1–5 ms on a quiet looper
    } else {
      player.seekTo(s.positionMs + (clock.serverNow() + comp - s.startAtServerMs)); player.play()
    }
  }

  /** every 250 ms */
  fun driftTick(s: PlaybackState) {
    val target = s.positionMs + (clock.serverNow() + comp() - s.startAtServerMs)
    val drift = player.currentPosition - target                // + ⇒ ahead
    when {
      abs(drift) > 120 -> player.seekTo(target)                // hard resync
      abs(drift) > 15  -> player.setPlaybackSpeed(1f - (drift / 1500f).coerceIn(-0.02f, 0.02f))
      else             -> player.setPlaybackSpeed(1f)
    }
  }
}
```
(For tighter control than `Handler` allows, play through a custom `AudioTrack` sink and schedule by frame position using `AudioTrack.getTimestamp()` — a later optimisation.)

## Bluetooth output handling
```kotlin
class OutputMonitor(ctx: Context, private val player: ExoPlayer) {
  private val am = ctx.getSystemService(AudioManager::class.java)
  val route = MutableStateFlow<AudioDeviceInfo?>(null)
  private val cb = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(d: Array<AudioDeviceInfo>)   = refresh(resync = true)   // speaker reconnected → resume + resync
    override fun onAudioDevicesRemoved(d: Array<AudioDeviceInfo>) = refresh(resync = false)  // speaker lost → show "Disconnected"; Android falls back to phone speaker
  }
  fun start() { am.registerAudioDeviceCallback(cb, null); refresh(false) }
  private fun refresh(resync: Boolean) {
    val bt = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull {
      it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || it.type == AudioDeviceInfo.TYPE_BLE_SPEAKER || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET }
    route.value = bt
    player.setPreferredAudioDevice(bt)               // null ⇒ system default
    if (resync) { player.play(); /* SyncController re-applies server state */ }
  }
}
```
Report `outputKind = bluetooth|default`, `outputLabel = bt.productName`, and the measured latency in `member:report` — the server/admin UI already displays them. Policy: if the user chose "Bluetooth only" and the route is lost, pause locally and show *Disconnected* instead of falling back to the phone speaker.

## Latency measurement
1. Seed with `AudioTrack.getTimestamp()` based estimate (framePosition vs `nanoTime`) + `getBufferSizeInFrames` buffer.
2. Refine via calibration clicks (same server-beat mechanism as the web app). Optional automatic mode: the *measuring* phone's microphone records the room, detects each device's click arrival and posts the per-device offset via `admin:cmd setOffset` — the best path to genuinely automatic Bluetooth compensation.
3. Persist offset per `(phone, AudioDeviceInfo.address)` so each speaker is calibrated once.

## Foreground playback service
`SyncPlayerService : MediaSessionService` owns the `ExoPlayer`, the socket and the controllers so the session survives screen-off; show a media notification (title, DJ name, sync status). Request audio focus with `AUDIOFOCUS_GAIN` and handle `ACTION_AUDIO_BECOMING_NOISY` carefully: do **not** auto-pause for a lost speaker if the DJ's session is live — instead surface it and resync on reconnect. Use `PowerManager.PARTIAL_WAKE_LOCK` and `WifiManager.WifiLock(WIFI_MODE_FULL_LOW_LATENCY)` while in a room.

## Milestones
1. Skeleton + auth/join/QR (3 d) → 2. Socket + clock sync + snapshot UI (3 d) → 3. ExoPlayer sync + drift loop (4 d) → 4. Foreground service + notification (2 d) → 5. OutputMonitor + latency + calibration (4 d) → 6. Admin screens: upload, playlist, devices (4 d) → 7. Field test on ≥3 phones/3 speakers; tune thresholds (ongoing) → 8. Play Store internal track.
