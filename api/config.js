// Public, non-secret settings for the browser: the Supabase project URL and its PUBLIC key (anon / publishable).
// Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel. A secret/service_role key is refused on purpose.
const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '');
function isSecret(key) {
  if (/^sb_secret_/.test(key)) return true;
  const m = key.split('.'); if (m.length !== 3) return false;
  try { return JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).role === 'service_role'; } catch (e) { return false; }
}
module.exports = function handler(req, res) {
  const E = process.env, url = clean(E.SUPABASE_URL || E.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, ''), key = clean(E.SUPABASE_ANON_KEY || E.SUPABASE_PUBLISHABLE_KEY || E.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || key.length < 20 || isSecret(key)) return res.status(200).json({});
  return res.status(200).json({ supabaseUrl: url, supabaseAnonKey: key });
};
