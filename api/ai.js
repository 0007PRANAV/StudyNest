const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

function clampMaxTokens(value) {
  const n = parseInt(value, 10) || 1000;
  return Math.min(Math.max(n, 1), 4000);
}

function envKey(names, fuzzy) {
  const normalize = name => String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const wanted = names.map(normalize);
  for (const name of Object.keys(process.env)) {
    const value = process.env[name];
    if (!value) continue;
    const normalized = normalize(name);
    if (wanted.includes(normalized) || (fuzzy && fuzzy(normalized))) return value.trim();
  }
  return '';
}

function errorMessage(data, fallback) {
  return (data && data.error && (data.error.message || data.error)) || fallback;
}

async function callAnthropic(payload, apiKey) {
  const body = {
    model: process.env.ANTHROPIC_MODEL || process.env.AI_MODEL || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: clampMaxTokens(payload.max_tokens),
    messages: payload.messages
  };
  if (payload.system) body.system = String(payload.system);

  const upstream = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const text = await upstream.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

  if (!upstream.ok) {
    const status = upstream.status >= 400 ? upstream.status : 502;
    return { status, body: { error: { message: errorMessage(data, 'Anthropic request failed (HTTP ' + upstream.status + ').') } } };
  }
  return { status: 200, body: data || { content: [] } };
}

function toGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (typeof message.content === 'string') {
      parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block) continue;
        if (block.type === 'text' && block.text) {
          parts.push({ text: String(block.text) });
        } else if (block.type === 'image' && block.source && block.source.data) {
          parts.push({
            inline_data: {
              mime_type: block.source.media_type || 'image/jpeg',
              data: block.source.data
            }
          });
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

async function callGemini(payload, apiKey) {
  const model = process.env.GEMINI_MODEL || process.env.AI_MODEL || DEFAULT_GEMINI_MODEL;
  const body = {
    contents: toGeminiContents(payload.messages),
    generationConfig: { maxOutputTokens: clampMaxTokens(payload.max_tokens) }
  };
  if (payload.system) body.system_instruction = { parts: [{ text: String(payload.system) }] };

  const upstream = await fetch(GEMINI_URL + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });
  const text = await upstream.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

  if (!upstream.ok) {
    const status = upstream.status >= 400 ? upstream.status : 502;
    return { status, body: { error: { message: errorMessage(data, 'Gemini request failed (HTTP ' + upstream.status + ').') } } };
  }

  const candidate = data && data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const answer = parts
    .filter(part => part && !part.thought && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();

  if (!answer) {
    const reason = (candidate && candidate.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason);
    return {
      status: 502,
      body: { error: { message: reason ? 'Gemini returned no text (' + reason + ').' : 'Gemini returned an empty response.' } }
    };
  }

  return { status: 200, body: { content: [{ type: 'text', text: answer }] } };
}

module.exports = async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Use POST for this endpoint.' } });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) {
      return res.status(400).json({ error: { message: 'Invalid JSON body.' } });
    }
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: { message: 'Invalid JSON body.' } });
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return res.status(400).json({ error: { message: 'A non-empty messages array is required.' } });
  }

  const anthropicKey = envKey(
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_KEY'],
    name => name.includes('ANTHROPIC') && name.includes('KEY')
  );
  const geminiKey = envKey(
    ['GEMINI_API_KEY', 'GEMINI_APIKEY', 'GEMINI_KEY', 'GOOGLE_GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    name => (name.includes('GEMINI') || name.includes('GOOGLE')) && name.includes('KEY')
  );
  const requested = String(envKey(['AI_PROVIDER']) || '').toLowerCase();

  let result;
  try {
    if (requested === 'gemini' && geminiKey) {
      result = await callGemini(payload, geminiKey);
    } else if (requested === 'anthropic' && anthropicKey) {
      result = await callAnthropic(payload, anthropicKey);
    } else if (geminiKey) {
      result = await callGemini(payload, geminiKey);
    } else if (anthropicKey) {
      result = await callAnthropic(payload, anthropicKey);
    } else {
      return res.status(500).json({ error: { message: 'AI is not configured. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY) in your Vercel project settings.' } });
    }
  } catch (e) {
    return res.status(502).json({ error: { message: 'Could not reach the AI service. Please try again.' } });
  }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  return res.status(result.status).send(JSON.stringify(result.body));
};
