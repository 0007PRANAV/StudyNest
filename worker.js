const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

async function handleAI(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type'
      }
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: { message: 'Use POST for this endpoint.' } }, 405);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: { message: 'AI is not configured. Add ANTHROPIC_API_KEY as a secret on the Worker.' } }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: 'Invalid JSON body.' } }, 400);
  }

  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return jsonResponse({ error: { message: 'A non-empty messages array is required.' } }, 400);
  }

  const body = {
    model: env.AI_MODEL || DEFAULT_MODEL,
    max_tokens: Math.min(Math.max(parseInt(payload.max_tokens, 10) || 1000, 1), 4000),
    messages: payload.messages
  };
  if (payload.system) body.system = String(payload.system);

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return jsonResponse({ error: { message: 'Could not reach the AI service. Please try again.' } }, 502);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai') {
      return handleAI(request, env);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  }
};
