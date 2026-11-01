// Cloud backup tests (mock Supabase) + config endpoint. Setup: npm i jsdom   Run: node tests/cloud.test.js
const { JSDOM } = require('jsdom'); const fs = require('fs'); const assert = require('assert');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const cfg = require('../api/config.js');
const call = env => { Object.keys(process.env).filter(k => /SUPABASE/.test(k)).forEach(k => delete process.env[k]); Object.assign(process.env, env); let out; cfg({}, { setHeader() {}, status() { return { json: o => (out = o) }; } }); return out; };
const jwt = role => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.sig1234567890';
function mk(configured) {
  const S = { rows: {}, tokens: new Set(['tok1']), refreshed: 0, posts: [], users: {} }, errs = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x.test/', pretendToBeVisual: true, beforeParse(w) {
    w.addEventListener('error', e => errs.push(e.message)); w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} }); w.HTMLElement.prototype.scrollIntoView = function () {}; w.scrollTo = () => {}; w.confirm = () => true;
    const R = (st, o) => ({ ok: st < 400, status: st, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(o), json: async () => o });
    w.fetch = async (u, o) => { u = String(u); const body = o && o.body ? JSON.parse(o.body) : null, h = (o && o.headers) || {};
      if (u === '/api/config') return R(200, configured ? { supabaseUrl: 'https://abc.supabase.co', supabaseAnonKey: 'anon-key-1234567890abcdef' } : {});
      if (!/abc\.supabase\.co/.test(u)) return R(404, {}); assert.strictEqual(h.apikey, 'anon-key-1234567890abcdef', 'anon key sent');
      if (/auth\/v1\/signup/.test(u)) { S.users[body.email] = body.password; return R(200, { id: 'u-1', email: body.email }); }
      if (/grant_type=password/.test(u)) return S.users[body.email] && S.users[body.email] === body.password ? R(200, { access_token: 'tok1', refresh_token: 'ref1', expires_in: 3600, user: { id: 'u-1', email: body.email } }) : R(400, { error_description: 'Invalid login credentials' });
      if (/grant_type=refresh_token/.test(u)) { S.refreshed++; S.tokens.add('tok2'); return R(200, { access_token: 'tok2', refresh_token: 'ref2', expires_in: 3600, user: { id: 'u-1', email: 'a@b.co' } }); }
      if (/rest\/v1\/user_data/.test(u)) { const tok = (h.Authorization || '').replace('Bearer ', ''); if (!S.tokens.has(tok)) return R(401, { message: 'JWT invalid' });
        if (o.method === 'POST') { S.posts.push({ tok, body, prefer: h.Prefer }); body.forEach(r => { assert.strictEqual(r.user_id, 'u-1'); S.rows[r.key] = r.value; }); return R(201, {}); }
        return R(200, Object.keys(S.rows).map(k => ({ key: k, value: S.rows[k] }))); }
      return R(404, {}); };
  } });
  return { w: dom.window, S, errs };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  // ---- config endpoint never leaks a secret key
  assert.deepStrictEqual(call({}), {}); assert.deepStrictEqual(call({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: jwt('service_role') }), {}, 'service_role refused'); assert.deepStrictEqual(call({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'sb_secret_abcdefghijklmnopqrstuv' }), {}, 'sb_secret refused'); assert.deepStrictEqual(call({ SUPABASE_URL: 'https://evil.example.com', SUPABASE_ANON_KEY: jwt('anon') }), {}, 'only supabase.co');
  assert.strictEqual(call({ SUPABASE_URL: 'https://abc.supabase.co/', SUPABASE_ANON_KEY: jwt('anon') }).supabaseUrl, 'https://abc.supabase.co'); console.log('config endpoint ok');
  // ---- not configured: card hidden
  let a = mk(false); await sleep(500); a.w.localStorage.setItem('sn_users', JSON.stringify({ kid: { username: 'kid', name: 'Kid', age: 15, role: 'student', friends: [], pendingOut: [], pendingIn: [] } })); a.w.eval("currentUser = storeGet('users').kid; renderProfile();"); await sleep(150); assert.strictEqual(a.w.document.getElementById('cloudCard').style.display, 'none'); console.log('hidden when not configured ok');
  // ---- configured flow
  const { w, S, errs } = mk(true), d = w.document, ev = c => w.eval(c); await sleep(500);
  w.localStorage.setItem('sn_users', JSON.stringify({ kid: { username: 'kid', name: 'Kid', age: 15, role: 'student', friends: [], pendingOut: [], pendingIn: [], pwh: 'SECRETHASH', salt: 'SALT', edu: { cls: 'Class 10', board: 'CBSE' } } }));
  ev("currentUser = storeGet('users').kid; storeSet('hw_kid', [{id:1,subj:'maths',text:'ex 1',done:false}]); storeSet('cards_kid', [{id:'c',front:'f',back:'b',deck:'d',box:1,due:0}]); renderProfile();"); await sleep(200);
  assert.ok(d.getElementById('cloudCard').style.display !== 'none' && d.getElementById('cloudEmail'), 'form shown');
  d.getElementById('cloudEmail').value = 'a@b.co'; d.getElementById('cloudPass').value = 'password1'; await ev("cloudSign('up')"); assert.ok(/agree/.test(d.getElementById('cloudMsg').textContent), 'consent required');
  d.getElementById('cloudOK').checked = true; await ev("cloudSign('up')"); assert.ok(/confirm/i.test(d.getElementById('cloudMsg').textContent), 'email-confirm message');
  d.getElementById('cloudPass').value = 'wrongpass1'; await ev("cloudSign('in')"); assert.ok(/Invalid login/.test(d.getElementById('cloudMsg').textContent)); d.getElementById('cloudPass').value = 'password1'; await ev("cloudSign('in')"); await sleep(400);
  assert.ok(ev("cloudSess().email") === 'a@b.co'); assert.ok(S.rows['sn_hw_kid'] && S.rows['sn_cards_kid'] && S.rows['__profile'].edu.cls === 'Class 10', 'first backup ran after sign-in'); console.log('sign-in + first backup ok');
  const sent = JSON.stringify(S.posts); assert.ok(!/SECRETHASH|SALT|sn_users|sn_cloud_|pwh|ref1|tok1.*value/.test(sent.replace(/"tok":"tok1"/g, '')), 'no password data or session tokens uploaded'); assert.ok(S.posts[0].prefer.includes('merge-duplicates')); console.log('nothing sensitive uploaded ok');
  // auto backup only when something changed
  const n0 = S.posts.length; ev('cloudAutoTick()'); await sleep(100); assert.strictEqual(S.posts.length, n0, 'no change => no upload'); ev("storeSet('hw_kid', [{id:1,subj:'maths',text:'CHANGED',done:true}])"); ev('cloudAutoTick()'); await sleep(200); assert.ok(S.posts.length > n0 && S.rows['sn_hw_kid'][0].text === 'CHANGED'); console.log('auto backup ok');
  // expired token -> refresh
  const s = ev('cloudSess()'); s.exp = 1; ev(`storeSet('cloud_kid', ${JSON.stringify(s)})`); ev("storeSet('hw_kid', [{id:2,subj:'physics',text:'after refresh',done:false}])"); await ev('cloudBackup(true)'); assert.strictEqual(S.refreshed, 1); assert.ok(S.posts[S.posts.length - 1].tok === 'tok2'); console.log('token refresh ok');
  // restore on a "new phone"
  ev("localStorage.removeItem('sn_hw_kid'); localStorage.removeItem('sn_cards_kid');"); await ev('cloudRestore()'); assert.strictEqual(ev("storeGet('hw_kid')[0].text"), 'after refresh'); assert.ok(ev("storeGet('cards_kid')[0].front") === 'f'); console.log('restore ok');
  // sign out
  ev('cloudSignOut()'); await sleep(80); assert.strictEqual(ev("cloudSess()"), null); assert.ok(d.getElementById('cloudEmail')); console.log('sign out ok');
  console.log('page errors:', errs); assert.strictEqual(errs.length, 0); console.log('CLOUD ALL PASSED'); process.exit(0);
})().catch(e => { console.error('FAIL', e.stack || e); process.exit(1); });
