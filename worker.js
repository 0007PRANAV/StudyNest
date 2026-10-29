const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS = ['google/gemini-2.5-flash', 'openai/gpt-4o-mini'];
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
async function postJSON(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) });
  const text = await r.text(); let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: r.ok, status: r.status, data, text };
}

async function callAnthropic(payload, key, E) {
  const models = E.ANTHROPIC_MODEL || E.AI_MODEL ? [cleanVal(E.ANTHROPIC_MODEL || E.AI_MODEL)] : ANTHROPIC_MODELS;
  let last;
  for (const model of models) {
    const body = { model, max_tokens: clampMaxTokens(payload.max_tokens), messages: payload.messages };
    if (payload.system) body.system = String(payload.system);
    const r = await postJSON(ANTHROPIC_URL, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body);
    if (r.ok) return { status: 200, body: r.data || { content: [] } };
    last = { status: r.status, error: 'Anthropic (' + model + '): ' + errMsg(r.data, 'HTTP ' + r.status) };
    if (r.status !== 404) break;
  }
  return last;
}

function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    const parts = [];
    if (typeof m.content === 'string') parts.push({ text: m.content });
    else if (Array.isArray(m.content)) for (const b of m.content) {
      if (!b) continue;
      if (b.type === 'text' && b.text) parts.push({ text: String(b.text) });
      else if ((b.type === 'image' || b.type === 'document') && b.source && b.source.data) parts.push({ inline_data: { mime_type: b.source.media_type || (b.type === 'document' ? 'application/pdf' : 'image/jpeg'), data: b.source.data } });
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}
async function callGemini(payload, keys, E) {
  const models = E.GEMINI_MODEL || E.AI_MODEL ? [cleanVal(E.GEMINI_MODEL || E.AI_MODEL)] : GEMINI_MODELS;
  let last;
  for (let ki = 0; ki < keys.length; ki++) {
    for (const model of models) {
      const body = { contents: toGeminiContents(payload.messages), generationConfig: { maxOutputTokens: clampMaxTokens(payload.max_tokens) } };
      if (payload.system) body.system_instruction = { parts: [{ text: String(payload.system) }] };
      const r = await postJSON(GEMINI_URL + encodeURIComponent(model) + ':generateContent', { 'x-goog-api-key': keys[ki] }, body);
      const tag = 'Gemini key ' + (ki + 1) + ' (' + model + ')';
      if (!r.ok) { last = { status: r.status, error: tag + ': ' + errMsg(r.data, 'HTTP ' + r.status) }; if (r.status !== 404) break; continue; }
      const c = r.data && r.data.candidates && r.data.candidates[0];
      const answer = ((c && c.content && c.content.parts) || []).filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('\n').trim();
      if (answer) return { status: 200, body: { content: [{ type: 'text', text: answer }] } };
      last = { status: 502, error: tag + ' returned no text (' + ((c && c.finishReason) || (r.data && r.data.promptFeedback && r.data.promptFeedback.blockReason) || 'empty') + ').' };
      break;
    }
  }
  return last;
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
  for (const model of models) {
    const r = await postJSON(OPENROUTER_URL, { authorization: 'Bearer ' + key, 'x-title': 'StudyNest' }, { model, messages: msgs, max_tokens: clampMaxTokens(payload.max_tokens) });
    const a = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    if (r.ok && typeof a === 'string' && a.trim()) return { status: 200, body: { content: [{ type: 'text', text: a.trim() }] } };
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
  const r = await postJSON(POLLINATIONS_URL, {}, { model: 'openai-fast', messages: msgs, max_tokens: clampMaxTokens(payload.max_tokens) });
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
  const errors = [];
  for (const t of tries) {
    try { const r = await t.fn(); if (r && r.status === 200) return r; if (r) errors.push(r.error); } catch (e) { errors.push(t.name + ': could not reach the service'); }
  }
  const real = errors.filter(Boolean);
  if (!k.anthropic && !k.gemini.length && !k.openrouter) real.unshift('No AI key reached the server. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or an OpenRouter key in Vercel > Settings > Environment Variables (tick Production), then Redeploy. GitHub secrets do not count. Open /api/ai on your site to check.');
  return { status: 502, body: { error: { message: real.join(' | ') || 'AI request failed.' } } };
}
function diag(E) { const k = getKeys(E); return { anthropic_key_found: !!k.anthropic, gemini_keys_found: k.gemini.length, openrouter_key_found: !!k.openrouter, provider_override: k.provider || null }; }
function validate(payload) {
  if (!payload || typeof payload !== 'object') return 'Invalid JSON body.';
  if (!Array.isArray(payload.messages) || !payload.messages.length) return 'A non-empty messages array is required.';
  return '';
}

const J = (b, s, extra) => new Response(JSON.stringify(b), { status: s || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }, extra) });
async function handleAI(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
  if (request.method === 'GET') return J(diag(env));
  if (request.method !== 'POST') return J({ error: { message: 'Use POST for this endpoint.' } }, 405);
  let payload; try { payload = await request.json(); } catch (e) { payload = null; }
  const bad = validate(payload);
  if (bad) return J({ error: { message: bad } }, 400);
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
