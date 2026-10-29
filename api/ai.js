const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS = ['google/gemini-2.5-flash', 'openai/gpt-4o-mini'];
const VERTEX_URL = 'https://aiplatform.googleapis.com/v1/publishers/google/models/';
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.8-flash'];

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
async function callGemini(payload, keys, E) {
  const models = E.GEMINI_MODEL || E.AI_MODEL ? [cleanVal(E.GEMINI_MODEL || E.AI_MODEL)] : GEMINI_MODELS, errs = [];
  for (let ki = 0; ki < keys.length; ki++) {
    // "AQ." keys are Vertex AI express-mode keys; "AIza" keys are Google AI Studio keys.
    if (isBad(keys[ki])) { errs.push('Gemini key ' + (ki + 1) + ' skipped: Google rejected it earlier. Replace it in Vercel and redeploy.'); continue; }
    const endpoints = /^AQ\./.test(keys[ki]) ? ['vertex'] : ['studio'];
    let done = false;
    for (const ep of endpoints) {
      if (done) break;
      for (const model of models) {
        const vx = ep === 'vertex', url = vx ? VERTEX_URL + encodeURIComponent(model) + ':generateContent' : GEMINI_URL + encodeURIComponent(model) + ':generateContent';
        const body = { contents: toGeminiContents(payload.messages, vx), generationConfig: { maxOutputTokens: clampMaxTokens(payload.max_tokens) } };
        if (payload.system) body[vx ? 'systemInstruction' : 'system_instruction'] = { parts: [{ text: String(payload.system) }] };
        const r = await postJSON(url, { 'x-goog-api-key': keys[ki] }, body);
        const tag = 'Gemini key ' + (ki + 1) + ' [' + (vx ? 'Vertex' : 'AI Studio') + ', ' + model + ']';
        if (!r.ok) { noteBad(keys[ki], r); errs.push(tag + ': ' + errMsg(r.data, 'HTTP ' + r.status)); if (r.status !== 404) break; continue; }
        const cd = r.data && r.data.candidates && r.data.candidates[0];
        const answer = ((cd && cd.content && cd.content.parts) || []).filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('\n').trim();
        if (answer) return { status: 200, body: { content: [{ type: 'text', text: answer }] } };
        errs.push(tag + ' returned no text (' + ((cd && cd.finishReason) || (r.data && r.data.promptFeedback && r.data.promptFeedback.blockReason) || 'empty') + ').'); done = true; break;
      }
    }
  }
  return { status: 502, error: errs.join(' | ') || 'No Gemini key available.' };
}

async function callOpenRouter(payload, key, E) {
  const models = E.OPENROUTER_MODEL ? [cleanVal(E.OPENROUTER_MODEL)] : OPENROUTER_MODELS;
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

// Tries every configured provider in order; returns first success, otherwise all the errors.
async function route(payload, E) {
  const k = getKeys(E), tries = [], add = (n, fn) => tries.push({ name: n, fn });
  const A = () => k.anthropic && add('anthropic', () => callAnthropic(payload, k.anthropic, E));
  const G = () => k.gemini.length && add('gemini', () => callGemini(payload, k.gemini, E));
  const O = () => k.openrouter && add('openrouter', () => callOpenRouter(payload, k.openrouter, E));
  const order = { gemini: [G, A, O], openrouter: [O, G, A] }[k.provider] || [A, G, O];
  order.forEach(f => f());
  add('free', () => callPollinations(payload));
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
  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json(/[?&]test=1/.test(req.url || '') ? Object.assign(diag(process.env), { test: await selfTest(process.env) }) : diag(process.env));
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Use POST for this endpoint.' } });
  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = null; } }
  const bad = validate(payload);
  if (bad) return res.status(400).json({ error: { message: bad } });
  const result = await route(payload, process.env);
  return res.status(result.status).json(result.body);
};
