# StudyNest

A mobile-first study companion with notes, question papers, timetables, homework, seating, friends, chat, announcements and an AI tutor.

## Storage

Uploaded photos, videos, PDFs, ZIPs and other files are stored as Blobs in IndexedDB on the user's device. Only small metadata (names, labels, timestamps) is kept in localStorage. This avoids the ~5 MB localStorage limit that previously caused uploads to disappear.

## AI setup (required)

The browser never holds an API key. AI requests go to `/api/ai`, handled by the Cloudflare Worker in `worker.js`.

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
