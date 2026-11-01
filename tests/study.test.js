// Study tools tests in jsdom. Setup: npm i jsdom   Run: node tests/study.test.js
const { JSDOM } = require('jsdom'); const fs = require('fs'); const assert = require('assert');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8'); const errs = []; let reply = null, last = null;
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://x.test/', pretendToBeVisual: true, beforeParse(w) {
  w.addEventListener('error', e => errs.push(e.message)); w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {}; w.scrollTo = () => {}; w.confirm = () => true;
  w.fetch = async (u, o) => { last = JSON.parse(o.body); const text = typeof reply === 'function' ? reply(last) : reply; return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ content: [{ type: 'text', text }] }) }; };
} });
const w = dom.window, d = w.document, sleep = ms => new Promise(r => setTimeout(r, ms)), ev = c => w.eval(c);
(async () => { await sleep(500);
  w.localStorage.setItem('sn_users', JSON.stringify({ kid: { username: 'kid', name: 'Kid', age: 16, role: 'student', friends: [], pendingOut: [], pendingIn: [], edu: { cls: 'Class 12', board: 'CBSE', stream: 'Science (PCM)', exam: 'JEE Main / Advanced', year: '2027', hours: '4–6 hours', hard: ['Chemistry'] } } }));
  ev("currentUser = storeGet('users').kid;");
  // ---- planner (pure function)
  const mon = new w.Date(2026, 10, 2), sun = new w.Date(2026, 10, 1), e = ev('currentUser.edu');
  const plan = w.studyPlanFor(e, mon, 100), subs = plan.map(b => b.subj); assert.ok(subs.includes('Chemistry'), 'hard subject always included'); const chem = plan.find(b => b.subj === 'Chemistry').min, other = plan.find(b => b.subj !== 'Chemistry').min; assert.ok(chem >= other * 1.8, 'hard subject gets ~double time ' + chem + ' vs ' + other);
  const tot = plan.reduce((a, b) => a + b.min, 0); assert.ok(tot >= 240 && tot <= 330, 'total ~5h: ' + tot); assert.strictEqual(w.studyPlanFor(e, sun, 100)[0].subj, 'Revision'); assert.ok(/past papers/i.test(w.studyPlanFor(e, mon, 20).map(b => b.task).join()), 'near exam => past papers');
  assert.ok(w.studySubjects({ stream: 'Science (PCB)' }).includes('Biology') && !w.studySubjects({ stream: 'Science (PCB)' }).includes('Maths')); assert.ok(w.studySubjects({ stream: 'Science (PCMB)' }).includes('Biology') && w.studySubjects({ stream: 'Science (PCMB)' }).includes('Maths')); console.log('planner logic ok');
  // ---- planner UI: exam date, checkboxes, streak
  ev("showPage('pageStudy', null)"); assert.ok(/JEE Main \/ Advanced 2027/.test(d.getElementById('studyBody').textContent));
  const future = new w.Date(Date.now() + 40 * 86400000), fs_ = ev('dstr(new Date(' + future.getTime() + '))'); ev(`studySetExam('${fs_}')`); assert.ok(/40/.test(d.getElementById('studyBody').textContent), 'countdown shown');
  const cbs = d.querySelectorAll('#studyBody input[type=checkbox]'); assert.ok(cbs.length >= 1); cbs[0].click(); await sleep(30); assert.strictEqual(ev("studyStreak(sGet('plan',{done:{}}))"), 1); assert.ok(/🔥 1 day/.test(d.getElementById('studyBody').textContent)); console.log('planner UI + streak ok');
  // ---- flashcards via AI (+ XSS safe)
  ev("studyTabSet('cards')"); reply = '```json\n[{"front":"What is <b>force</b>?","back":"A push or pull"},{"front":"Unit of force","back":"Newton (N)"},{"front":"","back":"bad"}]\n```';
  d.getElementById('cardTopic').value = "Newton's laws"; await w.studyCardsFromForm(); let cards = JSON.parse(w.localStorage.getItem('sn_cards_kid')); assert.strictEqual(cards.length, 2, 'invalid card dropped'); assert.ok(/ACCURACY|only include facts|certain/i.test(last.system) && /Class 12/.test(last.system), 'profile + safety in AI prompt'); assert.ok(d.getElementById('studyBody').innerHTML.includes('&lt;b&gt;force&lt;/b&gt;'), 'card text escaped'); console.log('AI flashcards ok');
  await w.studyCardsFromForm; d.getElementById('cardTopic').value = "Newton's laws"; await w.studyCardsFromForm(); assert.strictEqual(JSON.parse(w.localStorage.getItem('sn_cards_kid')).length, 2, 'no duplicates');
  // ---- review (Leitner)
  ev('studyStartReview()'); assert.ok(/Show answer/.test(d.getElementById('studyBody').textContent)); ev('studyReveal()'); ev("studyGrade('good')"); ev('studyReveal()'); ev("studyGrade('again')");
  cards = JSON.parse(w.localStorage.getItem('sn_cards_kid')); const boxes = cards.map(c => c.box).sort(); assert.deepStrictEqual(boxes, [1, 2]); assert.ok(cards.find(c => c.box === 2).due > Date.now() + 86400000 * 0.9, 'good => due in ~1 day'); assert.ok(/Session done/.test(d.getElementById('studyBody').textContent)); console.log('spaced repetition ok');
  // ---- quiz
  ev("studyTabSet('quiz')"); reply = JSON.stringify([{ q: 'Which gas do plants absorb?', options: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Helium'], answer: 1, why: 'Photosynthesis uses CO2.' }, { q: 'Bad question', options: ['a', 'b'], answer: 0, why: '' }, { q: 'Capital of France?', options: ['Paris', 'Rome', 'Madrid', 'Bern'], answer: 0, why: 'Paris is the capital.' }]);
  d.getElementById('quizTopic').value = 'Photosynthesis'; await w.studyQuizFromForm(); assert.strictEqual(ev('studyQuiz.qs.length'), 2, 'invalid question dropped'); 
  const pickRight = () => { const q = ev('studyQuiz'); const idx = q.qs[q.i].opts.findIndex(o => o.c); ev(`studyPick(${idx})`); }; const pickWrong = () => { const q = ev('studyQuiz'); const idx = q.qs[q.i].opts.findIndex(o => !o.c); ev(`studyPick(${idx})`); };
  pickRight(); assert.ok(/Correct/.test(d.getElementById('studyBody').textContent)); ev('studyNextQ()'); pickWrong(); assert.ok(/Not quite/.test(d.getElementById('studyBody').textContent)); ev('studyNextQ()');
  assert.ok(/1 \/ 2/.test(d.getElementById('studyBody').textContent)); assert.strictEqual(ev("sGet('quiz',[])[0].score"), 1); const before = JSON.parse(w.localStorage.getItem('sn_cards_kid')).length; ev('studyMissedToCards()'); assert.strictEqual(JSON.parse(w.localStorage.getItem('sn_cards_kid')).length, before + 1, 'missed question became a card'); console.log('quiz ok');
  // ---- data export includes study data; AI answer -> cards button exists
  assert.ok(ev('myDataKeys()').some(k => /cards_kid|plan_kid|quiz_kid/.test(k))); console.log('study data is in backups');
  console.log('page errors:', errs); assert.strictEqual(errs.length, 0); console.log('STUDY ALL PASSED'); process.exit(0);
})().catch(e => { console.error('FAIL', e.stack || e); console.log(errs); process.exit(1); });
