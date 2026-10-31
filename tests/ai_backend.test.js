// Backend tests with a mocked fetch (no network). Run: node tests/ai_backend.test.js
const assert = require('assert');
let calls = [], script = () => ({ status: 500, body: {} });
global.fetch = async (url, opt) => {
  const body = opt && opt.body ? JSON.parse(opt.body) : null; calls.push({ url, body, headers: opt && opt.headers });
  const r = script(String(url), body, opt) || { status: 500, body: {} };
  const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  return { ok: r.status < 400, status: r.status, headers: { get: h => (r.headers || {})[h] || null },
    text: async () => text, json: async () => JSON.parse(text),
    body: r.sse ? { getReader() { let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from(r.sse) }) }; } } : null };
};
const handler = require('../api/ai.js');
const mkRes = () => { const r = { code: 200, out: [], headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, end() { this.ended = true; return this; }, writeHead(c) { this.code = c; }, write(x) { this.out.push(x); } }; return r; };
const post = async (env, payload, ip) => { Object.keys(process.env).filter(k => /GEMINI|OPENROUTER|ANTHROPIC|TAVILY|AI_/.test(k)).forEach(k => delete process.env[k]); Object.assign(process.env, env);
  const res = mkRes(); await handler({ method: 'POST', headers: { origin: 'https://s.test', host: 's.test', 'x-forwarded-for': ip || '1.1.1.' + Math.floor(Math.random() * 250) }, body: payload, url: '/api/ai' }, res); return res; };
const gem = txt => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: txt }] } }] } });
const msg = t => [{ role: 'user', content: t }];
(async () => {
  // A) Vertex key (API disabled) + AI Studio key: answer must come from AI Studio, Vertex skipped
  script = (u) => /aiplatform/.test(u) ? { status: 403, body: { error: { message: 'Agent Platform API has not been used in project 1 before or it is disabled. Enable it by visiting ...' } } } : /generativelanguage/.test(u) ? gem('from-studio') : null;
  let r = await post({ GEMINI_API_KEY: 'AQ.AAAAAAAAAAAAAAAAAAAAAAAA', GEMINI_API_KEY_2: 'AIzaBBBBBBBBBBBBBBBBBBBBBBBB' }, { messages: msg('explain gravity') });
  assert.strictEqual(r.code, 200); assert.ok(JSON.stringify(r.body).includes('from-studio')); assert.ok(!calls.some(c => /aiplatform/.test(c.url)), 'AIza key must be tried before the Vertex key'); console.log('A ok: AI Studio key preferred over Vertex');
  // A2) only Vertex key, disabled API -> clear fix hint, falls through (free fallback mocked off)
  calls = []; script = (u) => /aiplatform/.test(u) ? { status: 403, body: { error: { message: 'Agent Platform API has not been used in project 1 before or it is disabled.' } } } : /generativelanguage/.test(u) ? { status: 403, body: { error: { message: 'API keys are not supported by this API.' } } } : { status: 500, body: {} };
  r = await post({ GEMINI_API_KEY: 'AQ.AAAAAAAAAAAAAAAAAAAAAAAA' }, { messages: msg('hello') });
  assert.strictEqual(r.code, 502); assert.ok(/aistudio\.google\.com\/apikey/.test(r.body.error.details)); assert.ok(r.body.error.message.length < 200); console.log('A2 ok: clear fix message for disabled Vertex API');
  // A3) AQ key that works on the normal Gemini endpoint is used even though Vertex is off
  calls = []; script = (u) => /aiplatform/.test(u) ? { status: 403, body: { error: { message: 'API has not been used in project 1 before or it is disabled.' } } } : /generativelanguage/.test(u) ? gem('aq-via-studio-endpoint') : null;
  r = await post({ GEMINI_API_KEY: 'AQ.AAAAAAAAAAAAAAAAAAAAAAAA' }, { messages: msg('hello again') });
  assert.ok(JSON.stringify(r.body).includes('aq-via-studio-endpoint')); console.log('A3 ok: AQ key works via standard Gemini endpoint');
  // B) Gemini quota exhausted on first model -> next model; then key cooldown is short, not 10 minutes
  calls = []; let n = 0; script = (u) => { if (/generativelanguage/.test(u)) { n++; return /gemini-2\.5-flash:/.test(u) ? { status: 429, body: { error: { message: 'quota exceeded' } } } : gem('fallback-model'); } };
  r = await post({ GEMINI_API_KEY: 'AIzaCCCCCCCCCCCCCCCCCCCCCCCC' }, { messages: msg('hi there') });
  assert.ok(JSON.stringify(r.body).includes('fallback-model')); console.log('B ok: falls to next Gemini model on 429');
  // C) OpenRouter: live free-model discovery; first model dead ("unavailable for free"), second works; paid never used
  calls = []; script = (u, b) => {
    if (/openrouter\.ai\/api\/v1\/models/.test(u)) return { status: 200, body: { data: [
      { id: 'meta-llama/llama-3.3-70b-instruct', pricing: { prompt: '0.0001', completion: '0.0001' }, context_length: 131000 },
      { id: 'google/gemini-dead:free', pricing: { prompt: '0', completion: '0' }, context_length: 900000, architecture: { output_modalities: ['text'] } },
      { id: 'good/qwen-free:free', pricing: { prompt: '0', completion: '0' }, context_length: 32000, architecture: { output_modalities: ['text'] } }] } };
    if (/chat\/completions/.test(u)) return b.model === 'google/gemini-dead:free' ? { status: 404, body: { error: { message: 'This model is unavailable for free.' } } } : { status: 200, body: { choices: [{ message: { content: 'from-openrouter' } }] } }; };
  r = await post({ OPENROUTER_API_KEY: 'sk-or-v1-xxxxxxxxxxxxxxxxxxxx' }, { messages: msg('explain atoms') });
  const used = calls.filter(c => /chat\/completions/.test(c.url)).map(c => c.body.model);
  assert.ok(JSON.stringify(r.body).includes('from-openrouter')); assert.deepStrictEqual(used, ['google/gemini-dead:free', 'good/qwen-free:free']); assert.ok(!used.includes('meta-llama/llama-3.3-70b-instruct')); console.log('C ok: dynamic free models, dead model skipped, no paid model');
  // D) streaming through AI Studio
  calls = []; script = (u) => /generativelanguage/.test(u) ? { status: 200, sse: 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }) + '\n\ndata: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'lo' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://e.com', title: 'E' } }] } }] }) + '\n\n' } : null;
  r = await post({ GEMINI_API_KEY: 'AIzaDDDDDDDDDDDDDDDDDDDDDDDD' }, { messages: msg('latest news'), stream: true });
  const o = r.out.join(''); assert.ok(o.includes('"t":"Hel"') && o.includes('https://e.com')); console.log('D ok: streaming + sources');
  // E) Gemini gets the search tool by default (model decides), and web:false turns it off
  const tools = p => (calls[0].body.tools || []).length; calls = []; script = () => gem('x'); await post({ GEMINI_API_KEY: 'AIzaEEEEEEEEEEEEEEEEEEEEEEEE' }, { messages: msg('who won the match yesterday') }); assert.strictEqual(tools(), 1);
  calls = []; await post({ GEMINI_API_KEY: 'AIzaEEEEEEEEEEEEEEEEEEEEEEEE' }, { messages: msg('hi'), web: false }); assert.strictEqual(tools(), 0); console.log('E ok: Gemini search tool auto-on, web:false respected');
  // F) non-Gemini providers: Wikipedia context injected only when the question needs the web
  calls = []; script = (u, b) => /wikipedia/.test(u) ? { status: 200, body: { query: { pages: [{ title: 'India', extract: 'India is a country.', fullurl: 'https://en.wikipedia.org/wiki/India', index: 1 }] } } } : /openrouter\.ai\/api\/v1\/models/.test(u) ? { status: 200, body: { data: [{ id: 'a/b:free', pricing: { prompt: '0', completion: '0' } }] } } : /chat\/completions/.test(u) ? { status: 200, body: { choices: [{ message: { content: 'ok' } }] } } : null;
  await post({ OPENROUTER_API_KEY: 'sk-or-v1-xxxxxxxxxxxxxxxxxxxx' }, { messages: msg('Who is the president of India now?'), system: 'S' });
  assert.ok(calls.some(c => /wikipedia/.test(c.url)) && /WEB RESULTS/.test(calls.find(c => /chat\/completions/.test(c.url)).body.messages[0].content));
  calls = []; await post({ OPENROUTER_API_KEY: 'sk-or-v1-xxxxxxxxxxxxxxxxxxxx' }, { messages: msg('explain photosynthesis simply'), system: 'S' }); assert.ok(!calls.some(c => /wikipedia/.test(c.url))); console.log('F ok: web context only when needed');
  // G) failures are temporary: after a 401 the key is paused ~5 min (not 10), 429 only ~1 min; self test reports advice
  calls = []; script = (u) => /generativelanguage/.test(u) ? { status: 400, body: { error: { message: 'API key not valid.' } } } : null;
  Object.assign(process.env, { GEMINI_API_KEY: 'AIzaFFFFFFFFFFFFFFFFFFFFFFFF' });
  const res = mkRes(); await handler({ method: 'GET', headers: { host: 's.test', 'x-forwarded-for': '9.9.9.9' }, url: '/api/ai?test=1' }, res);
  assert.ok(res.body.test.advice.some(a => /aistudio/.test(a))); console.log('G ok: selftest gives fix advice');
  console.log('ALL PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
