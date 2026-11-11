-- ============================================================
-- StudyNest: Library, moderated Videos, Streaks, Badges,
--            Notifications, Reading progress, Focus sessions
-- Run ONCE in Supabase -> SQL Editor -> New query -> Run.
-- Safe to run again.
-- ============================================================

-- ---------- 1. LIBRARY ----------
create table if not exists public.library_books (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 200),
  author      text not null default 'Unknown',
  category    text not null default 'General',
  description text not null default '',
  url         text not null,
  emoji       text not null default '📘',
  level       text not null default 'All levels',
  language    text not null default 'English',
  pages       int,
  is_public   boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table public.library_books enable row level security;

drop policy if exists library_read on public.library_books;
create policy library_read on public.library_books for select to authenticated
  using (is_public or created_by = auth.uid() or public.is_admin());

drop policy if exists library_admin_write on public.library_books;
create policy library_admin_write on public.library_books for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on public.library_books to authenticated;
grant insert, update, delete on public.library_books to authenticated;

-- ---------- 2. READING PROGRESS ----------
create table if not exists public.library_progress (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  book_id    text not null,
  status     text not null default 'reading' check (status in ('saved','reading','finished')),
  percent    int not null default 0 check (percent between 0 and 100),
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

alter table public.library_progress enable row level security;

drop policy if exists libprog_own on public.library_progress;
create policy libprog_own on public.library_progress for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists libprog_admin_read on public.library_progress;
create policy libprog_admin_read on public.library_progress for select to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.library_progress to authenticated;

-- ---------- 3. VIDEO SUBMISSIONS ----------
create table if not exists public.video_submissions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  username     text not null default '',
  email        text not null default '',
  title        text not null check (char_length(title) between 1 and 200),
  description  text not null default '',
  category     text not null default 'Educational',
  url          text not null default '',
  storage_path text not null default '',
  thumb_url    text not null default '',
  status       text not null default 'pending' check (status in ('pending','approved','declined')),
  admin_note   text not null default '',
  reviewed_by  uuid references auth.users(id) on delete set null,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);

alter table public.video_submissions enable row level security;

drop policy if exists video_read on public.video_submissions;
create policy video_read on public.video_submissions for select to authenticated
  using (status = 'approved' or user_id = auth.uid() or public.is_admin());

drop policy if exists video_insert_own on public.video_submissions;
create policy video_insert_own on public.video_submissions for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');

drop policy if exists video_admin_update on public.video_submissions;
create policy video_admin_update on public.video_submissions for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists video_delete on public.video_submissions;
create policy video_delete on public.video_submissions for delete to authenticated
  using (public.is_admin() or (user_id = auth.uid() and status = 'pending'));

grant select, insert, update, delete on public.video_submissions to authenticated;

create index if not exists video_status_idx on public.video_submissions (status, created_at desc);
create index if not exists video_user_idx   on public.video_submissions (user_id, created_at desc);

-- ---------- 4. STREAKS ----------
create table if not exists public.user_streaks (
  user_id        uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  current_streak int not null default 0,
  best_streak    int not null default 0,
  total_days     int not null default 0,
  last_day       date,
  freezes        int not null default 0,
  updated_at     timestamptz not null default now()
);

alter table public.user_streaks enable row level security;

drop policy if exists streaks_own on public.user_streaks;
create policy streaks_own on public.user_streaks for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists streaks_admin_read on public.user_streaks;
create policy streaks_admin_read on public.user_streaks for select to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.user_streaks to authenticated;

-- ---------- 5. BADGES ----------
create table if not exists public.user_badges (
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  badge_id  text not null,
  earned_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);

alter table public.user_badges enable row level security;

drop policy if exists badges_own on public.user_badges;
create policy badges_own on public.user_badges for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists badges_admin_read on public.user_badges;
create policy badges_admin_read on public.user_badges for select to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.user_badges to authenticated;

-- ---------- 6. NOTIFICATIONS ----------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  body       text not null default '',
  kind       text not null default 'info',
  link       text not null default '',
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.notifications enable row level security;

drop policy if exists notif_own_read on public.notifications;
create policy notif_own_read on public.notifications for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists notif_own_update on public.notifications;
create policy notif_own_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notif_admin_insert on public.notifications;
create policy notif_admin_insert on public.notifications for insert to authenticated
  with check (public.is_admin() or user_id = auth.uid());

drop policy if exists notif_admin_delete on public.notifications;
create policy notif_admin_delete on public.notifications for delete to authenticated
  using (public.is_admin() or user_id = auth.uid());

grant select, insert, update, delete on public.notifications to authenticated;

create index if not exists notif_user_idx on public.notifications (user_id, created_at desc);

-- ---------- 7. FOCUS SESSIONS ----------
create table if not exists public.focus_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null default current_date,
  minutes    int not null default 0 check (minutes between 0 and 1440),
  created_at timestamptz not null default now()
);

alter table public.focus_sessions enable row level security;

drop policy if exists focus_own on public.focus_sessions;
create policy focus_own on public.focus_sessions for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists focus_admin_read on public.focus_sessions;
create policy focus_admin_read on public.focus_sessions for select to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.focus_sessions to authenticated;

-- ---------- 8. VIDEO STORAGE BUCKET ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', true, 104857600,
        array['video/mp4','video/webm','video/quicktime','video/x-matroska','image/jpeg','image/png'])
on conflict (id) do update set public = true, file_size_limit = 104857600;

drop policy if exists "videos read" on storage.objects;
create policy "videos read" on storage.objects for select to public
  using (bucket_id = 'videos');

drop policy if exists "videos upload own" on storage.objects;
create policy "videos upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "videos delete own" on storage.objects;
create policy "videos delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'videos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ---------- 9. KEEP ADMIN ----------
update public.profiles set role = 'admin' where id = 'bdd4c035-29a3-47f9-aa01-efedcf3b4d81';

-- Verify
select 'library_books' as table_name, count(*) from public.library_books
union all select 'video_submissions', count(*) from public.video_submissions
union all select 'user_streaks', count(*) from public.user_streaks
union all select 'user_badges', count(*) from public.user_badges
union all select 'notifications', count(*) from public.notifications
union all select 'focus_sessions', count(*) from public.focus_sessions;
