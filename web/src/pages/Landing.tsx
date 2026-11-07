import { Link } from 'react-router-dom';
import { Logo, Page } from '../components/ui';
import Visualizer from '../components/Visualizer';
import { session } from '../lib/session';

const steps = [
  ['1', 'Create a room', 'The DJ signs in, makes a room and gets a 6-letter code plus a QR code.'],
  ['2', 'Everyone joins', 'Friends scan the QR with their phone. Each phone is paired to its own Bluetooth speaker in Android settings.'],
  ['3', 'Press play', 'The server schedules one shared start time. Every phone starts together and keeps correcting drift.'],
];

export default function Landing() {
  const user = session.user;
  return (
    <Page narrow={false}>
      <header className="flex items-center justify-between py-5">
        <Logo />
        {user ? <span className="text-sm text-white/60">Hi, {user.displayName}</span> : <Link to="/login" className="text-sm text-white/70 hover:text-white">Sign in</Link>}
      </header>

      <section className="mx-auto max-w-2xl animate-rise pb-10 pt-10 text-center sm:pt-20">
        <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs text-white/70">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Web app · works on Android Chrome
        </div>
        <h1 className="font-display text-[2.6rem] font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
          One song.<br /><span className="grad-text">Every speaker.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-md text-balance text-[17px] leading-relaxed text-white/60">
          Connect each phone to its own Bluetooth speaker and play the same track across the whole room — kept in time by a shared server clock.
        </p>
        <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <Link to={user ? '/create' : '/login?next=/create'} className="btn-primary px-8 py-4 text-base">Create a room</Link>
          <Link to="/join" className="btn-ghost px-8 py-4 text-base">Join with a code</Link>
        </div>
        <div className="mx-auto mt-12 max-w-lg opacity-90"><Visualizer analyser={null} active={false} height={80} /></div>
      </section>

      <section className="grid gap-4 pb-10 sm:grid-cols-3">
        {steps.map(([n, t, d]) => (
          <div key={n} className="glass p-6">
            <div className="grad-bg mb-4 flex h-9 w-9 items-center justify-center rounded-xl font-display font-bold">{n}</div>
            <h3 className="font-display text-lg font-semibold">{t}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-white/55">{d}</p>
          </div>
        ))}
      </section>

      <section className="glass mb-12 p-6 sm:p-8">
        <h2 className="font-display text-xl font-semibold">Honest about Bluetooth</h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          Bluetooth speakers add their own delay (often 100–300 ms, different per speaker and codec), and a browser can't read it directly. SYNCBEAT aligns the <em>phones</em> precisely, estimates each device's output latency, and gives you a calibration mode so you can fine-tune each speaker by ear.
          Expect "tight enough for a party", not sample-perfect. For lock-screen playback and the best Bluetooth control, use the upcoming native Android app.
        </p>
      </section>
    </Page>
  );
}
