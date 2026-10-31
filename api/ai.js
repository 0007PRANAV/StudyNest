const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_FALLBACK = ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-27b-it:free', 'openai/gpt-oss-20b:free', 'qwen/qwen3-235b-a22b:free', 'deepseek/deepseek-chat-v3.1:free'];  // only used if OpenRouter's live model list can't be fetched
const VERTEX_URL = 'https://aiplatform.googleapis.com/v1/publishers/google/models/';
const GEMINI_FALLBACK = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash'];   // used only if Google's live model list can't be fetched
const GEMINI_LIST_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';  // free-tier quotas are per model, so falling back to the next one helps

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
async function postJSON(url, headers, body, ms, method) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms || 40000);
  try {
    const r = await fetch(url, { method: method || 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: method === 'GET' ? undefined : JSON.stringify(body), signal: ac.signal });
    const text = await r.text(); let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, data, text, retry: parseInt(r.headers && r.headers.get && r.headers.get('retry-after'), 10) || 0 };
  } catch (e) {
    const m = e && e.name === 'AbortError' ? 'timed out after ' + Math.round((ms || 40000) / 1000) + 's' : 'network error';
    return { ok: false, status: 599, data: { error: { message: m } }, text: '', retry: 0 };
  } finally { clearTimeout(t); }
}
// ---- cooldowns: a failing key/model is skipped only briefly, so one hiccup never takes the AI down for long ----
const COOL = new Map();
const ck = (k, m) => String(k).slice(0, 6) + String(k).slice(-6) + '|' + (m || '*');
const coolInfo = (k, m) => { const c = COOL.get(ck(k, m)); return c && c.u > Date.now() ? c : null; };
const setCool = (k, m, ms, why) => COOL.set(ck(k, m), { u: Date.now() + ms, why });
// classifies a failed provider response and sets the right short cooldown. Returns auth | disabled | quota | model | other
function noteFail(k, m, r) {
  const t = String(r.text || ''), st = r.status;
  if (st === 401 || /api key not valid|api_key_invalid|user not found|invalid api key|invalid_api_key/i.test(t)) { setCool(k, '*', 300000, 'rejected'); return 'auth'; }
  if (st === 403 && /has not been used|is disabled|service_disabled|not enabled|enable it by visiting/i.test(t)) { setCool(k, '*', 300000, 'api-disabled'); return 'disabled'; }
  if (st === 503 || /high demand|overloaded|temporarily/i.test(t)) { setCool(k, m, 25000, 'busy'); return 'busy'; }
  if (st === 429 || /resource_exhausted|quota|rate.?limit/i.test(t)) { setCool(k, m, /per ?day|daily/i.test(t) ? 900000 : Math.min(Math.max((r.retry || 0) * 1000, 45000), 180000), 'quota'); return 'quota'; }
  if (st === 404 || /unavailable for free|no endpoints found|not a valid model|model.{0,30}not found|is not found|no longer available|deprecated|only available on|agentic/i.test(t)) { setCool(k, m, 3600000, 'model'); return 'model'; }
  return 'other';
}
const hint = (kind, vx) => kind === 'disabled' && vx ? ' → This "AQ." key comes from a Google Cloud project where the Vertex AI API is switched off. Enable it in Google Cloud, or (easier, free) create a Google AI Studio key at aistudio.google.com/apikey (starts with "AIza") and put it in Vercel.' : kind === 'auth' ? ' → The provider rejected this key. Create a new one and replace it in Vercel.' : kind === 'busy' ? ' → Google says this model is busy; trying another.' : kind === 'quota' ? ' → Free quota is used up for now; the next key or model is tried automatically.' : '';
// An "AQ." key may work on the normal Gemini endpoint even when Vertex is off, so try both; cooldowns are tracked per endpoint
const variants = key => /^AQ\./.test(key) ? [{ vx: false, ck: key + '#g' }, { vx: true, ck: key + '#v' }] : [{ vx: false, ck: key }];
const GM = new Map();
// Google retires models often, so ask Google which Flash models this key can use right now (newest first; cached 30 min per key)
async function geminiModels(E, key) {
  if (E.GEMINI_MODEL || E.AI_MODEL) return [cleanVal(E.GEMINI_MODEL || E.AI_MODEL)];
  const c = GM.get(ck(key)); if (c && Date.now() - c.t < 1800000) return c.list;
  const r = await postJSON(GEMINI_LIST_URL, { 'x-goog-api-key': key }, null, 7000, 'GET'), arr = r.ok && r.data && Array.isArray(r.data.models) ? r.data.models : [];
  const ver = n => parseFloat((String(n).match(/gemini-(\d+(?:\.\d+)?)/) || [])[1]) || 0;
  const ok = arr.filter(m => m && /^models\/gemini-/.test(m.name) && /flash/.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent') && !/image|tts|live|audio|embed|robotics|computer|-exp|custom|thinking/.test(m.name)).map(m => m.name.replace('models/', ''));
  ok.sort((a, b) => ver(b) - ver(a) || (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0) || a.length - b.length);
  const list = ok.length ? ok.filter(n => !/latest/.test(n)).slice(0, 4).concat(ok.filter(n => /latest/.test(n)).slice(0, 1)) : GEMINI_FALLBACK;
  GM.set(ck(key), { t: ok.length ? Date.now() : Date.now() - 1500000, list });   // if discovery failed, try again in ~5 min
  return list;
}
let RR = 0;
// AI Studio ("AIza") keys first because they work on the free tier without extra setup; keys of the same type rotate so load spreads out
function orderKeys(keys) {
  const a = keys.filter(k => !/^AQ\./.test(k)), b = keys.filter(k => /^AQ\./.test(k)), rot = x => { if (x.length < 2) return x; const n = RR % x.length; return x.slice(n).concat(x.slice(0, n)); };
  RR++; return rot(a).concat(rot(b));
}

async function callAnthropic(payload, key, E) {
  const models = E.ANTHROPIC_MODEL || E.AI_MODEL ? [cleanVal(E.ANTHROPIC_MODEL || E.AI_MODEL)] : ANTHROPIC_MODELS;
  let last;
  const ci = coolInfo(key, '*'); if (ci) return { status: 401, error: 'Anthropic key paused briefly (' + ci.why + ').' };
  for (const model of models) {
    const body = { model, max_tokens: clampMaxTokens(payload.max_tokens), messages: payload.messages };
    if (payload.system) body.system = String(payload.system);
    const r = await postJSON(ANTHROPIC_URL, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body);
    if (r.ok) return { status: 200, body: Object.assign({}, r.data || { content: [] }, { provider: 'anthropic', model }) };
    const kind = noteFail(key, model, r);
    last = { status: r.status, error: 'Anthropic (' + model + '): ' + errMsg(r.data, 'HTTP ' + r.status) + hint(kind) };
    if (kind !== 'model') break;
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
function geminiBody(payload, vx, tools, model, think) {
  const b = { contents: toGeminiContents(payload.messages, vx), generationConfig: { maxOutputTokens: Math.max(clampMaxTokens(payload.max_tokens), think !== false && /gemini-[23]/.test(model || '') ? 600 : 1) } };
  if (think !== false && !/pro|latest/.test(model || '')) {   // light thinking = much faster first words, still accurate for study questions (retried without it if a model rejects it)
    if (/gemini-2\.5/.test(model || '')) b.generationConfig.thinkingConfig = { thinkingBudget: /lite/.test(model) ? 0 : 512 };
    else if (/gemini-3/.test(model || '')) b.generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  }
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
const wantsTools = payload => payload.web === false ? [false] : [true, false];   // Gemini decides by itself when a Google search is needed; if the tool is refused (400) retry without it
const pause = ms => new Promise(r => setTimeout(r, ms));
// sends one Gemini request; if the tool or thinking option is refused (400) it retries without it, and retries once on a 503 "high demand"
async function geminiSend(send, payload, vx, model, key) {
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const tools of wantsTools(payload)) {
      for (const think of [true, false]) { r = await send(geminiBody(payload, vx, tools, model, think)); if (r.ok || r.status !== 400) break; }
      if (r.ok || r.status !== 400 || !tools) break;
    }
    if (r.ok || r.status !== 503) break; await pause(900);
  }
  return r;
}
async function callGemini(payload, keys, E) {
  const errs = []; let budget = 6;   // at most 6 model attempts per request so a busy Google never delays the fallback
  for (const key of orderKeys(keys)) {
    const models = await geminiModels(E, key);
    for (const v of variants(key)) {
      const vx = v.vx, n = keys.indexOf(key) + 1, kc = coolInfo(v.ck, '*');
      if (kc) { errs.push('Gemini key ' + n + (vx ? ' [Vertex]' : '') + ' paused briefly (' + kc.why + ')'); continue; }
      for (const model of models) {
        const tag = 'Gemini key ' + n + ' [' + (vx ? 'Vertex' : 'AI Studio') + ', ' + model + ']', mc = coolInfo(v.ck, model);
        if (mc) { errs.push(tag + ' paused briefly (' + mc.why + ')'); continue; }
        if (budget-- <= 0) { errs.push('stopped after 6 attempts'); return { status: 502, error: errs.join(' | ') }; }
        const url = (vx ? VERTEX_URL : GEMINI_URL) + encodeURIComponent(model) + ':generateContent';
        const r = await geminiSend(b => postJSON(url, { 'x-goog-api-key': key }, b, 30000), payload, vx, model, key);
        if (!r.ok) {
          const kind = noteFail(v.ck, model, r); errs.push(tag + ': ' + errMsg(r.data, 'HTTP ' + r.status).slice(0, 220) + hint(kind, vx));
          if (kind === 'auth' || kind === 'disabled') break;
          continue;
        }
        const cd = r.data && r.data.candidates && r.data.candidates[0];
        const answer = ((cd && cd.content && cd.content.parts) || []).filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('\n').trim();
        if (answer) return { status: 200, body: { content: [{ type: 'text', text: answer }], sources: gemSources(cd), provider: 'gemini', model, fails: errs.length } };
        errs.push(tag + ' returned no text (' + ((cd && cd.finishReason) || (r.data && r.data.promptFeedback && r.data.promptFeedback.blockReason) || 'empty') + ').');
      }
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

const hasImages = payload => (payload.messages || []).some(m => Array.isArray(m.content) && m.content.some(b => b && (b.type === 'image' || b.type === 'document')));
let ORM = { t: 0, list: [] };
// Free models change often, so ask OpenRouter which are free right now (cached 30 min). Never picks a paid model.
async function openRouterModels(E, payload) {
  if (E.OPENROUTER_MODEL) return [cleanVal(E.OPENROUTER_MODEL)];
  if (!ORM.list.length || Date.now() - ORM.t > 1800000) {
    const r = await postJSON(OPENROUTER_MODELS_URL, {}, null, 7000, 'GET'), arr = r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : [];
    const free = arr.filter(m => m && m.id && m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 && !/guard|embed|whisper|tts|audio|image-gen|lyria|moderation|router|auto/i.test(m.id) && (!m.architecture || !m.architecture.output_modalities || m.architecture.output_modalities.includes('text')));
    const score = m => (/gemini/.test(m.id) ? 5 : /llama-3\.3|llama-4/.test(m.id) ? 4 : /qwen|gpt-oss|nemotron/.test(m.id) ? 4 : /deepseek|mistral|gemma/.test(m.id) ? 3 : /inkling|agent/.test(m.id) ? 0 : 1) * 1e7 + (m.context_length || 0);
    free.sort((a, b) => score(b) - score(a));
    if (free.length) ORM = { t: Date.now(), list: free.slice(0, 12).map(m => ({ id: m.id, vision: !!(m.architecture && m.architecture.input_modalities && m.architecture.input_modalities.includes('image')) })) };
    else ORM = { t: Date.now() - 1500000, list: OPENROUTER_FALLBACK.map(id => ({ id, vision: false })) };   // retry discovery after ~5 min
  }
  const img = hasImages(payload);
  return ORM.list.filter(m => !img || m.vision).map(m => m.id).filter(id => !coolInfo('openrouter', id)).slice(0, 4);
}
// Only a genuinely rejected key pauses the whole key; any other failure just skips that one model for a while
function orFail(key, model, r) {
  const t = String(r.text || '');
  if (/user not found|invalid api key|no auth credentials|api key.{0,20}(invalid|revoked|disabled)/i.test(t) && !/agentic|harness|only available/i.test(t)) return noteFail(key, model, r);
  const k = noteFail('openrouter', model, r); if (k === 'other') setCool('openrouter', model, 1800000, 'model-error'); return k === 'other' ? 'model' : k;
}
async function callOpenRouter(payload, key, E) {
  const msgs = toORMessages(payload), kc = coolInfo(key, '*');
  if (kc) return { status: 401, error: 'OpenRouter key paused briefly (' + kc.why + ').' };
  const models = await openRouterModels(E, payload); let last = { status: 502, error: 'OpenRouter: no free model is available right now.' };
  for (const model of models) {
    const r = await postJSON(OPENROUTER_URL, { authorization: 'Bearer ' + key, 'x-title': 'StudyNest' }, { model, messages: msgs, max_tokens: clampMaxTokens(payload.max_tokens) });
    const a = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    if (r.ok && typeof a === 'string' && a.trim()) return { status: 200, body: { content: [{ type: 'text', text: a.trim() }], provider: 'openrouter', model } };
    const kind = r.ok ? 'other' : orFail(key, model, r);
    last = { status: r.ok ? 502 : r.status, error: 'OpenRouter (' + model + '): ' + (r.ok ? 'empty response' : errMsg(r.data, 'HTTP ' + r.status).slice(0, 250)) + hint(kind) };
    if (kind === 'auth') break;
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
// Decides if a question needs fresh/factual information from the web (used for models without built-in search)
const WEB_RE = /\b(latest|news|today|tonight|yesterday|tomorrow|recent(ly)?|current(ly)?|right now|this (week|month|year)|20(2[3-9]|3\d)|who (is|was|won|are)|when (is|was|did|will|does)|where (is|was)|which (is|was)|how (much|many) |price|cost of|score|results?|cut-?off|admit card|date ?sheet|exam date|schedule|notification|syllabus|vacanc|admission|deadline|last date|ranking|weather|stock|exchange rate|population|capital of|president|prime minister|minister|ceo|released|launch|statistics|according to|sources?|search|google|look up|online|wikipedia|internet|website|link)\b/i;
const needsWeb = payload => payload.web === true || (payload.web !== false && WEB_RE.test(lastUserText(payload)));
async function tavilySearch(q, key) {
  const r = await postJSON('https://api.tavily.com/search', { authorization: 'Bearer ' + key }, { query: q, max_results: 5, search_depth: 'basic', include_answer: false }, 9000);
  const arr = r.ok && r.data && Array.isArray(r.data.results) ? r.data.results : []; if (!arr.length) return null;
  return { sources: arr.map(x => ({ title: x.title || x.url, url: x.url })), text: arr.map(x => '[' + (x.title || x.url) + '] (' + x.url + ')\n' + String(x.content || '').slice(0, 700)).join('\n\n'), label: 'Web search' };
}
// Free, keyless fallback: Wikipedia
async function wikiContext(q) {
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!q) return null;
  const url = 'https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=3&prop=extracts%7Cinfo&exintro=1&explaintext=1&exchars=1200&inprop=url&format=json&formatversion=2&origin=*&gsrsearch=' + encodeURIComponent(q);
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'StudyNest/1.0 (https://github.com/0007PRANAV/StudyNest)' }, signal: ac.signal });
    if (!r.ok) return null;
    const d = await r.json(), pages = (((d || {}).query || {}).pages || []).filter(p => p && p.extract).sort((a, b) => (a.index || 0) - (b.index || 0));
    if (!pages.length) return null;
    return { sources: pages.map(p => ({ title: p.title, url: p.fullurl })), text: pages.map(p => '[' + p.title + '] (' + p.fullurl + ')\n' + p.extract).join('\n\n'), label: 'Wikipedia' };
  } catch (e) { return null; } finally { clearTimeout(t); }
}
async function withWeb(payload, E) {
  if (!needsWeb(payload)) return { p: payload, sources: null };
  const q = lastUserText(payload).replace(/\[Attached file:[\s\S]*$/, '').slice(0, 300), tk = envKey(E || {}, ['TAVILY_API_KEY', 'TAVILY_KEY'], n => n.includes('TAVILY'));
  let w = null; if (tk) { try { w = await tavilySearch(q, tk); } catch (e) {} }
  if (!w) w = await wikiContext(q);
  return w ? { p: Object.assign({}, payload, { system: (payload.system || '') + '\n\nWEB RESULTS (' + w.label + '). Use them for current or factual details, say which source you used, and say so if they do not answer the question:\n' + w.text }), sources: w.sources } : { p: payload, sources: null };
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
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms || 20000);
  try {
    const resp = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body), signal: ac.signal });
    if (!resp.ok) { const text = await resp.text(); let data = null; try { data = JSON.parse(text); } catch (e) {} clearTimeout(t); return { ok: false, status: resp.status, data, text, retry: parseInt(resp.headers.get('retry-after'), 10) || 0 }; }
    clearTimeout(t);   // headers arrived in time; the streamed answer itself is not cut off
    return { ok: true, resp, done: () => {} };
  } catch (e) { clearTimeout(t); return { ok: false, status: 599, data: { error: { message: e && e.name === 'AbortError' ? 'timed out' : 'network error' } }, text: '' }; }
}
async function streamGemini(payload, keys, E, sink) {
  const errs = []; let budget = 6;
  for (const key of orderKeys(keys)) {
    const models = await geminiModels(E, key);
    for (const v of variants(key)) {
      const vx = v.vx, n = keys.indexOf(key) + 1, kc = coolInfo(v.ck, '*');
      if (kc) { errs.push('Gemini key ' + n + (vx ? ' [Vertex]' : '') + ' paused briefly (' + kc.why + ')'); continue; }
      for (const model of models) {
        const tag = 'Gemini key ' + n + ' [' + (vx ? 'Vertex' : 'AI Studio') + ', ' + model + ']', mc = coolInfo(v.ck, model);
        if (mc) { errs.push(tag + ' paused briefly (' + mc.why + ')'); continue; }
        if (budget-- <= 0) { errs.push('stopped after 6 attempts'); return { error: errs.join(' | ') }; }
        const url = (vx ? VERTEX_URL : GEMINI_URL) + encodeURIComponent(model) + ':streamGenerateContent?alt=sse';
        const o = await geminiSend(b => openStream(url, { 'x-goog-api-key': key }, b, 20000), payload, vx, model, key);
        if (!o.ok) {
          const kind = noteFail(v.ck, model, o); errs.push(tag + ': ' + errMsg(o.data, 'HTTP ' + o.status).slice(0, 220) + hint(kind, vx));
          if (kind === 'auth' || kind === 'disabled') break;
          continue;
        }
        let any = false, sources = [];
        try {
          await readSSE(o.resp, d => {
            const cd = d.candidates && d.candidates[0]; if (!cd) return;
            const s = gemSources(cd); if (s.length) sources = s;
            for (const p of ((cd.content && cd.content.parts) || [])) if (p && !p.thought && typeof p.text === 'string' && p.text) { any = true; sink.send({ t: p.text }); }
          });
        } catch (e) { if (any) return { done: true, interrupted: true, sources, provider: 'gemini', model, fails: errs.length }; errs.push(tag + ': stream failed'); continue; }
        if (any) return { done: true, sources, provider: 'gemini', model, fails: errs.length };
        errs.push(tag + ' returned no text');
      }
    }
  }
  return { error: errs.join(' | ') || 'No Gemini key available.' };
}
async function streamOpenRouter(payload, key, E, sink, sources) {
  const kc = coolInfo(key, '*'); if (kc) return { error: 'OpenRouter key paused briefly (' + kc.why + ').' };
  const models = await openRouterModels(E, payload); let last = 'OpenRouter: no free model is available right now.';
  for (const model of models) {
    const o = await openStream(OPENROUTER_URL, { authorization: 'Bearer ' + key, 'x-title': 'StudyNest' }, { model, stream: true, messages: toORMessages(payload), max_tokens: clampMaxTokens(payload.max_tokens) });
    if (!o.ok) { const kind = orFail(key, model, o); last = 'OpenRouter (' + model + '): ' + errMsg(o.data, 'HTTP ' + o.status).slice(0, 250) + hint(kind); if (kind === 'auth') break; continue; }
    let any = false;
    try { await readSSE(o.resp, d => { const t = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content; if (typeof t === 'string' && t) { any = true; sink.send({ t }); } }); }
    catch (e) { o.done(); if (any) return { done: true, interrupted: true, sources, provider: 'openrouter', model }; last = 'OpenRouter (' + model + '): stream failed'; continue; }
    o.done(); if (any) return { done: true, sources, provider: 'openrouter', model }; last = 'OpenRouter (' + model + '): empty response';
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
    else if (p === 'openrouter' && k.openrouter) { const w = await withWeb(payload, E); r = await streamOpenRouter(w.p, k.openrouter, E, sink, w.sources); }
    else continue;
    if (r.done) { sink.send({ done: true, sources: r.sources || [], interrupted: !!r.interrupted, provider: r.provider || '', model: r.model || '', fails: r.fails || 0 }); return null; }
    errors.push(r.error);
  }
  const fb = await route(payload, E, ['gemini', 'openrouter']);
  if (fb.status !== 200) fb.body.error.details = errors.concat(fb.body.error.details).filter(Boolean).join(' | ');
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
  if (s.m.length >= (kind === 'post' ? 20 : 8)) return { status: 429, msg: 'Too many requests. Please wait a minute and try again.' };
  if (s.day >= 600) return { status: 429, msg: 'Daily AI limit reached for this connection. Try again tomorrow.' };
  s.m.push(now); s.day++; HITS.set(id, s); if (HITS.size > 5000) HITS.clear();
  return null;
}

// Tries every configured provider in order; returns first success, otherwise all the errors.
async function route(payload, E, skip) {
  skip = skip || [];
  const k = getKeys(E), tries = [], add = (n, fn) => { if (!skip.includes(n)) tries.push({ name: n, fn }); };
  const viaWeb = fn => async () => { const w = await withWeb(payload, E), r = await fn(w.p); if (r && r.status === 200 && w.sources) r.body.sources = w.sources; return r; };
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
  const real = errors.filter(Boolean), allKeyIssue = real.some(e => /Vertex AI API|aistudio\.google\.com|rejected/i.test(String(e)));
  if (!k.anthropic && !k.gemini.length && !k.openrouter) real.unshift('No AI key reached the server. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or an OpenRouter key in Vercel > Settings > Environment Variables (tick Production), then Redeploy. GitHub secrets do not count. Open /api/ai on your site to check.');
  const summary = !k.anthropic && !k.gemini.length && !k.openrouter ? real[0] : allKeyIssue ? 'The AI could not answer: your AI keys are not working. Open /api/ai?test=1 for the exact fix (tap Technical details below to see it).' : 'The AI is busy or unreachable right now. Please tap Retry in a few seconds.';
  return { status: 502, body: { error: { message: summary, details: real.join(' | ') || 'AI request failed.' } } };
}
function diag(E) { const k = getKeys(E); return { anthropic_key_found: !!k.anthropic, gemini_keys_found: k.gemini.length, openrouter_key_found: !!k.openrouter, provider_override: k.provider || null }; }
async function selfTest(E) {
  COOL.clear(); ORM = { t: 0, list: [] };
  const k = getKeys(E), probe = { messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 256, web: false }, out = {}, advice = [];
  const run = async (name, fn) => { try { const r = await fn(); out[name] = r && r.status === 200 ? 'WORKS' : 'FAILED: ' + (r && r.error); } catch (e) { out[name] = 'FAILED: could not reach the service'; } };
  for (let i = 0; i < k.gemini.length; i++) { COOL.clear(); await run('gemini_key_' + (i + 1) + ' (' + k.gemini[i].slice(0, 4) + '…)', () => callGemini(probe, [k.gemini[i]], E)); }
  GM.clear(); if (k.gemini[0]) out.gemini_models_now = await geminiModels(E, k.gemini[0]);
  if (k.openrouter) { COOL.clear(); await run('openrouter', () => callOpenRouter(probe, k.openrouter, E)); out.openrouter_free_models_now = (await openRouterModels({}, probe)).slice(0, 4); }
  if (k.anthropic) await run('anthropic', () => callAnthropic(probe, k.anthropic, E));
  await run('free_fallback_pollinations', () => callPollinations(probe));
  const w = await wikiContext('Photosynthesis'); out.web_search = w ? 'WORKS (' + w.label + ')' : 'FAILED: Wikipedia not reachable'; out.tavily_key_found = !!envKey(E, ['TAVILY_API_KEY'], n => n.includes('TAVILY'));
  const ok = Object.keys(out).filter(x => /^(gemini|openrouter$|anthropic)/.test(x) && out[x] === 'WORKS');
  if (!ok.length) advice.push('No paid/keyed AI provider is working. Fastest fix: create a free Google AI Studio key at https://aistudio.google.com/apikey (starts with AIza), add it in Vercel > Settings > Environment Variables as GEMINI_API_KEY (Production), then Redeploy.');
  if (!ok.length && Object.values(out).some(v => /Vertex/i.test(String(v)) && /FAILED/.test(String(v)))) advice.push('If your "AQ." keys keep failing on every Gemini model, create a free Google AI Studio key (AIza...) instead.');
  if (!out.tavily_key_found) advice.push('Optional: a free Tavily key (tavily.com) as TAVILY_API_KEY gives non-Gemini models real web search; without it they use Wikipedia.');
  out.any_ai_working = ok.length > 0 || /WORKS/.test(String(out.free_fallback_pollinations)); out.advice = advice;
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

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const E = process.env, h = req.headers || {};
  const info = { origin: h.origin || '', host: h.host || '', ip: String(h['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim() };
  const allowed = String(E.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (info.origin && allowed.includes(info.origin)) {   // CORS only for origins you list in ALLOWED_ORIGINS; the app itself is same-origin and needs none
    res.setHeader('access-control-allow-origin', info.origin); res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS'); res.setHeader('access-control-allow-headers', 'content-type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  const blocked = (kind) => { const g = guard(info, E, kind); if (g) { res.status(g.status).json({ error: { message: g.msg } }); return true; } return false; };
  if (req.method === 'GET') {
    if (blocked('get')) return;
    return res.status(200).json(/[?&]test=1/.test(req.url || '') ? Object.assign(diag(E), { test: await selfTest(E) }) : diag(E));
  }
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Use POST for this endpoint.' } });
  if (blocked('post')) return;
  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = null; } }
  const bad = validate(payload);
  if (bad) return res.status(400).json({ error: { message: bad } });
  const sink = { started: false, send(o) {
    if (!this.started) { this.started = true; res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' }); }
    res.write('data: ' + JSON.stringify(o) + '\n\n');
  } };
  try {
    if (payload.stream) {
      const r = await routeStream(payload, E, sink);
      if (r === null) return res.end();
      return res.status(r.status).json(r.body);
    }
    const result = await route(payload, E);
    return res.status(result.status).json(result.body);
  } catch (e) {
    if (sink.started) { sink.send({ error: 'The AI connection was interrupted. Please try again.' }); return res.end(); }
    return res.status(500).json({ error: { message: 'Unexpected server error. Please try again.' } });
  }
};
