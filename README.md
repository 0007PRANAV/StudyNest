# StudyNest

A mobile-first study companion with notes, question papers, timetables, homework, a study room, friends, chat, announcements, an AI tutor, a library, moderated videos, daily streaks, and 119 achievements.

## New: library, videos, streaks & achievements

- **📚 Library** — a built-in shelf of 90+ free/open books and courses (Gutenberg, OpenStax, MIT OCW, Khan Academy, NCERT and more) across 13 categories, with search, save and read tracking. Admins can add or remove shared books.
- **🎬 Videos** — only approved, genuinely educational videos are visible. Students can submit a link or upload a video file (max 100 MB). Submissions show **⏳ Waiting for Admin’s Approval** until an admin approves or declines them. Students get an in-app notification (and an email when a provider key is configured) on review.
- **🔥 Streaks** — a daily check-in streak with best/total counts, a 7-day strip, and a once-a-day surprise reward.
- **🏆 119 badges & levels** — badges across AI use, streaks, notes, homework, flashcards, quizzes, friends, library, videos, focus time, profile setup and special one-off actions. XP and levels are calculated automatically. Badges unlock with a toast and are saved to your account.
- **🪑 Study Room** — the old Seats page is now a daily-use room with three tabs: claim a seat, run a focus timer (15/25/50 min with a weekly chart), and see who else is in the room.
- **🔔 Notifications** — a bell in the top bar with an inbox for badge unlocks, surprises and video decisions.

## AI tutor

- Sees your notes, question papers, timetable, homework, seating and announcements, and can change them (with an Undo button).
- Attach images, PDFs and text files, or attach a whole notes folder; mention a folder name and it is attached automatically.
- Generates images (free Pollinations service) and short captioned explainer videos recorded in the browser.
- Chat history is saved per user on the device; answers render as formatted markdown with a "Thought for Ns" step breakdown.

## Storage

Uploaded photos, videos, PDFs, ZIPs and other files are stored as Blobs in IndexedDB on the user's device. Only small metadata (names, labels, timestamps) is kept in localStorage. Images are compressed to JPEG at quality 0.7 and 1100 px before saving. This avoids the ~5 MB localStorage limit that previously caused uploads to disappear.

## Accounts and cloud sync

Signing in uses Supabase Auth. Each account's per-user keys (`notes_*`, `qp_*`, `hw_*`, `aichats_*`, `plan_*`, `profile_*`, etc.) are mirrored to the `public.user_data` table, so the same account shows the same notes, homework and AI history in every tab and on every device. localStorage remains an offline cache.

- The app polls the cloud every 25 seconds while the tab is visible, and pushes local edits after a short debounce.
- Role and suspension flags always come from `public.profiles`, never from the cache.
- Passwords and session tokens are never synced.
- "Download my data" produces a complete JSON backup plus a readable PDF summary.

### Login notes

- You can sign in with a username (`pranav`) or the full email used at signup (`name@gmail.com`).
- If a username is shared by two accounts, use the full email so the app signs you into the right one.
- The canonical admin dashboard is `https://studynest-admin.vercel.app/`. `/admin` on the main site redirects there.

## Database setup for the new sections

Run **one file** in Supabase → SQL Editor → New query → paste → Run:

```
StudyNest/supabase/migrations/20261111_library_videos_badges.sql
```

Or use the combined file in the admin repo: `StudyNest-Admin/RUN_ALL_FIXES.sql` (includes the admin fixes and the new tables). It is safe to run more than once.

It creates `library_books`, `library_progress`, `video_submissions`, `user_streaks`, `user_badges`, `notifications`, `focus_sessions`, and the public `videos` storage bucket, with RLS policies. Until it is run, the app still works: library and video data fall back to the device, and badge/streak data stays local.

### Email notifications (optional)

Video approval/decline emails use `/api/notify`, which supports Resend or Brevo. Set in Vercel:

- `RESEND_API_KEY` + `NOTIFY_FROM`, or
- `BREVO_API_KEY` + `NOTIFY_FROM`

Without a key, students still receive an in-app notification in the 🔔 inbox.

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
