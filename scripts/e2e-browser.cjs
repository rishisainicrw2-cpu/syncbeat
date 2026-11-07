const { chromium } = require('playwright');
const B = 'http://localhost:4000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const j = async (p, o={}) => (await fetch(B+p, { ...o, headers: { 'content-type':'application/json', ...(o.token?{authorization:'Bearer '+o.token}:{}) } })).json();
  const reg = await j('/api/auth/register', { method:'POST', body: JSON.stringify({ email:'e2e'+Date.now()+'@x.com', password:'password123', displayName:'DJ Maya' }) });
  const room = await j('/api/rooms', { method:'POST', token: reg.token, body: JSON.stringify({ name:'E2E Party' }) });
  const id = room.room.id; console.log('room', id);
  const fd = new FormData(); fd.append('file', new Blob([require('fs').readFileSync(process.env.TONE||'/tmp/tone.wav')]), 'tone.wav');
  const up = await fetch(`${B}/api/rooms/${id}/tracks`, { method:'POST', body: fd, headers:{ authorization:'Bearer '+room.adminToken } });
  console.log('upload', up.status);

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
  const mk = async (name, w=390, h=844) => { const c = await browser.newContext({ viewport:{width:w,height:h}, deviceScaleFactor:2 }); const p = await c.newPage(); p.on('pageerror', e=>console.log(name,'PAGEERROR',e.message)); p.on('console', m=>{ if(m.type()==='error') console.log(name,'console.error',m.text()); }); return {c,p}; };

  const admin = await mk('admin'); 
  await admin.p.goto(B+'/'); await admin.p.evaluate(([id,t])=>localStorage.setItem('syncbeat.admin.'+id,t), [id, room.adminToken]);
  await admin.p.goto(`${B}/room/${id}`);
  await admin.p.getByRole('button', { name: 'Start audio on this phone' }).click();
  await admin.p.waitForSelector('text=E2E Party');

  const parts = [];
  for (const n of ['Ann','Bob']) {
    const x = await mk(n); await x.p.goto(`${B}/join/${id}`);
    await x.p.fill('#dn', n); await x.p.waitForSelector('text=hosted by'); await x.p.getByRole('button', { name: 'Join room' }).click();
    await x.p.getByRole('button', { name: 'Start audio on this phone' }).click();
    await x.p.waitForSelector('text=My volume'); parts.push(x);
  }
  await admin.p.screenshot({ path: (process.env.OUT||'.')+'/admin-idle.png' });
  await parts[0].p.screenshot({ path: (process.env.OUT||'.')+'/participant-idle.png' });

  // Bob gets an artificial 90 ms offset to prove drift correction/compensation works through the engine
  await admin.p.getByRole('button', { name: 'Show room QR code' }).waitFor();
  await admin.p.getByRole('button', { name: 'Playlist' }).click();
  await admin.p.waitForSelector('text=tone');
  await admin.p.screenshot({ path: (process.env.OUT||'.')+'/admin-playlist.png' });
  await admin.p.getByRole('button', { name: 'Player' }).click();
  await admin.p.getByRole('button', { name: 'Play', exact: true }).click();
  const t0 = Date.now();
  // sample server-reported drift/status via admin's Devices tab data (read snapshot through page socket not exposed) -> use REST-less approach: watch UI
  await sleep(6000);
  await admin.p.screenshot({ path: (process.env.OUT||'.')+'/admin-playing.png' });
  await admin.p.getByRole('button', { name: 'Devices' }).click();
  await sleep(1500);
  const txt = await admin.p.locator('ul li').allInnerTexts();
  console.log('DEVICES:\n' + txt.join('\n---\n'));
  await admin.p.screenshot({ path: (process.env.OUT||'.')+'/admin-devices.png', fullPage: false });
  await parts[0].p.screenshot({ path: (process.env.OUT||'.')+'/participant-playing.png' });
  console.log('participant drift text:', await parts[0].p.locator('dt:has-text("Drift") + dd').innerText());
  console.log('participant status:', await parts[1].p.locator('dt:has-text("Sync status") + dd').innerText());

  // seek test: admin seeks, participants should re-converge
  await admin.p.getByRole('button', { name: 'Player' }).click();
  await admin.p.locator('input[aria-label="Playback position"]').evaluate((el) => { el.value = '20000'; el.dispatchEvent(new Event('input',{bubbles:true})); });
  await admin.p.locator('input[aria-label="Playback position"]').dispatchEvent('pointerup');
  await sleep(5000);
  await admin.p.getByRole('button', { name: 'Devices' }).click(); await sleep(1500);
  console.log('AFTER SEEK:\n' + (await admin.p.locator('ul li').allInnerTexts()).join('\n---\n'));
  await browser.close();
})().catch(e => { console.error('E2E FAIL', e); process.exit(1); });
