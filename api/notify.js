// POST /api/notify  { to, subject, text }
// Sends an email through Resend or Brevo. Configure ONE of these env vars in Vercel:
//   RESEND_API_KEY   + NOTIFY_FROM  (e.g. "StudyNest <hello@yourdomain.com>")
//   BREVO_API_KEY    + NOTIFY_FROM
// If no key is configured the endpoint returns { ok:false, skipped:true } so the
// in-app notification still works and nothing breaks.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'Invalid JSON body' });

  const to = String(body.to || '').trim();
  const subject = String(body.subject || 'StudyNest').slice(0, 180);
  const text = String(body.text || '').slice(0, 8000);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ ok: false, error: 'Invalid recipient email' });

  // Only signed-in StudyNest users may trigger an email (prevents an open relay).
  const url = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anon = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!url || !anon) return res.status(503).json({ ok: false, skipped: true, reason: 'SUPABASE_URL / SUPABASE_ANON_KEY are not configured' });
  if (!token) return res.status(401).json({ ok: false, error: 'Sign in required' });
  try {
    const who = await fetch(url + '/auth/v1/user', { headers: { apikey: anon, Authorization: 'Bearer ' + token } });
    if (!who.ok) return res.status(401).json({ ok: false, error: 'Session expired' });
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Could not verify session' });
  }

  const from = process.env.NOTIFY_FROM || 'StudyNest <onboarding@resend.dev>';
  const resendKey = process.env.RESEND_API_KEY;
  const brevoKey = process.env.BREVO_API_KEY;

  try {
    if (resendKey) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text })
      });
      const j = await safeJson(r);
      if (!r.ok) return res.status(502).json({ ok: false, provider: 'resend', error: (j && (j.message || j.error)) || ('HTTP ' + r.status) });
      return res.status(200).json({ ok: true, provider: 'resend', id: j && j.id });
    }
    if (brevoKey) {
      const m = /<([^>]+)>/.exec(from);
      const senderEmail = (m ? m[1] : from).trim();
      const senderName = m ? from.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '') || 'StudyNest' : 'StudyNest';
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: to }],
          subject,
          textContent: text
        })
      });
      const j = await safeJson(r);
      if (!r.ok) return res.status(502).json({ ok: false, provider: 'brevo', error: (j && (j.message || j.code)) || ('HTTP ' + r.status) });
      return res.status(200).json({ ok: true, provider: 'brevo', id: j && j.messageId });
    }
    return res.status(200).json({ ok: false, skipped: true, reason: 'No RESEND_API_KEY or BREVO_API_KEY configured' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : 'Email failed' });
  }
};

async function safeJson(r) {
  try { return await r.json(); } catch (e) { return null; }
}
