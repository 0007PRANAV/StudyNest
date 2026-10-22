# StudyNest

A mobile-first study companion with notes, question papers, timetables, homework, seating, friends, chat, announcements and an AI tutor.

## Storage

Uploaded photos, videos, PDFs, ZIPs and other files are stored as Blobs in IndexedDB on the user's device. Only small metadata (names, labels, timestamps) is kept in localStorage. This avoids the ~5 MB localStorage limit that previously caused uploads to disappear.

## AI setup (required)

The browser never holds an API key. AI requests go to `/api/ai`, which is implemented for both hosting setups:

- Vercel: `api/ai.js` (this is what `study-nest-ashen.vercel.app` uses)
- Cloudflare Workers: `worker.js`

### Vercel

1. Open the project in Vercel → **Settings** → **Environment Variables**.
2. Add `ANTHROPIC_API_KEY` for Production, Preview, and Development.
3. Redeploy the project.
4. Optional: add `AI_MODEL` to override the default (`claude-sonnet-5-5`).

Without the environment variable, `/api/ai` returns a clear "AI is not configured" error.

### Cloudflare Workers

1. Deploy with Wrangler (the `assets` binding is already configured in `wrangler.jsonc`).
2. Add your Anthropic API key as a secret:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

3. Optional: override the model (default `claude-sonnet-5-5`):

```bash
npx wrangler secret put AI_MODEL
```

Run locally with:

```bash
npx wrangler dev
```

For local AI testing, create a `.dev.vars` file (already git-ignored):

```bash
ANTHROPIC_API_KEY=your-key-here
```
