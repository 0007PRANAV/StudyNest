const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
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
  return {
    anthropic: envKey(E, ['ANTHROPIC_API_KEY', 'ANTHROPIC_KEY'], n => n.includes('ANTHROPIC') && n.includes('KEY')),
    gemini: envKey(E, ['GEMINI_API_KEY', 'GEMINI_KEY', 'GOOGLE_GEMINI_API_KEY', 'GOOGLE_API_KEY'], n => (n.includes('GEMINI') || n.includes('GOOGLE')) && n.includes('KEY')),
    provider: String(envKey(E, ['AI_PROVIDER']) || '').toLowerCase()
  };
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
async function callGemini(payload, key, E) {
  const models = E.GEMINI_MODEL || E.AI_MODEL ? [cleanVal(E.GEMINI_MODEL || E.AI_MODEL)] : GEMINI_MODELS;
  let last;
  for (const model of models) {
    const body = { contents: toGeminiContents(payload.messages), generationConfig: { maxOutputTokens: clampMaxTokens(payload.max_tokens) } };
    if (payload.system) body.system_instruction = { parts: [{ text: String(payload.system) }] };
    const r = await postJSON(GEMINI_URL + encodeURIComponent(model) + ':generateContent', { 'x-goog-api-key': key }, body);
    if (!r.ok) { last = { status: r.status, error: 'Gemini (' + model + '): ' + errMsg(r.data, 'HTTP ' + r.status) }; if (r.status !== 404) break; continue; }
    const c = r.data && r.data.candidates && r.data.candidates[0];
    const answer = ((c && c.content && c.content.parts) || []).filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('\n').trim();
    if (answer) return { status: 200, body: { content: [{ type: 'text', text: answer }] } };
    const why = (c && c.finishReason) || (r.data && r.data.promptFeedback && r.data.promptFeedback.blockReason) || 'empty response';
    return { status: 502, error: 'Gemini (' + model + ') returned no text (' + why + ').' };
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
  const k = getKeys(E), tries = [];
  const add = (name, fn) => tries.push({ name, fn });
  const A = () => add('anthropic', () => callAnthropic(payload, k.anthropic, E)), G = () => add('gemini', () => callGemini(payload, k.gemini, E));
  if (k.provider === 'gemini') { if (k.gemini) G(); if (k.anthropic) A(); } else { if (k.anthropic) A(); if (k.gemini) G(); }
  add('free', () => callPollinations(payload));
  const errors = [];
  for (const t of tries) {
    try { const r = await t.fn(); if (r && r.status === 200) return r; if (r) errors.push(r.error); } catch (e) { errors.push(t.name + ': could not reach the service'); }
  }
  const real = errors.filter(Boolean);
  if (!k.anthropic && !k.gemini) real.unshift('No Anthropic or Gemini key reached the server, so images, PDFs and the full AI are off. Add ANTHROPIC_API_KEY or GEMINI_API_KEY in Vercel > Settings > Environment Variables (tick Production), then Redeploy. GitHub secrets do not count. Open /api/ai on your site to check.');
  return { status: 502, body: { error: { message: real.join(' | ') || 'AI request failed.' } } };
}
function diag(E) { const k = getKeys(E); return { anthropic_key_found: !!k.anthropic, gemini_key_found: !!k.gemini, provider_override: k.provider || null, env_names_seen: Object.keys(E || {}).filter(n => typeof E[n] === 'string' && /KEY|MODEL|PROVIDER/i.test(n)) }; }
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
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};
