import type { PlaybackState, Track } from '../../../shared/protocol';
import Artwork from './Artwork';
import Visualizer from './Visualizer';
import { Slider } from './ui';
import { fmtTime } from '../lib/format';

export function currentTrack(tracks: Track[], p: PlaybackState) {
  return tracks.find((t) => t.id === p.trackId) ?? null;
}

export default function NowPlaying({ track, playback, position, analyser, onSeek, canSeek, compact }: { track: Track | null; playback: PlaybackState; position: number; analyser: AnalyserNode | null; onSeek?: (ms: number) => void; canSeek?: boolean; compact?: boolean }) {
  const playing = playback.status === 'playing';
  const dur = track?.durationMs ?? 0;
  return (
    <div className="space-y-5">
      <div className={`mx-auto w-full ${compact ? 'max-w-[15rem]' : 'max-w-xs'}`}><Artwork seed={track?.title ?? ''} playing={playing} /></div>
      <div className="text-center">
        <h2 className="font-display text-2xl font-bold leading-tight">{track?.title ?? 'Nothing playing'}</h2>
        <p className="mt-1 text-white/55">{track ? track.artist || 'Unknown artist' : 'Waiting for the DJ'}</p>
        <p className="mt-2 text-xs font-medium uppercase tracking-widest text-white/40">{playback.status === 'playing' ? 'Playing' : playback.status === 'paused' ? 'Paused' : 'Stopped'}</p>
      </div>
      <Visualizer analyser={analyser} active={playing} height={compact ? 56 : 80} />
      <div>
        <Slider label="Playback position" value={Math.min(position, dur || 1)} min={0} max={dur || 1} step={100} disabled={!canSeek || !track} onChange={() => {}} onCommit={(v) => onSeek?.(v)} />
        <div className="-mt-1 flex justify-between text-xs tabular-nums text-white/45"><span>{fmtTime(position)}</span><span>{dur ? fmtTime(dur) : '--:--'}</span></div>
      </div>
    </div>
  );
}
