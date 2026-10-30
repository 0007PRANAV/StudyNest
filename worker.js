const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS = ['google/gemini-2.0-flash-exp:free', 'qwen/qwen2.5-vl-72b-instruct:free', 'meta-llama/llama-3.3-70b-instruct:free'];  // free models only (no charges)
const VERTEX_URL = 'https://aiplatform.googleapis.com/v1/publishers/google/models/';
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];  // free-tier quotas are per model, so falling back to the next one helps

const clampMaxTokens = v => Math.min(Math.max(parseInt(v, 10) || 1000, 1), 4000);
const errMsg = (d, fb) => String((d && d.error && (d.error.message || d.error)) || fb);
const cleanVal = v => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();

function envKey(E, names, fuzzy) {
  const norm = n => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const wanted = names.map(norm);
  for (const name of Object.keys(E || {})) {
    if (typeof E[name] !== 'string' || !E[name].trim()) continue;
    const n = norm(name);
    if (wanted.includes(n) || (fuzzy && fuzzy(n))) return cleanVal(E[name]);
  }
  return '';
}
function getKeys(E) {
  const g = [], add = v => { v = cleanVal(v); if (v && !g.includes(v)) g.push(v); };
  const A = envKey(E, ['ANTHROPIC_API_KEY', 'ANTHROPIC_KEY'], n => n.includes('ANTHROPIC') && n.includes('KEY'));
  let anthropic = A, openrouter = envKey(E, ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'], n => n.includes('OPENROUTER'));
  for (const name of Object.keys(E || {})) {           // detect keys by name OR by their prefix, so odd variable names still work
    const raw = E[name]; if (typeof raw !== 'string') continue; const v = cleanVal(raw), n = name.toUpperCase();
    if (/^sk-ant-/.test(v)) anthropic = anthropic || v;
    else if (/^sk-or-/.test(v)) openrouter = openrouter || v;
    else if (/^(AIza|AQ\.)/.test(v) || ((n.includes('GEMINI') || n.includes('GOOGLE')) && n.includes('KEY') && v.length > 20)) add(v);
  }
  return { anthropic, gemini: g, openrouter, provider: String(envKey(E, ['AI_PROVIDER']) || '').toLowerCase() };
}
async function postJSON(url, headers, body, ms) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms || 40000);
  try {
    const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body), signal: ac.signal });
    const text = await r.text(); let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, data, text };
  } catch (e) {
    const m = e && e.name === 'AbortError' ? 'timed out after ' + Math.round((ms || 40000) / 1000) + 's' : 'network error';
    return { ok: false, status: 599, data: { error: { message: m } }, text: '' };
  } finally { clearTimeout(t); }
}
// keys the providers rejected are skipped for 10 minutes so later requests fail fast
const BAD = new Map();
const isBad = k => (BAD.get(k) || 0) > Date.now();
const noteBad = (k, r) => { if (r.status === 401 || (r.status === 400 && /api key not valid|api_key_invalid/i.test(r.text || '')) || /user not found|invalid api key/i.test(r.text || '')) BAD.set(k, Date.now() + 600000); };

async function callAnthropic(payload, key, E) {
  const models = E.ANTHROPIC_MODEL || E.AI_MODEL ? [cleanVal(E.ANTHROPIC_MODEL || E.AI_MODEL)] : ANTHROPIC_MODELS;
  let last;
  if (isBad(key)) return { status: 401, error: 'Anthropic key skipped: it was rejected earlier. Replace it in Vercel and redeploy.' };
  for (const model of models) {
    const body = { model, max_tokens: clampMaxTokens(payload.max_tokens), messages: payload.messages };
    if (payload.system) body.system = String(payload.system);
    const r = await postJSON(ANTHROPIC_URL, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body);
    if (r.ok) return { status: 200, body: r.data || { content: [] } };
    noteBad(key, r);
    last = { status: r.status, error: 'Anthropic (' + model + '): ' + errMsg(r.data, 'HTTP ' + r.status) };
    if (r.status !== 404) break;
  }
  return last;
}

function toGeminiContents(messages, camel) {
  const contents = [];
  for (const m of messages) {
    const parts = [];
    if (typeof m.content === 'string') parts.push({ text: m.content });
    else if (Array.isArray(m.content)) for (const b of m.content) {
      if (!b) continue;
      if (b.type === 'text' && b.text) parts.push({ text: String(b.text) });
      else if ((b.type === 'image' || b.type === 'document') && b.source && b.source.data) {
        const mt = b.source.media_type || (b.type === 'document' ? 'application/pdf' : 'image/jpeg');
        parts.push(camel ? { inlineData: { mimeType: mt, data: b.source.data } } : { inline_data: { mime_type: mt, data: b.source.data } });
      }
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}
function geminiBody(payload, vx, tools) {
  const b = { contents: toGeminiContents(payload.messages, vx), generationConfig: { maxOutputTokens: clampMaxTokens(payload.max_tokens) } };
  if (payload.system) b[vx ? 'systemInstruction' : 'system_instruction'] = { parts: [{ text: String(payload.system) }] };
  if (tools) b.tools = [vx ? { googleSearch: {} } : { google_search: {} }];   // Google Search grounding (live web results + sources)
  return b;
}
function gemSources(cd) {
  const out = [], seen = new Set();
  for (const ch of ((cd && cd.groundingMetadata && cd.groundingMetadata.groundingChunks) || [])) {
    const w = ch && ch.web; if (w && w.uri && !seen.has(w.uri)) { seen.add(w.uri); out.push({ title: w.title || w.uri, url: w.uri }); }
  }
  return out.slice(0, 6);
}
async function callGemini(payload, keys, E) {
  const models = E.GEMINI_MODEL || E.AI_MODEL ? [cleanVal(E.GEMINI_MODEL || E.AI_MODEL)] : GEMINI_MODELS, errs = [];
  for (let ki = 0; ki < keys.length; ki++) {
    if (isBad(keys[ki])) { errs.push('Gemini key ' + (ki + 1) + ' skipped: Google rejected it earlier. Replace it in Vercel and redeploy.'); continue; }
    const vx = /^AQ\./.test(keys[ki]);   // "AQ." keys are Vertex AI express keys; "AIza" keys are Google AI Studio keys
    for (const model of models) {
      const url = (vx ? VERTEX_URL : GEMINI_URL) + encodeURIComponent(model) + ':generateContent', tag = 'Gemini key ' + (ki + 1) + ' [' + (vx ? 'Vertex' : 'AI Studio') + ', ' + model + ']';
      let r;
      for (const tools of (payload.web ? [true, false] : [false])) {          // if the search tool is refused (400), retry without it
        r = await postJSON(url, { 'x-goog-api-key': keys[ki] }, geminiBody(payload, vx, tools));
        if (r.ok || r.status !== 400 || !tools) break;
      }
      if (!r.ok) { noteBad(keys[ki], r); errs.push(tag + ': ' + errMsg(r.data, 'HTTP ' + r.status)); if ([404, 429, 503].includes(r.status)) continue; break; }
      const cd = r.data && r.data.candidates && r.data.candidates[0];
      const answer = ((cd && cd.content && cd.content.parts) || []).filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('\n').trim();
      if (answer) return { status: 200, body: { content: [{ type: 'text', text: answer }], sources: gemSources(cd) } };
      errs.push(tag + ' returned no text (' + ((cd && cd.finishReason) || (r.data && r.data.promptFeedback && r.data.promptFeedback.blockReason) || 'empty') + ').'); break;
    }
  }
  return { status: 502, error: errs.join(' | ') || 'No Gemini key available.' };
}

function toORMessages(payload) {
  const msgs = [];
  if (payload.system) msgs.push({ role: 'system', content: String(payload.system) });
  for (const m of payload.messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') { msgs.push({ role, content: m.content }); continue; }
    if (!Array.isArray(m.content)) continue;
    const parts = [];
    for (const b of m.content) {
      if (!b) continue;
      if (b.type === 'text' && b.text) parts.push({ type: 'text', text: String(b.text) });
      else if (b.type === 'image' && b.source && b.source.data) parts.push({ type: 'image_url', image_url: { url: 'data:' + (b.source.media_type || 'image/jpeg') + ';base64,' + b.source.data } });
      else if (b.type === 'document' && b.source && b.source.data) parts.push({ type: 'file', file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,' + b.source.data } });
    }
    if (parts.length) msgs.push({ role, content: parts });
  }
  return msgs;
}

async function callOpenRouter(payload, key, E) {
  const models = E.OPENROUTER_MODEL ? [cleanVal(E.OPENROUTER_MODEL)] : OPENROUTER_MODELS;
  const msgs = toORMessages(payload);
  let last;
  if (isBad(key)) return { status: 401, error: 'OpenRouter key skipped: it was rejected earlier (User not found). Replace it in Vercel and redeploy.' };
  for (const model of models) {
    const r = await postJSON(OPENROUTER_URL, { authorization: 'Bearer ' + key, 'x-title': 'StudyNest' }, { model, messages: msgs, max_tokens: clampMaxTokens(payload.max_tokens) });
    const a = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    if (r.ok && typeof a === 'string' && a.trim()) return { status: 200, body: { content: [{ type: 'text', text: a.trim() }] } };
    noteBad(key, r);
    last = { status: r.ok ? 502 : r.status, error: 'OpenRouter (' + model + '): ' + (r.ok ? 'empty response' : errMsg(r.data, 'HTTP ' + r.status)) };
    if (![400, 404].includes(r.status)) break;
  }
  return last;
}

async function callPollinations(payload) {
  const msgs = [];
  if (payload.system) msgs.push({ role: 'system', content: String(payload.system) });
  for (const m of payload.messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') { msgs.push({ role, content: m.content }); continue; }
    if (!Array.isArray(m.content)) continue;
    if (m.content.some(b => b && (b.type === 'image' || b.type === 'document'))) return { status: 422, error: 'Images and PDFs need a working Gemini or Anthropic key.' };
    const t = m.content.filter(b => b && b.type === 'text' && b.text).map(b => String(b.text)).join('\n');
    if (t) msgs.push({ role, content: t });
  }
  const r = await postJSON(POLLINATIONS_URL, {}, { model: 'openai-fast', messages: msgs, max_tokens: clampMaxTokens(payload.max_tokens) }, 12000);
  if (!r.ok) return { status: r.status === 402 ? 429 : r.status, error: r.status === 402 ? 'Free AI is busy. Try again in 30 seconds.' : 'Free AI: ' + errMsg(r.data, 'HTTP ' + r.status) };
  let a = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
  if (typeof a !== 'string') a = r.text.trim();
  return a ? { status: 200, body: { content: [{ type: 'text', text: a }], provider: 'pollinations' } } : { status: 502, error: 'Free AI returned an empty response.' };
}

const lastUserText = payload => {
  const m = [...(payload.messages || [])].reverse().find(x => x && x.role === 'user'); if (!m) return '';
  return typeof m.content === 'string' ? m.content : (m.content || []).filter(b => b && b.type === 'text').map(b => b.text).join(' ');
};
// Free, keyless web context from Wikipedia (used when the chosen model has no built-in web search).
async function wikiContext(q) {
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!q) return null;
  const url = 'https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=3&prop=extracts%7Cinfo&exintro=1&explaintext=1&exchars=1000&inprop=url&format=json&formatversion=2&origin=*&gsrsearch=' + encodeURIComponent(q);
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'StudyNest/1.0 (https://github.com/0007PRANAV/StudyNest)' }, signal: ac.signal });
    if (!r.ok) return null;
    const d = await r.json(), pages = (((d || {}).query || {}).pages || []).filter(p => p && p.extract).sort((a, b) => (a.index || 0) - (b.index || 0));
    if (!pages.length) return null;
    return { sources: pages.map(p => ({ title: p.title, url: p.fullurl })), text: pages.map(p => '[' + p.title + '] (' + p.fullurl + ')\n' + p.extract).join('\n\n') };
  } catch (e) { return null; } finally { clearTimeout(t); }
}
async function withWeb(payload) {
  if (!payload.web) return { p: payload, sources: null };
  const w = await wikiContext(lastUserText(payload));
  return w ? { p: Object.assign({}, payload, { system: (payload.system || '') + '\n\nWEB RESULTS (Wikipedia). Use them when relevant and mention the article title:\n' + w.text }), sources: w.sources } : { p: payload, sources: null };
}

// ---- streaming (Server-Sent Events) ----
async function readSSE(resp, onData) {
  const reader = resp.body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const line = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (line === '[DONE]') return;
      if (line) { try { onData(JSON.parse(line)); } catch (e) {} }
    }
  }
}
async function openStream(url, headers, body, ms) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms || 50000);
  try {
    const resp = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body), signal: ac.signal });
    if (!resp.ok) { const text = await resp.text(); let data = null; try { data = JSON.parse(text); } catch (e) {} clearTimeout(t); return { ok: false, status: resp.status, data, text }; }
    return { ok: true, resp, done: () => clearTimeout(t) };
  } catch (e) { clearTimeout(t); return { ok: false, status: 599, data: { error: { message: e && e.name === 'AbortError' ? 'timed out' : 'network error' } }, text: '' }; }
}
async function streamGemini(payload, keys, E, sink) {
  const models = E.GEMINI_MODEL || E.AI_MODEL ? [cleanVal(E.GEMINI_MODEL || E.AI_MODEL)] : GEMINI_MODELS, errs = [];
  for (let ki = 0; ki < keys.length; ki++) {
    if (isBad(keys[ki])) { errs.push('Gemini key ' + (ki + 1) + ' skipped: Google rejected it earlier.'); continue; }
    const vx = /^AQ\./.test(keys[ki]);
    for (const model of models) {
      const url = (vx ? VERTEX_URL : GEMINI_URL) + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', tag = 'Gemini key ' + (ki + 1) + ' [' + (vx ? 'Vertex' : 'AI Studio') + ', ' + model + ']';
      let o;
      for (const tools of (payload.web ? [true, false] : [false])) {
        o = await openStream(url, { 'x-goog-api-key': keys[ki] }, geminiBody(payload, vx, tools));
        if (o.ok || o.status !== 400 || !tools) break;
      }
      if (!o.ok) { noteBad(keys[ki], o); errs.push(tag + ': ' + errMsg(o.data, 'HTTP ' + o.status)); if ([404, 429, 503].includes(o.status)) continue; break; }
      let any = false, sources = [];
      try {
        await readSSE(o.resp, d => {
          const cd = d.candidates && d.candidates[0]; if (!cd) return;
          const s = gemSources(cd); if (s.length) sources = s;
          for (const p of ((cd.content && cd.content.parts) || [])) if (p && !p.thought && typeof p.text === 'string' && p.text) { any = true; sink.send({ t: p.text }); }
        });
      } catch (e) { o.done(); if (any) return { done: true, interrupted: true, sources }; errs.push(tag + ': stream failed'); break; }
      o.done();
      if (any) return { done: true, sources };
      errs.push(tag + ' returned no text'); break;
    }
  }
  return { error: errs.join(' | ') || 'No Gemini key available.' };
}
async function streamOpenRouter(payload, key, E, sink, sources) {
  if (isBad(key)) return { error: 'OpenRouter key skipped: it was rejected earlier.' };
  const models = E.OPENROUTER_MODEL ? [cleanVal(E.OPENROUTER_MODEL)] : OPENROUTER_MODELS; let last = 'OpenRouter failed';
  for (const model of models) {
    const o = await openStream(OPENROUTER_URL, { authorization: 'Bearer ' + key, 'x-title': 'StudyNest' }, { model, stream: true, messages: toORMessages(payload), max_tokens: clampMaxTokens(payload.max_tokens) });
    if (!o.ok) { noteBad(key, o); last = 'OpenRouter (' + model + '): ' + errMsg(o.data, 'HTTP ' + o.status); if ([400, 404, 429, 503].includes(o.status)) continue; break; }
    let any = false;
    try { await readSSE(o.resp, d => { const t = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content; if (typeof t === 'string' && t) { any = true; sink.send({ t }); } }); }
    catch (e) { o.done(); if (any) return { done: true, interrupted: true, sources }; last = 'OpenRouter (' + model + '): stream failed'; continue; }
    o.done(); if (any) return { done: true, sources }; last = 'OpenRouter (' + model + '): empty response';
  }
  return { error: last };
}
// Streams the answer when possible; otherwise returns the normal JSON result (null = already streamed).
async function routeStream(payload, E, sink) {
  const k = getKeys(E), errors = [], t0 = Date.now();
  for (const p of (k.provider === 'openrouter' ? ['openrouter', 'gemini'] : ['gemini', 'openrouter'])) {
    if (Date.now() - t0 > 35000) break;
    let r;
    if (p === 'gemini' && k.gemini.length) r = await streamGemini(payload, k.gemini, E, sink);
    else if (p === 'openrouter' && k.openrouter) { const w = await withWeb(payload); r = await streamOpenRouter(w.p, k.openrouter, E, sink, w.sources); }
    else continue;
    if (r.done) { sink.send({ done: true, sources: r.sources || [], interrupted: !!r.interrupted }); return null; }
    errors.push(r.error);
  }
  const fb = await route(payload, E, ['gemini', 'openrouter']);
  if (fb.status !== 200) fb.body.error.message = errors.concat(fb.body.error.message).filter(Boolean).join(' | ');
  return fb;
}

// ---- abuse protection (best effort; limits are per server instance) ----
const HITS = new Map();
function guard(info, E, kind) {
  if (kind === 'post') {
    const allowed = String(E.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    let h = ''; try { h = new URL(info.origin).host; } catch (e) {}
    if (!info.origin) return { status: 403, msg: 'Please use the StudyNest app to chat with the AI.' };
    if (h !== info.host && !allowed.includes(info.origin) && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h)) return { status: 403, msg: 'This website is not allowed to use the StudyNest AI.' };
  }
  const now = Date.now(), id = info.ip || 'unknown'; let s = HITS.get(id);
  if (!s || now - s.t > 86400000) s = { t: now, day: 0, m: [] };
  s.m = s.m.filter(x => now - x < 60000);
  if (s.m.length >= (kind === 'post' ? 15 : 6)) return { status: 429, msg: 'Too many requests. Please wait a minute and try again.' };
  if (s.day >= 400) return { status: 429, msg: 'Daily AI limit reached for this connection. Try again tomorrow.' };
  s.m.push(now); s.day++; HITS.set(id, s); if (HITS.size > 5000) HITS.clear();
  return null;
}

// Tries every configured provider in order; returns first success, otherwise all the errors.
async function route(payload, E, skip) {
  skip = skip || [];
  const k = getKeys(E), tries = [], add = (n, fn) => { if (!skip.includes(n)) tries.push({ name: n, fn }); };
  const viaWeb = fn => async () => { const w = await withWeb(payload), r = await fn(w.p); if (r && r.status === 200 && w.sources) r.body.sources = w.sources; return r; };
  const A = () => k.anthropic && add('anthropic', viaWeb(p => callAnthropic(p, k.anthropic, E)));
  const G = () => k.gemini.length && add('gemini', () => callGemini(payload, k.gemini, E));
  const O = () => k.openrouter && add('openrouter', viaWeb(p => callOpenRouter(p, k.openrouter, E)));
  const order = { gemini: [G, A, O], openrouter: [O, G, A] }[k.provider] || [A, G, O];
  order.forEach(f => f());
  add('free', viaWeb(p => callPollinations(p)));
  const errors = [], t0 = Date.now();
  for (const t of tries) {
    if (Date.now() - t0 > 42000) { errors.push(t.name + ': skipped (out of time)'); continue; }
    try { const r = await t.fn(); if (r && r.status === 200) return r; if (r) errors.push(r.error); } catch (e) { errors.push(t.name + ': could not reach the service'); }
  }
  const real = errors.filter(Boolean);
  if (!k.anthropic && !k.gemini.length && !k.openrouter) real.unshift('No AI key reached the server. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or an OpenRouter key in Vercel > Settings > Environment Variables (tick Production), then Redeploy. GitHub secrets do not count. Open /api/ai on your site to check.');
  return { status: 502, body: { error: { message: real.join(' | ') || 'AI request failed.' } } };
}
function diag(E) { const k = getKeys(E); return { anthropic_key_found: !!k.anthropic, gemini_keys_found: k.gemini.length, openrouter_key_found: !!k.openrouter, provider_override: k.provider || null }; }
async function selfTest(E) {
  BAD.clear();
  const k = getKeys(E), probe = { messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 8 }, out = {};
  const run = async (name, fn) => { try { const r = await fn(); out[name] = r && r.status === 200 ? 'WORKS' : 'FAILED: ' + (r && r.error); } catch (e) { out[name] = 'FAILED: could not reach the service'; } };
  for (let i = 0; i < k.gemini.length; i++) await run('gemini_key_' + (i + 1) + ' (' + k.gemini[i].slice(0, 4) + '…)', () => callGemini(probe, [k.gemini[i]], E));
  if (k.openrouter) await run('openrouter', () => callOpenRouter(probe, k.openrouter, E));
  if (k.anthropic) await run('anthropic', () => callAnthropic(probe, k.anthropic, E));
  if (!Object.keys(out).length) out.result = 'No keys found on the server.';
  return out;
}
function validate(payload) {
  if (!payload || typeof payload !== 'object') return 'Invalid JSON body.';
  if (!Array.isArray(payload.messages) || !payload.messages.length) return 'A non-empty messages array is required.';
  if (payload.messages.length > 40) return 'Too many messages in one request.';
  if (payload.messages.some(m => !m || !['user', 'assistant'].includes(m.role))) return 'Invalid message role.';
  if (payload.system && String(payload.system).length > 40000) return 'System prompt is too long.';
  return '';
}

const J = (b, s, extra) => new Response(JSON.stringify(b), { status: s || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',  }, extra) });
async function handleAI(request, env) {
  const h = request.headers, info = { origin: h.get('origin') || '', host: new URL(request.url).host, ip: (h.get('cf-connecting-ip') || '').trim() };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  const g = guard(info, env, request.method === 'POST' ? 'post' : 'get');
  if (request.method === 'GET' || request.method === 'POST') { if (g) return J({ error: { message: g.msg } }, g.status); }
  if (request.method === 'GET') return J(new URL(request.url).searchParams.get('test') === '1' ? Object.assign(diag(env), { test: await selfTest(env) }) : diag(env));
  if (request.method !== 'POST') return J({ error: { message: 'Use POST for this endpoint.' } }, 405);
  let payload; try { payload = await request.json(); } catch (e) { payload = null; }
  const bad = validate(payload);
  if (bad) return J({ error: { message: bad } }, 400);
  delete payload.stream;   // the Cloudflare worker answers in one piece
  const result = await route(payload, env);
  return J(result.body, result.status);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai') return handleAI(request, env);
    if (env.ASSETS) {
      const r = await env.ASSETS.fetch(request);
      if (r.status === 404 && request.method === 'GET') return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
      return r;
    }
    return new Response('Not found', { status: 404 });
  }
};
