import { useEffect, useRef, useState } from 'react';
import type { AdminCommand, MemberInfo, RoomSnapshot } from '../../../shared/protocol';
import type { useRoom } from '../hooks/useRoom';
import { usePosition } from '../hooks/useRoom';
import { Backdrop, Icon, Logo, Modal, Signal, Slider, StatusPill } from '../components/ui';
import NowPlaying, { currentTrack } from '../components/NowPlaying';
import QRCard from '../components/QRCard';
import { api, ApiError, errorText } from '../lib/api';
import { session } from '../lib/session';
import { fmtTime } from '../lib/format';

type R = ReturnType<typeof useRoom>;
type Tab = 'player' | 'devices' | 'playlist' | 'settings';

export default function AdminDashboard({ room, snap, exit }: { room: R; snap: RoomSnapshot; exit: () => void }) {
  const { engine, send } = room;
  const [tab, setTab] = useState<Tab>('player');
  const [toast, setToast] = useState('');
  const [qr, setQr] = useState(false);
  const pos = usePosition(engine, true);
  const track = currentTrack(snap.tracks, snap.playback);
  const playing = snap.playback.status === 'playing';
  const connected = snap.members.filter((m) => m.connected && m.role === 'participant').length;

  const cmd = async (c: AdminCommand) => {
    const r = await send(c);
    if (!r.ok) { setToast(errorText(r.error)); setTimeout(() => setToast(''), 3000); }
  };

  const tabs: [Tab, string, string][] = [['player', 'Player', '♪'], ['devices', 'Devices', '◉'], ['playlist', 'Playlist', '☰'], ['settings', 'Room', '⚙']];
  return (
    <div className="mx-auto min-h-screen max-w-xl px-5 pb-28 safe-t">
      <Backdrop />
      <header className="flex items-center justify-between py-4"><Logo size={24} /><button className="text-sm text-white/50 hover:text-white" onClick={exit}>Exit</button></header>

      <button onClick={() => setQr(true)} className="glass mb-4 flex w-full items-center justify-between px-5 py-3.5 text-left transition hover:bg-white/10" aria-label="Show room QR code">
        <div>
          <div className="text-xs uppercase tracking-wider text-white/40">{snap.name}{snap.locked ? ' · 🔒' : ''}</div>
          <div className="font-display text-2xl font-bold tracking-[0.25em] grad-text">{snap.id}</div>
        </div>
        <div className="text-right"><div className="font-display text-2xl font-bold">{connected}</div><div className="text-xs text-white/45">phone{connected === 1 ? '' : 's'} · tap for QR</div></div>
      </button>
      <Modal open={qr} onClose={() => setQr(false)} title="Join this room"><QRCard roomId={snap.id} size={220} /></Modal>
      {room.conn !== 'connected' && <div role="status" className="mb-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-200">Reconnecting…</div>}
      {toast && <div role="alert" className="fixed inset-x-5 top-4 z-50 mx-auto max-w-md rounded-2xl border border-rose-400/30 bg-rose-950/90 px-4 py-3 text-sm text-rose-200 backdrop-blur">{toast}</div>}

      {tab === 'player' && <PlayerTab snap={snap} track={track} playing={playing} pos={pos} engine={room.engine} cmd={cmd} />}
      {tab === 'devices' && <DevicesTab snap={snap} cmd={cmd} />}
      {tab === 'playlist' && <PlaylistTab snap={snap} cmd={cmd} setToast={setToast} />}
      {tab === 'settings' && <SettingsTab snap={snap} cmd={cmd} exit={exit} />}

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-ink/80 backdrop-blur-xl safe-b" aria-label="Sections">
        <div className="mx-auto grid max-w-xl grid-cols-4 px-3 pt-2">
          {tabs.map(([t, l, i]) => (
            <button key={t} onClick={() => setTab(t)} aria-current={tab === t} className={`flex flex-col items-center gap-0.5 rounded-xl py-1.5 text-xs transition ${tab === t ? 'text-white' : 'text-white/45 hover:text-white/80'}`}>
              <span className={`text-lg leading-none ${tab === t ? 'grad-text' : ''}`}>{i}</span>{l}
            </button>))}
        </div>
      </nav>
    </div>
  );
}

/* --------------------------------------------------------------- player */
function PlayerTab({ snap, track, playing, pos, engine, cmd }: { snap: RoomSnapshot; track: ReturnType<typeof currentTrack>; playing: boolean; pos: number; engine: R['engine']; cmd: (c: AdminCommand) => void }) {
  const [vol, setVol] = useState(snap.masterVolume);
  const [startIn, setStartIn] = useState(10);
  const now = () => engine.clock.now();
  return (
    <div className="space-y-4 animate-rise">
      <div className="glass p-5">
        <NowPlaying track={track} playback={snap.playback} position={pos} analyser={engine.analyser} canSeek onSeek={(ms) => cmd({ type: 'seek', positionMs: ms })} compact />
        <div className="mt-4 flex items-center justify-center gap-3">
          <button className="btn-ghost h-12 w-12 !p-0" onClick={() => cmd({ type: 'prev' })} aria-label="Previous track">{Icon.prev}</button>
          <button className="btn-ghost h-12 w-12 !p-0" onClick={() => cmd({ type: 'stop' })} aria-label="Stop">{Icon.stop}</button>
          <button className="btn-primary h-16 w-16 !rounded-full !p-0" onClick={() => cmd(playing ? { type: 'pause' } : { type: 'play' })} aria-label={playing ? 'Pause' : 'Play'} disabled={!snap.tracks.length}>{playing ? Icon.pause : Icon.play}</button>
          <button className="btn-ghost h-12 w-12 !p-0" onClick={() => cmd({ type: 'next' })} aria-label="Next track">{Icon.next}</button>
        </div>
        {!snap.tracks.length && <p className="mt-4 text-center text-sm text-white/50">Add music in the Playlist tab to get started.</p>}
      </div>

      <div className="glass p-5">
        <div className="mb-1 flex items-center justify-between"><span className="label !mb-0 flex items-center gap-1.5">{Icon.vol} Master volume</span><span className="text-sm tabular-nums text-white/60">{Math.round(vol * 100)}%</span></div>
        <Slider label="Master volume" value={vol} min={0} max={1} step={0.01} onChange={setVol} onCommit={(v) => cmd({ type: 'master', volume: v })} />
        <p className="text-xs text-white/35">Scales every phone's own volume. It can't change the physical speaker volume.</p>
      </div>

      <div className="glass p-5">
        <h3 className="font-display font-semibold">Scheduled start</h3>
        <p className="mt-1 text-xs text-white/45">Pick a server-time countdown so everyone, including late joiners, hears the drop together.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {[5, 10, 30, 60].map((s) => <button key={s} onClick={() => setStartIn(s)} className={`rounded-xl border px-3.5 py-2 text-sm transition ${startIn === s ? 'border-violet-400/60 bg-violet-500/20' : 'border-white/10 bg-white/5 text-white/70'}`}>{s}s</button>)}
          <button className="btn-primary ml-auto px-4 py-2 text-sm" disabled={!snap.tracks.length} onClick={() => cmd({ type: 'schedule', startAtServerMs: Math.round(now() + startIn * 1000) })}>Start in {startIn}s</button>
        </div>
        {snap.playback.status === 'playing' && snap.playback.startAtServerMs > now() && <Countdown to={snap.playback.startAtServerMs} now={now} />}
      </div>
    </div>
  );
}

function Countdown({ to, now }: { to: number; now: () => number }) {
  const [, tick] = useState(0);
  useRefInterval(() => tick((n) => n + 1), 200);
  const left = Math.max(0, to - now());
  return left > 0 ? <p className="mt-3 text-center font-display text-3xl font-bold tabular-nums grad-text">{(left / 1000).toFixed(1)}s</p> : null;
}
function useRefInterval(fn: () => void, ms: number) {
  const f = useRef(fn); f.current = fn;
  useEffect(() => { const id = setInterval(() => f.current(), ms); return () => clearInterval(id); }, [ms]);
}

/* -------------------------------------------------------------- devices */
function DevicesTab({ snap, cmd }: { snap: RoomSnapshot; cmd: (c: AdminCommand) => void }) {
  const [edit, setEdit] = useState<MemberInfo | null>(null);
  const others = snap.members.filter((m) => m.role === 'participant');
  const counts = others.reduce<Record<string, number>>((a, m) => ((a[m.status] = (a[m.status] || 0) + 1), a), {});
  return (
    <div className="space-y-4 animate-rise">
      <div className="glass flex flex-col items-center p-6"><QRCard roomId={snap.id} /></div>
      <div className="glass p-5">
        <div className="mb-3 flex items-center justify-between"><h3 className="font-display font-semibold">Connected devices</h3><span className="text-xs text-white/45">{others.length} total</span></div>
        {others.length > 0 && <div className="mb-3 flex flex-wrap gap-2 text-xs text-white/55">{Object.entries(counts).map(([k, v]) => <span key={k}>{v} {k}</span>)}</div>}
        {!others.length && <p className="py-6 text-center text-sm text-white/45">No phones yet. Share the QR code or room code.</p>}
        <ul className="space-y-2.5">
          {others.map((m) => (
            <li key={m.deviceId} className="rounded-2xl border border-white/8 bg-white/[0.03] p-3.5">
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{m.name}</span><StatusPill status={m.status} /></div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/50">
                <Signal quality={m.quality} rtt={m.report?.rttMs} />
                {m.report && <span>drift {m.report.driftMs > 0 ? '+' : ''}{m.report.driftMs} ms</span>}
                {m.report && <span className="max-w-[10rem] truncate" title={m.report.outputLabel}>{m.report.outputKind === 'bluetooth' ? '🔵 ' : ''}{m.report.outputLabel}</span>}
                {m.report && !m.report.playsAudio && <span>no audio</span>}
              </div>
              <div className="mt-3 flex gap-2">
                <button className="btn-ghost flex-1 py-2 text-xs" onClick={() => setEdit(m)}>Delay {m.adminOffsetMs ? `${m.adminOffsetMs > 0 ? '+' : ''}${m.adminOffsetMs}ms` : '…'}</button>
                <button className="btn-danger flex-1 py-2 text-xs" onClick={() => cmd({ type: 'kick', deviceId: m.deviceId })}>{m.connected ? 'Remove' : 'Remove (offline)'}</button>
              </div>
            </li>))}
        </ul>
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Delay for ${edit?.name ?? ''}`}>
        {edit && <OffsetEditor m={snap.members.find((x) => x.deviceId === edit.deviceId) ?? edit} cmd={cmd} />}
      </Modal>
    </div>
  );
}
function OffsetEditor({ m, cmd }: { m: MemberInfo; cmd: (c: AdminCommand) => void }) {
  const [v, setV] = useState(m.adminOffsetMs);
  return (
    <div className="space-y-3">
      <p className="text-sm text-white/60">Remote adjustment added on top of the phone's own setting ({m.report?.userOffsetMs ?? 0} ms auto/manual). Positive = this speaker sounds late.</p>
      <div className="text-center font-display text-3xl font-bold tabular-nums">{v > 0 ? '+' : ''}{v} ms</div>
      <Slider label="Remote delay" min={-300} max={800} step={5} value={v} onChange={setV} onCommit={(x) => cmd({ type: 'setOffset', deviceId: m.deviceId, offsetMs: x })} />
      <button className="btn-ghost w-full" onClick={() => { setV(0); cmd({ type: 'setOffset', deviceId: m.deviceId, offsetMs: 0 }); }}>Reset</button>
    </div>
  );
}

/* ------------------------------------------------------------- playlist */
function PlaylistTab({ snap, cmd, setToast }: { snap: RoomSnapshot; cmd: (c: AdminCommand) => Promise<void> | void; setToast: (s: string) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');

  const upload = async (files: FileList | null) => {
    if (!files) return;
    const token = session.adminToken(snap.id);
    if (!token) return;
    for (const f of Array.from(files)) {
      setBusy(`Uploading ${f.name}…`);
      try { await api.upload(snap.id, f, token); } catch (e) { setToast(`${f.name}: ${errorText(e instanceof ApiError ? e.code : '')}`); setTimeout(() => setToast(''), 4000); }
    }
    setBusy('');
    if (file.current) file.current.value = '';
  };

  const addUrl = async () => {
    setBusy('Checking link…');
    // Read the duration in the browser (the server never downloads third-party audio).
    const dur = await new Promise<number>((res) => { const a = new Audio(); a.preload = 'metadata'; a.crossOrigin = 'anonymous'; a.onloadedmetadata = () => res(Math.round(a.duration * 1000)); a.onerror = () => res(-1); a.src = url; setTimeout(() => res(-1), 8000); });
    setBusy('');
    if (dur <= 0) { setToast('Could not read that audio link (needs HTTPS and CORS enabled).'); setTimeout(() => setToast(''), 4000); return; }
    await cmd({ type: 'addUrl', url, title: title || url.split('/').pop() || 'Linked audio', artist: '', durationMs: dur });
    setUrl(''); setTitle('');
  };

  const move = (i: number, d: number) => {
    const ids = snap.tracks.map((t) => t.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    cmd({ type: 'reorder', trackIds: ids });
  };

  return (
    <div className="space-y-4 animate-rise">
      <div className="glass p-5">
        <h3 className="font-display font-semibold">Add music</h3>
        <p className="mt-1 text-xs text-white/45">Only upload audio you have the rights to play. MP3, M4A/AAC, WAV, FLAC or OGG · files are checked by content.</p>
        <input ref={file} type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.webm" multiple hidden onChange={(e) => void upload(e.target.files)} />
        <button className="btn-primary mt-3 w-full" onClick={() => file.current?.click()} disabled={!!busy}>{busy || 'Upload audio files'}</button>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-white/50 hover:text-white">Or link to an audio file (HTTPS)</summary>
          <div className="mt-2 space-y-2">
            <input className="field" placeholder="https://example.com/track.mp3" value={url} onChange={(e) => setUrl(e.target.value)} />
            <input className="field" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button className="btn-ghost w-full" disabled={!url.startsWith('https://') || !!busy} onClick={() => void addUrl()}>Add link</button>
            <p className="text-xs text-white/35">The host must allow cross-origin requests (CORS) so every phone can fetch it. Streaming-service links (Spotify, YouTube…) are not supported.</p>
          </div>
        </details>
      </div>
      <div className="glass p-5">
        <div className="mb-3 flex items-center justify-between"><h3 className="font-display font-semibold">Queue</h3>
          <select className="rounded-xl border border-white/10 bg-white/5 px-2 py-1 text-xs" value={snap.repeat} onChange={(e) => cmd({ type: 'repeat', mode: e.target.value as 'off' | 'all' | 'one' })} aria-label="Repeat mode"><option value="off">No repeat</option><option value="all">Repeat all</option><option value="one">Repeat one</option></select>
        </div>
        {!snap.tracks.length && <p className="py-6 text-center text-sm text-white/45">Your queue is empty.</p>}
        <ol className="space-y-1.5">
          {snap.tracks.map((t, i) => {
            const cur = t.id === snap.playback.trackId;
            return (
              <li key={t.id} className={`flex items-center gap-2 rounded-2xl border p-2.5 ${cur ? 'border-violet-400/40 bg-violet-500/10' : 'border-white/8 bg-white/[0.03]'}`}>
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => cmd({ type: 'play', trackId: t.id, positionMs: 0 })} aria-label={`Play ${t.title}`}>
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm ${cur && snap.playback.status === 'playing' ? 'grad-bg' : 'bg-white/8 text-white/50'}`}>{cur && snap.playback.status === 'playing' ? '▶' : i + 1}</span>
                  <span className="min-w-0"><span className="block truncate text-sm font-medium">{t.title}</span><span className="block truncate text-xs text-white/45">{t.artist || 'Unknown artist'} · {t.durationMs ? fmtTime(t.durationMs) : '—'}</span></span>
                </button>
                <div className="flex shrink-0 gap-0.5 text-white/45">
                  <button className="h-8 w-8 rounded-lg hover:bg-white/10 hover:text-white" onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                  <button className="h-8 w-8 rounded-lg hover:bg-white/10 hover:text-white" onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  <button className="h-8 w-8 rounded-lg hover:bg-rose-500/20 hover:text-rose-300" onClick={() => cmd({ type: 'removeTrack', trackId: t.id })} aria-label={`Remove ${t.title}`}>✕</button>
                </div>
              </li>);
          })}
        </ol>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- settings */
function SettingsTab({ snap, cmd, exit }: { snap: RoomSnapshot; cmd: (c: AdminCommand) => void; exit: () => void }) {
  const [name, setName] = useState(snap.name);
  const [pw, setPw] = useState('');
  const [lead, setLead] = useState(snap.leadMs);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="space-y-4 animate-rise">
      <div className="glass space-y-4 p-5">
        <div><label className="label" htmlFor="rname">Room name</label><div className="flex gap-2"><input id="rname" className="field" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} /><button className="btn-ghost" onClick={() => cmd({ type: 'rename', name })}>Save</button></div></div>
        <div><label className="label" htmlFor="rpw">Access code {snap.requiresPassword ? '(set)' : '(none)'}</label><div className="flex gap-2"><input id="rpw" className="field" value={pw} onChange={(e) => setPw(e.target.value)} minLength={4} maxLength={64} placeholder="New code (4+ characters)" autoComplete="off" /><button className="btn-ghost" disabled={pw.length < 4} onClick={() => { cmd({ type: 'setPassword', password: pw }); setPw(''); }}>Set</button></div>{snap.requiresPassword && <button className="mt-2 text-xs text-white/45 hover:text-white" onClick={() => cmd({ type: 'setPassword', password: null })}>Remove access code</button>}</div>
        <label className="flex items-center justify-between gap-3"><span><span className="block font-medium">Lock room</span><span className="text-xs text-white/45">Block new devices. Phones already in the room can reconnect.</span></span><input type="checkbox" className="h-6 w-6 accent-violet-500" checked={snap.locked} onChange={(e) => cmd({ type: 'lock', locked: e.target.checked })} /></label>
      </div>
      <div className="glass space-y-3 p-5">
        <div className="flex items-center justify-between"><h3 className="font-display font-semibold">Start lead time</h3><span className="text-sm tabular-nums text-white/60">{(lead / 1000).toFixed(1)} s</span></div>
        <Slider label="Lead time" min={500} max={8000} step={100} value={lead} onChange={setLead} onCommit={(v) => cmd({ type: 'lead', leadMs: v })} />
        <p className="text-xs text-white/40">How far ahead of "now" the shared start is scheduled. Longer gives slow phones time to prepare; shorter feels snappier. 2 s suits most Wi-Fi/4G.</p>
      </div>
      <div className="glass space-y-3 p-5">
        <h3 className="font-display font-semibold">Speaker calibration</h3>
        <p className="text-xs leading-relaxed text-white/45">Every phone plays a click on the same server beat. Stand where you can hear all speakers; if one clicks late, raise its delay (Devices tab or on the phone itself) until they click as one. Then turn this off.</p>
        <button className={snap.calibration ? 'btn-danger w-full' : 'btn-primary w-full'} onClick={() => cmd({ type: 'calibration', on: !snap.calibration })}>{snap.calibration ? 'Stop calibration' : 'Start calibration clicks'}</button>
      </div>
      <div className="glass p-5">
        <h3 className="mb-2 font-display font-semibold text-rose-300">Danger zone</h3>
        {!confirm ? <button className="btn-danger w-full" onClick={() => setConfirm(true)}>Close room…</button> : (
          <div className="space-y-2"><p className="text-sm text-white/60">This disconnects everyone and deletes the playlist and uploaded files.</p><div className="flex gap-2"><button className="btn-ghost flex-1" onClick={() => setConfirm(false)}>Cancel</button><button className="btn-danger flex-1" onClick={async () => { await cmd({ type: 'closeRoom' }); session.setAdminToken(snap.id, null); exit(); }}>Close room</button></div></div>)}
      </div>
    </div>
  );
}
