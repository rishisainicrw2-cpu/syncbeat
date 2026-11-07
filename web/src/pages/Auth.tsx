import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Logo, Page } from '../components/ui';
import { api, ApiError, errorText } from '../lib/api';
import { session } from '../lib/session';

type Tab = 'login' | 'register' | 'guest';

export default function Auth() {
  const [params] = useSearchParams();
  const next = params.get('next') || '/create';
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(session.guestName);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (tab === 'guest') {
      session.guestName = name.trim();
      return nav('/join');
    }
    setBusy(true);
    try {
      const r = tab === 'login' ? await api.login(email, password) : await api.register(email, password, name);
      session.setAuth(r.token, r.user);
      nav(next);
    } catch (e) {
      setErr(errorText(e instanceof ApiError ? e.code : ''));
    } finally {
      setBusy(false);
    }
  };

  const tabs: [Tab, string][] = [['login', 'Sign in'], ['register', 'Sign up'], ['guest', 'Guest']];
  return (
    <Page>
      <header className="py-5"><Logo /></header>
      <div className="glass mt-6 animate-rise p-6">
        <h1 className="font-display text-2xl font-bold">{tab === 'guest' ? 'Just here to listen?' : 'DJ access'}</h1>
        <p className="mt-1 text-sm text-white/55">{tab === 'guest' ? 'Guests can join any room with its code. No account needed.' : 'An account is required to create and control a room.'}</p>
        <div className="mt-5 grid grid-cols-3 gap-1 rounded-2xl bg-white/5 p-1" role="tablist">
          {tabs.map(([t, l]) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setErr(''); }} className={`rounded-xl py-2 text-sm font-medium transition ${tab === t ? 'grad-bg text-white' : 'text-white/60 hover:text-white'}`}>{l}</button>)}
        </div>
        <form onSubmit={submit} className="mt-5 space-y-4">
          {tab !== 'login' && <div><label className="label" htmlFor="n">Display name</label><input id="n" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required placeholder="e.g. DJ Maya" autoComplete="nickname" /></div>}
          {tab !== 'guest' && <>
            <div><label className="label" htmlFor="e">Email</label><input id="e" type="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" /></div>
            <div><label className="label" htmlFor="p">Password</label><input id="p" type="password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={tab === 'login' ? 'current-password' : 'new-password'} placeholder="At least 8 characters" /></div>
          </>}
          {err && <p role="alert" className="text-sm text-rose-300">{err}</p>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'One moment…' : tab === 'login' ? 'Sign in' : tab === 'register' ? 'Create account' : 'Continue as guest'}</button>
        </form>
      </div>
    </Page>
  );
}
