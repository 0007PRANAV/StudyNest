const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

function clampMaxTokens(value) {
  const n = parseInt(value, 10) || 1000;
  return Math.min(Math.max(n, 1), 4000);
}

module.exports = async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Use POST for this endpoint.' } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'AI is not configured. Add ANTHROPIC_API_KEY in your Vercel project settings.' } });
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

  const body = {
    model: process.env.AI_MODEL || DEFAULT_MODEL,
    max_tokens: clampMaxTokens(payload.max_tokens),
    messages: payload.messages
  };
  if (payload.system) body.system = String(payload.system);

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return res.status(502).json({ error: { message: 'Could not reach the AI service. Please try again.' } });
  }

  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  return res.send(text);
};
