import { useState } from 'react';
import { session } from '../lib/session';
import type { RoomSnapshot } from '../../../shared/protocol';
import type { EngineStatus } from '../audio/SyncEngine';
import type { useRoom } from '../hooks/useRoom';
import { usePosition } from '../hooks/useRoom';
import { Backdrop, Icon, Logo, Signal, Slider, StatusPill } from '../components/ui';
import NowPlaying, { currentTrack } from '../components/NowPlaying';

type R = ReturnType<typeof useRoom>;

export default function ParticipantDashboard({ room, snap, exit, connLost, engineStatus: es }: { room: R; snap: RoomSnapshot; exit: () => void; connLost: boolean; engineStatus: EngineStatus }) {
  const { engine } = room;
  const pos = usePosition(engine, true);
  const me = snap.members.find((m) => m.deviceId === session.deviceId);
  const track = currentTrack(snap.tracks, snap.playback);
  const [vol, setVol] = useState(engine.volume);
  const [offset, setOffset] = useState(engine.userOffsetMs);
  const status = connLost ? 'disconnected' : me?.status ?? 'adjusting';
  const quality = me?.quality ?? 'unknown';

  return (
    <div className="mx-auto min-h-screen max-w-md px-5 safe-t safe-b">
      <Backdrop />
      <header className="flex items-center justify-between py-4"><Logo size={24} /><button className="btn-danger px-4 py-2 text-sm" onClick={exit}>Leave</button></header>

      {connLost && <div role="status" className="mb-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-200">Connection lost — audio keeps playing locally; reconnecting and re-syncing…</div>}
      {snap.calibration && <div role="status" className="mb-3 rounded-2xl border border-violet-400/30 bg-violet-400/10 px-4 py-2.5 text-sm text-violet-200">Calibration mode: every phone clicks together. Adjust “Speaker delay” below until the speakers click as one.</div>}

      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0"><div className="truncate font-display text-lg font-semibold">{snap.name}</div><div className="truncate text-sm text-white/50">Hosted by {snap.adminName} · {snap.members.filter((m) => m.connected).length} connected</div></div>
        <StatusPill status={status} />
      </div>

      <div className="glass p-5">
        <NowPlaying track={track} playback={snap.playback} position={pos} analyser={engine.analyser} />
      </div>

      <div className="glass mt-4 space-y-5 p-5">
        <div>
          <div className="mb-1 flex items-center justify-between"><span className="label !mb-0 flex items-center gap-1.5">{Icon.vol} My volume</span><span className="text-sm tabular-nums text-white/60">{Math.round(vol * 100)}%</span></div>
          <Slider label="My volume" value={vol} min={0} max={1} step={0.01} onChange={(v) => { setVol(v); engine.setVolume(v); }} />
          <p className="text-xs text-white/35">Scaled by the DJ's master volume ({Math.round(snap.masterVolume * 100)}%). Your speaker's own volume knob still applies.</p>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Row k="Sync status" v={<StatusPill status={status} />} />
          <Row k="Drift" v={<span className="tabular-nums">{es.audioState === 'running' && snap.playback.status === 'playing' ? `${es.driftMs > 0 ? '+' : ''}${Math.round(es.driftMs)} ms` : '—'}</span>} />
          <Row k="Connection" v={<Signal quality={quality} rtt={me?.report?.rttMs} />} />
          <Row k="Clock offset" v={<span className="tabular-nums">{engine.clock.ready ? `${Math.round(engine.clock.offsetMs)} ms` : 'measuring…'}</span>} />
        </dl>
      </div>

      <div className="glass mt-4 space-y-3 p-5">
        <h3 className="font-display font-semibold">Bluetooth output</h3>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="truncate text-white/80">{es.outputLabel}</span>
          <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs ${es.outputKind === 'bluetooth' ? 'border-electric-400/40 bg-electric-500/10 text-electric-300' : 'border-white/10 bg-white/5 text-white/55'}`}>{es.outputKind === 'bluetooth' ? 'Bluetooth detected' : es.outputKind === 'default' ? 'Phone default output' : 'Unknown'}</span>
        </div>
        {es.canSelectOutput && (
          <select className="field" value={es.selectedOutput} onChange={(e) => void engine.setOutput(e.target.value)} aria-label="Audio output device">
            {es.outputs.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}
        <p className="text-xs leading-relaxed text-white/40">
          {es.canSelectOutput ? 'Pick the speaker above, or ' : 'This browser plays through whichever output Android has selected. '}
          Connect your speaker in <b>Android Settings → Bluetooth</b>. A web page can't verify the route, so if the label above doesn't say Bluetooth, trust your ears. If the speaker disconnects, audio moves to the phone speaker; reconnect it and SYNCBEAT re-syncs automatically.
        </p>
        {es.audioState !== 'running' && <button className="btn-primary w-full" onClick={() => void engine.enable(true)}>Tap to resume audio</button>}
        {es.loadError && <p role="alert" className="text-sm text-rose-300">{es.loadError}</p>}
      </div>

      <div className="glass mt-4 mb-8 space-y-3 p-5">
        <div className="flex items-center justify-between"><h3 className="font-display font-semibold">Speaker delay</h3><span className="text-sm tabular-nums text-white/60">{offset > 0 ? '+' : ''}{offset} ms</span></div>
        <Slider label="Speaker delay compensation" value={offset} min={-300} max={800} step={5} onChange={(v) => { setOffset(v); engine.setUserOffset(v); }} />
        <p className="text-xs leading-relaxed text-white/40">If this speaker sounds <b>late</b> compared to the others, move right; if early, move left. Auto-detected output latency: {es.outputLatencyMs} ms (browsers often report 0 for Bluetooth). Total compensation: {es.compensationMs} ms.</p>
        <label className="flex items-center gap-2 text-xs text-white/50"><input type="checkbox" defaultChecked={engine.autoLatency} onChange={(e) => engine.setAutoLatency(e.target.checked)} /> Include browser-reported output latency</label>
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (<div><dt className="text-xs uppercase tracking-wider text-white/40">{k}</dt><dd className="mt-1">{v}</dd></div>);
