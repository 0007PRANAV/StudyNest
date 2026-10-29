# StudyNest database (Supabase)

`migrations/20261030000000_studynest_core.sql` creates the whole schema: profiles, friends, WhatsApp-style messages
(reactions, stars, delete-for-me), notes & question-paper folders/files with sharing, homework, timetable,
announcements, seating, saved AI chats, private storage buckets, and Row Level Security on every table.

## Apply it
1. Supabase dashboard -> the StudyNest project -> **SQL Editor** -> **New query**.
2. Paste the file and press **Run**. It is safe to run twice; it never drops or rewrites existing tables.
3. Make yourself an admin (SQL editor only; the app cannot do this):
   `update public.profiles set role = 'admin' where username = 'your_username';`
4. Dashboard -> **Authentication -> Providers**: keep Email on and decide whether to require email confirmation.

## Rules the database enforces
- Logged-out visitors (`anon`) can read and write nothing.
- You can only message accepted friends; you can edit/delete only your own messages; only the recipient can mark them read.
- Folders, files, homework and AI chats are private to their owner. Notes are visible to a friend only after you share that subject.
- Only admins can post announcements or change the timetable. Nobody can sign up or promote themselves to admin.
- One seat per person per day, and only for today.
- Never put the `service_role` key in the website. Only the project URL and the public `anon` key belong in frontend code.
