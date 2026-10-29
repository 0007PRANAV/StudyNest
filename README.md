# StudyNest

A mobile-first study companion with notes, question papers, timetables, homework, seating, friends, chat, announcements and an AI tutor.

## AI tutor

- Sees your notes, question papers, timetable, homework, seating and announcements, and can change them (with an Undo button).
- Attach images, PDFs and text files, or attach a whole notes folder; mention a folder name and it is attached automatically.
- Generates images (free Pollinations service) and short captioned explainer videos recorded in the browser.
- Chat history is saved per user on the device; answers render as formatted markdown with a "Thought for Ns" step breakdown.

## Storage

Uploaded photos, videos, PDFs, ZIPs and other files are stored as Blobs in IndexedDB on the user's device. Only small metadata (names, labels, timestamps) is kept in localStorage. This avoids the ~5 MB localStorage limit that previously caused uploads to disappear.

## AI setup (required)

The browser never holds an API key. AI requests go to `/api/ai`, which is implemented for both hosting setups:

- Vercel: `api/ai.js` (this is what `study-nest-ashen.vercel.app` uses)
- Cloudflare Workers: `worker.js`

### Vercel

1. Open the project in Vercel → **Settings** → **Environment Variables**.
2. Add either key for Production, Preview, and Development:
   - `GEMINI_API_KEY` — free tier available from [Google AI Studio](https://aistudio.google.com/apikey)
   - `ANTHROPIC_API_KEY` — paid Anthropic key
3. Redeploy the project.
4. Optional overrides: `GEMINI_MODEL`, `ANTHROPIC_MODEL`, or `AI_PROVIDER` (`gemini` / `anthropic`). Providers are tried in order and fall back automatically if one fails.
5. Check the setup by opening `/api/ai` in a browser: it shows which keys the server can see (never the key values).

Note: keys must be set in Vercel (or as Cloudflare Worker secrets). GitHub repository/environment secrets are not visible to the running site.

Without either key, text AI falls back to the free, rate-limited Pollinations API so the AI tutor still works. Image-based AI tools require `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`.

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
