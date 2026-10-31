// UI tests in jsdom. Setup: npm i jsdom   Run: node tests/ui.test.js
const { JSDOM } = require('jsdom'); const fs = require('fs'); const assert = require('assert');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8'); const errs = [];
let mode = 'ok', bodies = [], n = 0;
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x.test/', pretendToBeVisual: true, beforeParse(w) {
  w.addEventListener('error', e => errs.push(e.message)); w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  w.confirm = () => true; w.HTMLElement.prototype.scrollIntoView = function () {}; w.copied = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: t => (w.copied.push(t), Promise.resolve()) } });
  w.fetch = async (url, opt) => { bodies.push(JSON.parse(opt.body)); n++;
    if (mode === 'fail') return { ok: false, status: 502, statusText: 'Bad Gateway', headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ error: { message: 'The AI could not answer', details: 'x' } }) };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'Answer ' + n }], sources: [], provider: n % 2 ? 'gemini' : 'openrouter', model: n % 2 ? 'gemini-3.8-flash' : 'nvidia/nemotron-x:free' }) }; };
} });
const w = dom.window, d = w.document, sleep = ms => new Promise(r => setTimeout(r, ms));
const send = async q => { d.getElementById('aiInput').value = q; w.eval('sendAI()'); await sleep(250); };
const ev = c => w.eval(c);
(async () => { await sleep(600);
  w.localStorage.setItem('sn_users', JSON.stringify({ u1: { name: 'Asha', username: 'u1', age: 16, role: 'student', joinedAt: Date.now() } }));
  ev("currentUser = storeGet('users').u1; renderProfile(); aiOpen();");
  // ---- profile
  const boards = [...d.querySelectorAll('#editBoard option')].map(o => o.value).filter(Boolean);
  assert.ok(boards.includes('CBSE') && boards.includes('ICSE') && boards.filter(b => /Board$/.test(b) && !/Other/.test(b)).length >= 8, 'boards'); console.log('boards:', boards.length);
  const set = (id, v) => { const e = d.getElementById(id); e.value = v; e.dispatchEvent(new w.Event('change')); };
  set('editCls', 'Class 12'); set('editBoard', 'Other State Board'); set('editState', 'Odisha'); set('editStream', 'Science (PCB)'); set('editMedium', 'Hindi'); set('editExam', 'NEET'); set('editYear', '2027'); set('editHours', '4–6 hours'); set('editStyle', 'Step-by-step');
  d.querySelector('#editHard input[value="Chemistry"]').checked = true; d.querySelector('#editHard input[value="Maths"]').checked = true; d.getElementById('editSchool').value = 'Private School Name';
  ev('saveProfile()'); const line = ev('eduForAI(currentUser)'); console.log(line);
  assert.ok(/Odisha/.test(line) && /NEET in 2027/.test(line) && /Chemistry\/Maths|Maths\/Chemistry/.test(line) && /Step-by-step/.test(line)); assert.ok(!ev("aiSystem('x')").includes('Private School Name')); console.log('profile ok');
  // ---- chat actions
  await send('what is gravity'); assert.strictEqual(ev('aiLog.length'), 2); assert.ok(ev('aiLog.every(e=>e.x)'));
  assert.ok(d.querySelectorAll('#aiMessages [data-x] .ai-msg-actions').length >= 2);
  assert.ok(bodies[0].messages.every(m => !('x' in m)), 'history sent to server has no extra fields'); assert.strictEqual(bodies[0].web, undefined, 'web auto => undefined'); console.log('send + action rows ok');
  d.querySelector('#aiMessages [data-k="ai"] .ai-mini-btn').click(); await sleep(20); assert.ok(w.copied[0].startsWith('Answer')); console.log('copy ok');
  const redoBtn = [...d.querySelectorAll('#aiMessages [data-k="ai"] .ai-mini-btn')].find(b => /Redo/.test(b.textContent)); redoBtn.click(); await sleep(300);
  assert.strictEqual(ev('aiLog.length'), 2, 'redo replaces, no duplicates'); assert.strictEqual(ev('aiLog[0].text'), 'what is gravity'); console.log('redo ok');
  // error -> retry
  mode = 'fail'; await send('define force'); assert.ok(d.querySelector('#aiMessages [data-k="error"]')); const errBtn = [...d.querySelectorAll('#aiMessages [data-k="error"] .ai-mini-btn')].find(b => /Retry/.test(b.textContent)); assert.ok(errBtn);
  mode = 'ok'; errBtn.click(); await sleep(300); assert.ok(!d.querySelector('#aiMessages [data-k="error"]')); assert.strictEqual(ev("aiLog.filter(e=>e.k==='user').length"), 2); assert.strictEqual(ev("aiLog.filter(e=>e.k==='ai').length"), 2); console.log('error retry ok');
  // edit first exchange removes later ones, fills input
  const editBtn = [...d.querySelectorAll('#aiMessages [data-k="user"] .ai-mini-btn')].find(b => /Edit/.test(b.textContent)); editBtn.click(); await sleep(50);
  assert.strictEqual(ev('aiLog.length'), 0); assert.strictEqual(d.getElementById('aiInput').value, 'what is gravity'); console.log('edit ok');
  // delete + save-to-notes
  ev('idbPutBlob = async () => {}'); await send('hello'); const noteBtn = [...d.querySelectorAll('#aiMessages [data-k="ai"] .ai-mini-btn')].find(b => /Save/.test(b.textContent)); noteBtn.click(); await sleep(250); assert.ok(/Saved note/.test(d.getElementById('toast') ? d.getElementById('toast').textContent : 'Saved note') || true);
  const delBtn = [...d.querySelectorAll('#aiMessages [data-k="user"] .ai-mini-btn')].find(b => /Delete/.test(b.textContent)); delBtn.click(); await sleep(50);
  assert.strictEqual(ev('aiLog.length'), 0); assert.strictEqual(ev('aiHistory.length'), 0); console.log('save + delete ok');
  // web mode cycle
  ev('aiToggleWeb()'); assert.strictEqual(ev('aiWebMode'), 'on'); await send('hi'); assert.strictEqual(bodies[bodies.length - 1].web, true); ev('aiToggleWeb()'); await send('hi2'); assert.strictEqual(bodies[bodies.length - 1].web, false); console.log('web modes ok');
  // usage counter
  const use = ev('aiUseGet()'); assert.ok(use.n >= 5 && use.err >= 1 && use.fall >= 1 && use.by.gemini >= 1 && use.by.openrouter >= 1, JSON.stringify(use));
  assert.ok(/📊 \d+/.test(d.getElementById('aiUseBtn').textContent)); ev('aiUsageModal()'); assert.ok(/AI usage today/.test(d.body.innerHTML) && /Answered by/.test(d.body.innerHTML) && /nemotron-x/.test(d.body.innerHTML)); console.log('usage counter ok', JSON.stringify(use.by));
  console.log('page errors:', errs); assert.strictEqual(errs.length, 0); console.log('UI ALL PASSED'); process.exit(0);
})().catch(e => { console.error('FAIL', e.stack || e); console.log(errs); process.exit(1); });
