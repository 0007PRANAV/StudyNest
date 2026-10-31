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
const post = async (env, payload, ip) => { Object.keys(process.env).filter(k => /GEMINI|OPENROUTER|ANTHROPIC|TAVILY|AI_|GROK|COHERE|GROQ|MISTRAL|CEREBRAS/.test(k)).forEach(k => delete process.env[k]); Object.assign(process.env, env);
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
  const o = r.out.join(''); assert.ok(o.includes('"t":"Hel"') && o.includes('https://e.com') && o.includes('"provider":"gemini"') && /"model":"gemini-/.test(o), 'done event reports provider+model'); console.log('D ok: streaming + sources');
  // E) Gemini gets the search tool by default (model decides), and web:false turns it off
  const tools = p => ((calls.find(c => /generateContent/.test(c.url)).body.tools) || []).length; calls = []; script = () => gem('x'); await post({ GEMINI_API_KEY: 'AIzaEEEEEEEEEEEEEEEEEEEEEEEE' }, { messages: msg('who won the match yesterday') }); assert.strictEqual(tools(), 1);
  calls = []; await post({ GEMINI_API_KEY: 'AIzaEEEEEEEEEEEEEEEEEEEEEEEE' }, { messages: msg('hi'), web: false }); assert.strictEqual(tools(), 0); console.log('E ok: Gemini search tool auto-on, web:false respected');
  // F) non-Gemini providers: Wikipedia context injected only when the question needs the web
  calls = []; script = (u, b) => /wikipedia/.test(u) ? { status: 200, body: { query: { pages: [{ title: 'India', extract: 'India is a country.', fullurl: 'https://en.wikipedia.org/wiki/India', index: 1 }] } } } : /openrouter\.ai\/api\/v1\/models/.test(u) ? { status: 200, body: { data: [{ id: 'a/b:free', pricing: { prompt: '0', completion: '0' } }] } } : /chat\/completions/.test(u) ? { status: 200, body: { choices: [{ message: { content: 'ok' } }] } } : null;
  await post({ OPENROUTER_API_KEY: 'sk-or-v1-xxxxxxxxxxxxxxxxxxxx' }, { messages: msg('Who is the president of India now?'), system: 'S' });
  assert.ok(calls.some(c => /wikipedia/.test(c.url)) && /WEB RESULTS/.test(calls.find(c => /chat\/completions/.test(c.url)).body.messages[0].content));
  calls = []; await post({ OPENROUTER_API_KEY: 'sk-or-v1-xxxxxxxxxxxxxxxxxxxx' }, { messages: msg('explain photosynthesis simply'), system: 'S' }); assert.ok(!calls.some(c => /wikipedia/.test(c.url))); console.log('F ok: web context only when needed');
  // H) LIVE BUG: 2.5/2.0 models retired for this key. Discover current models from Google and use the newest.
  calls = []; script = (u, b) => {
    if (/v1beta\/models\?pageSize/.test(u)) return { status: 200, body: { models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.8-flash-image', 'gemini-3.8-pro'].map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) } };
    if (/gemini-3\.8-flash:/.test(u)) return b.generationConfig.thinkingConfig && b.generationConfig.thinkingConfig.thinkingLevel ? { status: 400, body: { error: { message: 'thinking not supported' } } } : gem('from-3.8');
    if (/generativelanguage/.test(u)) return { status: 404, body: { error: { message: 'This model is no longer available to new users.' } } }; };
  r = await post({ GEMINI_API_KEY: 'AQ.GGGGGGGGGGGGGGGGGGGGGGGG' }, { messages: msg('explain atoms please') });
  const gens = calls.filter(c => /generateContent/.test(c.url)).map(c => c.url.match(/models\/([^:]+):/)[1]);
  assert.ok(JSON.stringify(r.body).includes('from-3.8')); assert.ok(!gens.some(g => /2\.5|2\.0|image|pro/.test(g)), 'retired/unsuitable models must not be used: ' + gens); assert.ok(!calls.some(c => /aiplatform/.test(c.url))); console.log('H ok: discovered', gens[0], '(retired models skipped, thinking option retried without on 400)');
  // I) LIVE BUG: OpenRouter free model restricted to "agentic harnesses" must not pause the key
  calls = []; script = (u, b) => { if (/openrouter\.ai\/api\/v1\/models/.test(u)) return { status: 200, body: { data: [{ id: 'thinkingmachines/inkling:free', pricing: { prompt: '0', completion: '0' }, context_length: 900000 }, { id: 'nvidia/nemotron-x:free', pricing: { prompt: '0', completion: '0' }, context_length: 100000 }] } };
    if (/chat\/completions/.test(u)) return b.model.includes('inkling') ? { status: 401, body: { error: { message: 'inkling:free is only available on agentic harnesses.' } } } : { status: 200, body: { choices: [{ message: { content: 'nemotron-ok' } }] } }; };
  r = await post({ OPENROUTER_API_KEY: 'sk-or-v1-yyyyyyyyyyyyyyyyyyyy' }, { messages: msg('explain waves') }); assert.ok(JSON.stringify(r.body).includes('nemotron-ok'));
  r = await post({ OPENROUTER_API_KEY: 'sk-or-v1-yyyyyyyyyyyyyyyyyyyy' }, { messages: msg('explain sound') }); assert.ok(JSON.stringify(r.body).includes('nemotron-ok'), 'key must not be paused'); console.log('I ok: restricted model skipped, key not paused');
  // J) temporary 503 "high demand" is retried once on the same model
  calls = []; let k503 = 0; script = (u) => /v1beta\/models\?pageSize/.test(u) ? { status: 500, body: {} } : /generativelanguage/.test(u) ? (k503++ === 0 ? { status: 503, body: { error: { message: 'high demand' } } } : gem('after-retry')) : null;
  r = await post({ GEMINI_API_KEY: 'AIzaHHHHHHHHHHHHHHHHHHHHHHHH' }, { messages: msg('hi again') }); assert.ok(JSON.stringify(r.body).includes('after-retry')); console.log('J ok: 503 retried');
  // K) Grok (xAI): 2 keys from different accounts; model discovery skips image models; provider reported
  const GK1 = 'sk-GROKKEYONE1111111111111111', GK2 = 'sk-GROKKEYTWO2222222222222222', CK = 'cohere_COHEREKEY333333333333';
  calls = []; script = (u, b, o) => /api\.x\.ai\/v1\/models/.test(u) ? { status: 200, body: { data: [{ id: 'grok-2-image' }, { id: 'grok-3-mini' }, { id: 'grok-4-fast-reasoning' }] } }
    : /api\.x\.ai\/v1\/chat/.test(u) ? { status: 200, body: { choices: [{ message: { content: 'from-grok' } }] } } : /wikipedia/.test(u) ? { status: 200, body: { query: { pages: [] } } } : null;
  r = await post({ GROK_API_KEY_1: GK1, GROK_API_KEY_2: GK2 }, { messages: msg('explain cells') });
  assert.ok(JSON.stringify(r.body).includes('from-grok') && r.body.provider === 'grok', JSON.stringify(r.body)); const gm = calls.find(c => /x\.ai\/v1\/chat/.test(c.url)).body.model; assert.ok(!/image/.test(gm), gm); console.log('K ok: Grok used, model', gm);
  // L) first Grok key rejected (401) -> second key answers; rejected key is then skipped
  calls = []; script = (u, b, o) => /x\.ai\/v1\/models/.test(u) ? { status: 200, body: { data: [{ id: 'grok-3-mini' }] } } : /x\.ai\/v1\/chat/.test(u) ? ((o.headers.authorization || '').includes('KEYONE') ? { status: 401, body: { error: { message: 'Incorrect API key provided' } } } : { status: 200, body: { choices: [{ message: { content: 'key2-answer' } }] } }) : null;
  r = await post({ GROK_API_KEY_1: GK1, GROK_API_KEY_2: GK2 }, { messages: msg('explain atoms again') }); assert.ok(JSON.stringify(r.body).includes('key2-answer'));
  const before1 = calls.filter(c => /x\.ai\/v1\/chat/.test(c.url) && (c.headers.authorization || '').includes('KEYONE')).length; await post({ GROK_API_KEY_1: GK1, GROK_API_KEY_2: GK2 }, { messages: msg('and once more please') });
  assert.strictEqual(calls.filter(c => /x\.ai\/v1\/chat/.test(c.url) && (c.headers.authorization || '').includes('KEYONE')).length, before1, 'rejected key paused'); console.log('L ok: bad key skipped, good key used');
  // M) Grok out of credits -> Cohere answers (v2 chat format)
  calls = []; script = (u, b) => /x\.ai\/v1\/models/.test(u) ? { status: 200, body: { data: [{ id: 'grok-3-mini' }] } } : /x\.ai\/v1\/chat/.test(u) ? { status: 403, body: { error: { message: 'Your newly created team doesn\'t have any credits yet' } } }
    : /cohere\.com\/v2\/models/.test(u) ? { status: 200, body: { models: [{ name: 'command-a-vision-07-2025' }, { name: 'command-r-08-2024' }, { name: 'command-a-03-2025' }] } }
    : /cohere\.com\/v2\/chat/.test(u) ? { status: 200, body: { message: { role: 'assistant', content: [{ type: 'text', text: 'from-cohere' }] } } } : null;
  r = await post({ GROK_API_KEY_1: GK1, COHERE_API_KEY_1: CK }, { messages: msg('explain energy'), system: 'SYS' });
  const cc = calls.find(c => /cohere\.com\/v2\/chat/.test(c.url)); assert.ok(JSON.stringify(r.body).includes('from-cohere') && r.body.provider === 'cohere'); assert.strictEqual(cc.body.model, 'command-a-03-2025'); assert.strictEqual(cc.body.messages[0].role, 'system'); assert.strictEqual(typeof cc.body.messages[1].content, 'string'); console.log('M ok: out-of-credit Grok -> Cohere', cc.body.model);
  // N) streaming through Grok (OpenAI SSE)
  calls = []; script = (u) => /x\.ai\/v1\/models/.test(u) ? { status: 200, body: { data: [{ id: 'grok-3-mini' }] } } : /x\.ai\/v1\/chat/.test(u) ? { status: 200, sse: 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Gro' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: { content: 'k!' } }] }) + '\n\ndata: [DONE]\n\n' } : null;
  r = await post({ GROK_API_KEY_1: 'sk-GROKKEYFOUR4444444444444444' }, { messages: msg('stream please'), stream: true }); const so = r.out.join(''); assert.ok(so.includes('"t":"Gro"') && so.includes('"provider":"grok"')); console.log('N ok: Grok streaming');
  // O) Grok "sk-" keys are not mistaken for OpenRouter/Anthropic; diag counts them
  Object.keys(process.env).filter(k => /GROK|COHERE/.test(k)).forEach(k => delete process.env[k]); Object.assign(process.env, { GROK_API_KEY_1: GK1, GROK_API_KEY_2: GK2, COHERE_API_KEY_1: CK });
  const dres = mkRes(); await handler({ method: 'GET', headers: { host: 's.test', 'x-forwarded-for': '8.8.8.8' }, url: '/api/ai' }, dres); const dg = dres.body; assert.strictEqual(dg.grok_keys_found, 2); assert.strictEqual(dg.cohere_keys_found, 1); assert.strictEqual(dg.openrouter_key_found, false); assert.strictEqual(dg.anthropic_key_found, false); console.log('O ok: diag counts Grok/Cohere');
  // G) failures are temporary: after a 401 the key is paused ~5 min (not 10), 429 only ~1 min; self test reports advice
  calls = []; script = (u) => /generativelanguage/.test(u) ? { status: 400, body: { error: { message: 'API key not valid.' } } } : null;
  Object.assign(process.env, { GEMINI_API_KEY: 'AIzaFFFFFFFFFFFFFFFFFFFFFFFF' });
  const res = mkRes(); await handler({ method: 'GET', headers: { host: 's.test', 'x-forwarded-for': '9.9.9.9' }, url: '/api/ai?test=1' }, res);
  assert.ok(res.body.test.advice.some(a => /aistudio/.test(a))); console.log('G ok: selftest gives fix advice');
  console.log('ALL PASSED');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
