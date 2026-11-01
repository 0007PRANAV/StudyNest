# Turning on Cloud backup (about 5 minutes)

1. In Supabase, create or open the project to use. Go to **SQL Editor -> New query**, paste `supabase/schema.sql`, press **Run**.
2. **Authentication -> Providers -> Email**: keep it enabled. Leave "Confirm email" on (recommended). Under **Authentication -> URL Configuration** set the Site URL to your Vercel address.
3. **Project Settings -> API**: copy the **Project URL** and the **anon / publishable** key. Never use the `service_role` or `sb_secret_` key; the server refuses it.
4. In Vercel (Settings -> Environment Variables, Production) add `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then Redeploy.
5. Open the app -> Profile. A "Cloud backup" card appears. Sign-in uses email + password; data is private to each user by Row Level Security.

Run the tests: `npm i jsdom @electric-sql/pglite`, then `node tests/schema.test.js` (database rules), `node tests/cloud.test.js`, `node tests/security.test.js`, `node tests/study.test.js`, `node tests/ui.test.js`, `node tests/ai_backend.test.js`.
