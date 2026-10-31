// Security/privacy tests in jsdom. Setup: npm i jsdom   Run: node tests/security.test.js
const { JSDOM } = require('jsdom'); const fs = require('fs'); const assert = require('assert'); const nodeCrypto = require('crypto');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8'); const errs = []; let bodies = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x.test/', pretendToBeVisual: true, beforeParse(w) {
  w.addEventListener('error', e => errs.push(e.message)); w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  Object.defineProperty(w.crypto, 'subtle', { value: nodeCrypto.webcrypto.subtle }); w.HTMLElement.prototype.scrollIntoView = function () {}; w.scrollTo = () => {};
  w.confirm = () => true; w.prompt = () => 'asha'; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  w.fetch = async (u, o) => { if (o && o.body) bodies.push(JSON.parse(o.body)); return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) }; };
} });
const w = dom.window, d = w.document, sleep = ms => new Promise(r => setTimeout(r, ms)), ev = c => w.eval(c), val = (id, v) => { d.getElementById(id).value = v; };
(async () => { await sleep(500);
  // signup: hashed password, no plain text; bad usernames rejected
  val('signupName', 'Asha Verma'); val('signupUser', '<img src=x>'); val('signupPass', 'secret1'); val('signupAge', '15'); await ev('doSignup()'); assert.ok(/Username/.test(d.getElementById('signupErr').textContent), 'bad username rejected');
  val('signupUser', 'asha'); await ev('doSignup()'); let users = JSON.parse(w.localStorage.getItem('sn_users')); assert.ok(users.asha.pwh && users.asha.salt && users.asha.password === undefined, 'hash stored, no plain text'); console.log('signup hashing ok');
  // login right/wrong
  ev("doLogout()"); val('loginUser', 'asha'); val('loginPass', 'wrong'); await ev('doLogin()'); assert.ok(ev('currentUser') === null, 'wrong password rejected');
  val('loginPass', 'secret1'); await ev('doLogin()'); assert.strictEqual(ev('currentUser.username'), 'asha'); console.log('login ok');
  // legacy plain-text account is upgraded on first login
  users = JSON.parse(w.localStorage.getItem('sn_users')); users.old = { username: 'old', name: 'Old User', password: 'plain99', age: 14, role: 'student', friends: [], pendingOut: [], pendingIn: [] }; w.localStorage.setItem('sn_users', JSON.stringify(users));
  ev('doLogout()'); val('loginUser', 'old'); val('loginPass', 'plain99'); await ev('doLogin()'); users = JSON.parse(w.localStorage.getItem('sn_users')); assert.ok(users.old.pwh && users.old.password === undefined, 'legacy upgraded'); console.log('legacy password migration ok');
  ev('doLogout()'); val('loginUser', 'asha'); val('loginPass', 'secret1'); await ev('doLogin()');
  // names are escaped in the page
  users = JSON.parse(w.localStorage.getItem('sn_users')); users.asha.name = '<img src=x onerror="window.__xss=1">Asha'; w.localStorage.setItem('sn_users', JSON.stringify(users)); ev("currentUser = storeGet('users').asha; renderProfile();");
  assert.ok(!d.getElementById('pfName').querySelector('img') && !w.__xss, 'name is escaped'); console.log('escaping ok');
  // AI sees no identity
  ev("currentUser.name = 'Zorbo Quill'; currentUser.age = 13;"); const snap = ev("aiSnapshot('help me')"), sys = ev("aiSystem('x')");
  assert.ok(!/Zorbo|Quill|asha|age=/.test(snap), 'no identity in AI snapshot'); assert.ok(/ACCURACY RULES/.test(sys)); console.log('AI privacy + accuracy rules ok');
  // backup / restore / delete
  ev("storeSet('hw_asha', [{id:1,subj:'maths',text:'ex 4',done:false}]); storeSet('plan_asha', {examDate:'2027-03-01'});"); const keys = ev('myDataKeys()'); assert.ok(keys.includes('sn_hw_asha') && !keys.includes('sn_users') && !keys.some(k => /bob/.test(k))); 
  let dl = null; const oc = w.HTMLAnchorElement.prototype.click; w.HTMLAnchorElement.prototype.click = function () { dl = this.download; }; ev('exportMyData()'); w.HTMLAnchorElement.prototype.click = oc; assert.ok(/studynest-backup-asha/.test(dl)); 
  const backup = JSON.stringify({ app: 'StudyNest', version: 1, username: 'asha', profile: {}, keys: { sn_hw_asha: JSON.stringify([{ id: 9, subj: 'physics', text: 'restored', done: false }]) } }); ev("storeSet('hw_asha', [])");
  ev('importMyData')(new w.File([backup], 'b.json')); await sleep(200); assert.strictEqual(ev("storeGet('hw_asha')[0].text"), 'restored', 'restore works');
  ev('importMyData')(new w.File([JSON.stringify({ app: 'StudyNest', username: 'someoneelse', keys: { sn_hw_asha: '[]' } })], 'b.json')); await sleep(100); assert.strictEqual(ev("storeGet('hw_asha')[0].text"), 'restored', "another user's backup is refused"); console.log('backup/restore ok');
  ev('deleteMyAccount()'); users = JSON.parse(w.localStorage.getItem('sn_users')); assert.ok(!users.asha && !w.localStorage.getItem('sn_hw_asha') && !w.localStorage.getItem('sn_plan_asha') && users.old, 'deleted only my data'); console.log('delete ok');
  // verify button forces web search and asks for a fact-check
  val('loginUser', 'old'); val('loginPass', 'plain99'); await ev('doLogin()'); ev("aiOpen()"); d.getElementById('aiInput').value = 'what is 12*12'; ev('sendAI()'); await sleep(300); bodies = [];
  const vb = [...d.querySelectorAll('#aiMessages [data-k="ai"] .ai-mini-btn')].find(b => /Verify/.test(b.textContent)); assert.ok(vb, 'verify button'); vb.click(); await sleep(300);
  assert.strictEqual(bodies[bodies.length - 1].web, true); assert.ok(/Fact-check/.test(bodies[bodies.length - 1].messages.slice(-1)[0].content[0].text || bodies[bodies.length - 1].messages.slice(-1)[0].content)); console.log('verify ok');
  console.log('page errors:', errs); assert.strictEqual(errs.length, 0); console.log('SECURITY ALL PASSED'); process.exit(0);
})().catch(e => { console.error('FAIL', e.stack || e); console.log(errs); process.exit(1); });
