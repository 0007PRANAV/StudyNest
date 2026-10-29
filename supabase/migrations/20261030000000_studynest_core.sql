-- StudyNest core schema for Supabase (Postgres 15+).
-- Safe to run more than once. Nothing here drops or rewrites existing tables or data.
-- Every table has Row Level Security on; "anon" (logged-out visitors) gets no access at all.

-- ============ helpers ============
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ============ profiles ============
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text not null unique check (username ~ '^[a-z0-9_.]{3,30}$'),
  name        text not null check (char_length(name) between 1 and 80),
  role        text not null default 'student' check (role in ('student', 'admin')),
  avatar_path text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Age is private (only the owner can read it); everything else on profiles is visible to logged-in users.
create table if not exists public.profile_private (
  id  uuid primary key references public.profiles (id) on delete cascade,
  age smallint check (age between 5 and 120)
);

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin');
$$;

-- Creates the profile automatically when someone signs up. The role is ALWAYS 'student';
-- admins are promoted by hand (SQL editor / service role) so nobody can sign up as admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  meta  jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  uname text  := lower(coalesce(nullif(meta ->> 'username', ''), ''));
  uage  int;
begin
  if uname !~ '^[a-z0-9_.]{3,30}$' then uname := 'user_' || left(new.id::text, 8); end if;
  if exists (select 1 from public.profiles where username = uname) then
    uname := left(uname, 25) || '_' || left(new.id::text, 4);
  end if;
  insert into public.profiles (id, username, name)
  values (new.id, uname, left(coalesce(nullif(trim(meta ->> 'name'), ''), uname), 80));
  begin uage := (meta ->> 'age')::int; exception when others then uage := null; end;
  if uage between 5 and 120 then insert into public.profile_private (id, age) values (new.id, uage); end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Logged-in users cannot change roles (only the dashboard / service role, where auth.uid() is null).
create or replace function public.profiles_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.role is distinct from old.role then
    raise exception 'roles can only be changed from the Supabase dashboard';
  end if;
  return new;
end $$;
drop trigger if exists profiles_role_guard on public.profiles;
create trigger profiles_role_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- ============ friends ============
create table if not exists public.friend_requests (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);
-- one row per pair, whichever direction it was sent
create unique index if not exists friend_requests_pair_uq
  on public.friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index if not exists friend_requests_addressee_idx on public.friend_requests (addressee_id, status);
create index if not exists friend_requests_requester_idx on public.friend_requests (requester_id, status);

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friend_requests f
    where f.status = 'accepted'
      and ((f.requester_id = a and f.addressee_id = b) or (f.requester_id = b and f.addressee_id = a)));
$$;

-- ============ messages (WhatsApp-style chat) ============
create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  body         text not null default '' check (char_length(body) <= 4000),
  image_path   text,
  reply_to_id  uuid references public.messages (id) on delete set null,
  forwarded    boolean not null default false,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  read_at      timestamptz,
  deleted_at   timestamptz,
  check (sender_id <> recipient_id),
  check (deleted_at is not null or char_length(body) > 0 or image_path is not null)
);
create index if not exists messages_sender_idx    on public.messages (sender_id, created_at desc);
create index if not exists messages_recipient_idx on public.messages (recipient_id, created_at desc);
create index if not exists messages_unread_idx    on public.messages (recipient_id) where read_at is null;
create index if not exists messages_reply_idx     on public.messages (reply_to_id) where reply_to_id is not null;

create or replace function public.messages_guard()
returns trigger language plpgsql set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then return new; end if;  -- dashboard / service role
  if (new.id, new.sender_id, new.recipient_id, new.created_at, new.reply_to_id, new.forwarded)
     is distinct from (old.id, old.sender_id, old.recipient_id, old.created_at, old.reply_to_id, old.forwarded) then
    raise exception 'message fields cannot be changed';
  end if;
  if uid = old.sender_id then
    if new.read_at is distinct from old.read_at then raise exception 'only the recipient can mark a message as read'; end if;
    if old.deleted_at is not null then raise exception 'message was already deleted'; end if;
    if new.deleted_at is not null then
      new.body := ''; new.image_path := null;                 -- "delete for everyone"
    else
      if new.image_path is distinct from old.image_path then raise exception 'the photo cannot be changed'; end if;
      if new.body is distinct from old.body then new.edited_at := now(); end if;
    end if;
  elsif uid = old.recipient_id then
    if (new.body, new.image_path, new.edited_at, new.deleted_at)
       is distinct from (old.body, old.image_path, old.edited_at, old.deleted_at) then
      raise exception 'recipients can only mark messages as read';
    end if;
    if old.read_at is not null then new.read_at := old.read_at; end if;
  end if;
  return new;
end $$;
drop trigger if exists messages_guard_trg on public.messages;
create trigger messages_guard_trg before update on public.messages
  for each row execute function public.messages_guard();

create or replace function public.is_message_participant(mid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.messages m
                 where m.id = mid and (select auth.uid()) in (m.sender_id, m.recipient_id));
$$;

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)               -- one reaction per person, like WhatsApp
);
create index if not exists message_reactions_user_idx on public.message_reactions (user_id);

create table if not exists public.message_stars (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  primary key (message_id, user_id)
);
create index if not exists message_stars_user_idx on public.message_stars (user_id);

create table if not exists public.message_hidden (   -- "delete for me"
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  primary key (message_id, user_id)
);
create index if not exists message_hidden_user_idx on public.message_hidden (user_id);

-- ============ notes & question papers ============
create table if not exists public.folders (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('notes', 'qp')),
  subject    text not null check (subject in ('chemistry', 'physics', 'maths', 'english')),
  name       text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists folders_name_uq on public.folders (owner_id, kind, subject, lower(name));
drop trigger if exists folders_updated_at on public.folders;
create trigger folders_updated_at before update on public.folders for each row execute function public.set_updated_at();

create table if not exists public.files (
  id              uuid primary key default gen_random_uuid(),
  folder_id       uuid not null references public.folders (id) on delete cascade,
  owner_id        uuid not null references public.profiles (id) on delete cascade,
  storage_path    text not null unique,            -- "<owner uuid>/<folder uuid>/<file>" in the private "notes" bucket
  name            text not null check (char_length(name) between 1 and 200),
  mime_type       text,
  size_bytes      bigint check (size_bytes between 0 and 52428800),
  label           text check (char_length(label) <= 80),
  important       boolean not null default false,
  ai_summary      text check (char_length(ai_summary) <= 20000),
  ai_handwriting  text check (char_length(ai_handwriting) <= 20000),
  text_content    text check (char_length(text_content) <= 20000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists files_folder_idx on public.files (folder_id, created_at);
create index if not exists files_owner_idx  on public.files (owner_id);
drop trigger if exists files_updated_at on public.files;
create trigger files_updated_at before update on public.files for each row execute function public.set_updated_at();

create table if not exists public.note_shares (
  owner_id       uuid not null references public.profiles (id) on delete cascade,
  shared_with_id uuid not null references public.profiles (id) on delete cascade,
  subject        text not null check (subject in ('chemistry', 'physics', 'maths', 'english')),
  created_at     timestamptz not null default now(),
  primary key (owner_id, shared_with_id, subject),
  check (owner_id <> shared_with_id)
);
create index if not exists note_shares_with_idx on public.note_shares (shared_with_id);

create or replace function public.can_view_folder(fid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.folders f
    where f.id = fid
      and (f.owner_id = (select auth.uid())
           or (f.kind = 'notes' and exists (
                 select 1 from public.note_shares s
                 where s.owner_id = f.owner_id and s.shared_with_id = (select auth.uid()) and s.subject = f.subject))));
$$;

create or replace function public.can_read_note_object(path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.files fl where fl.storage_path = path and public.can_view_folder(fl.folder_id));
$$;

create or replace function public.can_read_chat_image(path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.messages m
                 where m.image_path = path and (select auth.uid()) in (m.sender_id, m.recipient_id));
$$;

-- ============ homework, timetable, announcements, seating, AI chats ============
create table if not exists public.homework (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  subject      text not null default 'other' check (subject in ('chemistry', 'physics', 'maths', 'english', 'other')),
  text         text not null check (char_length(text) between 1 and 500),
  done         boolean not null default false,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists homework_user_idx on public.homework (user_id, done, created_at desc);

create table if not exists public.timetable_slots (
  id         uuid primary key default gen_random_uuid(),
  day        text not null check (day in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday')),
  position   smallint not null check (position between 0 and 20),
  time_range text not null check (char_length(time_range) <= 30),
  subject    text not null check (char_length(subject) <= 60),
  room       text check (char_length(room) <= 40),
  unique (day, position)
);

create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 100),
  body       text not null check (char_length(body) between 1 and 1000),
  author_id  uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists announcements_created_idx on public.announcements (created_at desc);
create index if not exists announcements_author_idx  on public.announcements (author_id);

create table if not exists public.seats (
  day      date not null,
  seat_row smallint not null check (seat_row between 0 and 49),
  seat_col smallint not null check (seat_col between 0 and 49),
  user_id  uuid not null references public.profiles (id) on delete cascade,
  primary key (day, seat_row, seat_col),
  unique (day, user_id)                                   -- one seat per person per day
);
create index if not exists seats_user_idx on public.seats (user_id);

create table if not exists public.ai_chats (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null default 'New chat' check (char_length(title) <= 80),
  history    jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  log        jsonb not null default '[]'::jsonb check (jsonb_typeof(log) = 'array' and octet_length(log::text) < 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_chats_user_idx on public.ai_chats (user_id, updated_at desc);
drop trigger if exists ai_chats_updated_at on public.ai_chats;
create trigger ai_chats_updated_at before update on public.ai_chats for each row execute function public.set_updated_at();

-- ============ Row Level Security ============
do $$ declare t text; begin
  foreach t in array array['profiles','profile_private','friend_requests','messages','message_reactions','message_stars','message_hidden',
                           'folders','files','note_shares','homework','timetable_slots','announcements','seats','ai_chats']
  loop execute format('alter table public.%I enable row level security', t); end loop;
end $$;

-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (true);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
drop policy if exists profile_private_own on public.profile_private;
create policy profile_private_own on public.profile_private for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- friend requests
drop policy if exists fr_select on public.friend_requests;
create policy fr_select on public.friend_requests for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));
drop policy if exists fr_insert on public.friend_requests;
create policy fr_insert on public.friend_requests for insert to authenticated
  with check (requester_id = (select auth.uid()) and status = 'pending');
drop policy if exists fr_accept on public.friend_requests;
create policy fr_accept on public.friend_requests for update to authenticated
  using (addressee_id = (select auth.uid()) and status = 'pending')
  with check (addressee_id = (select auth.uid()) and status = 'accepted');
drop policy if exists fr_delete on public.friend_requests;
create policy fr_delete on public.friend_requests for delete to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

-- messages
drop policy if exists msg_select on public.messages;
create policy msg_select on public.messages for select to authenticated
  using ((select auth.uid()) in (sender_id, recipient_id));
drop policy if exists msg_insert on public.messages;
create policy msg_insert on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and public.are_friends(sender_id, recipient_id));
drop policy if exists msg_update on public.messages;
create policy msg_update on public.messages for update to authenticated
  using ((select auth.uid()) in (sender_id, recipient_id)) with check ((select auth.uid()) in (sender_id, recipient_id));

drop policy if exists react_select on public.message_reactions;
create policy react_select on public.message_reactions for select to authenticated using (public.is_message_participant(message_id));
drop policy if exists react_write on public.message_reactions;
create policy react_write on public.message_reactions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and public.is_message_participant(message_id));
drop policy if exists stars_own on public.message_stars;
create policy stars_own on public.message_stars for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and public.is_message_participant(message_id));
drop policy if exists hidden_own on public.message_hidden;
create policy hidden_own on public.message_hidden for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and public.is_message_participant(message_id));

-- notes & papers
drop policy if exists folders_select on public.folders;
create policy folders_select on public.folders for select to authenticated using (public.can_view_folder(id));
drop policy if exists folders_write on public.folders;
create policy folders_write on public.folders for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists files_select on public.files;
create policy files_select on public.files for select to authenticated using (public.can_view_folder(folder_id));
drop policy if exists files_write on public.files;
create policy files_write on public.files for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid())
              and exists (select 1 from public.folders f where f.id = folder_id and f.owner_id = (select auth.uid())));
drop policy if exists shares_select on public.note_shares;
create policy shares_select on public.note_shares for select to authenticated
  using ((select auth.uid()) in (owner_id, shared_with_id));
drop policy if exists shares_insert on public.note_shares;
create policy shares_insert on public.note_shares for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.are_friends(owner_id, shared_with_id));
drop policy if exists shares_delete on public.note_shares;
create policy shares_delete on public.note_shares for delete to authenticated using (owner_id = (select auth.uid()));

-- homework & AI chats: private to the owner
drop policy if exists homework_own on public.homework;
create policy homework_own on public.homework for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists ai_chats_own on public.ai_chats;
create policy ai_chats_own on public.ai_chats for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- timetable & announcements: everyone reads, admins write
drop policy if exists tt_select on public.timetable_slots;
create policy tt_select on public.timetable_slots for select to authenticated using (true);
drop policy if exists tt_admin on public.timetable_slots;
create policy tt_admin on public.timetable_slots for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists ann_select on public.announcements;
create policy ann_select on public.announcements for select to authenticated using (true);
drop policy if exists ann_admin on public.announcements;
create policy ann_admin on public.announcements for all to authenticated
  using (public.is_admin()) with check (public.is_admin() and author_id = (select auth.uid()));

-- seats: everyone sees today's seating, you can only take/free your own seat
drop policy if exists seats_select on public.seats;
create policy seats_select on public.seats for select to authenticated using (true);
drop policy if exists seats_insert on public.seats;
create policy seats_insert on public.seats for insert to authenticated
  with check (user_id = (select auth.uid()) and day = current_date);
drop policy if exists seats_delete on public.seats;
create policy seats_delete on public.seats for delete to authenticated using (user_id = (select auth.uid()));

-- ============ table privileges (least privilege) ============
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on public.profiles, public.timetable_slots, public.announcements, public.seats to authenticated;
grant update (name, avatar_path) on public.profiles to authenticated;
grant select, insert, update, delete on public.profile_private to authenticated;
grant select, insert, delete on public.friend_requests to authenticated;
grant update (status, responded_at) on public.friend_requests to authenticated;
grant select, insert on public.messages to authenticated;
grant update (body, edited_at, deleted_at, read_at) on public.messages to authenticated;
grant select, insert, update, delete on public.message_reactions, public.message_stars, public.message_hidden,
      public.folders, public.files, public.homework, public.ai_chats to authenticated;
grant select, insert, delete on public.note_shares to authenticated;
grant insert, update, delete on public.timetable_slots, public.announcements to authenticated;   -- RLS limits these to admins
grant insert, delete on public.seats to authenticated;
revoke execute on all functions in schema public from anon, public;
grant execute on function public.is_admin(), public.are_friends(uuid, uuid), public.is_message_participant(uuid),
      public.can_view_folder(uuid), public.can_read_note_object(text), public.can_read_chat_image(text) to authenticated;

-- ============ storage buckets (all private; files are served with signed URLs) ============
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('notes',       'notes',       false, 12582912, array['image/jpeg','image/png','image/webp','image/gif','application/pdf','text/plain']),
  ('chat-images', 'chat-images', false,  2097152, array['image/jpeg','image/png','image/webp']),
  ('avatars',     'avatars',     false,  1048576, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

-- Files live under "<your user id>/..." so a person can only write inside their own folder.
drop policy if exists notes_read on storage.objects;
create policy notes_read on storage.objects for select to authenticated
  using (bucket_id = 'notes' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.can_read_note_object(name)));
drop policy if exists notes_write on storage.objects;
create policy notes_write on storage.objects for insert to authenticated
  with check (bucket_id = 'notes' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists notes_update on storage.objects;
create policy notes_update on storage.objects for update to authenticated
  using (bucket_id = 'notes' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists notes_delete on storage.objects;
create policy notes_delete on storage.objects for delete to authenticated
  using (bucket_id = 'notes' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists chatimg_read on storage.objects;
create policy chatimg_read on storage.objects for select to authenticated
  using (bucket_id = 'chat-images' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.can_read_chat_image(name)));
drop policy if exists chatimg_write on storage.objects;
create policy chatimg_write on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists chatimg_delete on storage.objects;
create policy chatimg_delete on storage.objects for delete to authenticated
  using (bucket_id = 'chat-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects for select to authenticated using (bucket_id = 'avatars');
drop policy if exists avatars_write on storage.objects;
create policy avatars_write on storage.objects for all to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ============ realtime (live chat, seats, announcements) ============
do $$ declare t text; begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['messages','message_reactions','announcements','seats'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
