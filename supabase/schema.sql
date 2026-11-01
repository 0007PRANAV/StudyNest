-- StudyNest cloud backup schema. Run ONCE in Supabase: SQL Editor -> New query -> paste -> Run.
-- One private row per (user, key). Row Level Security makes every row visible only to its owner.

create table if not exists public.user_data (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key        text not null check (char_length(key) between 1 and 120),
  value      jsonb not null check (octet_length(value::text) <= 1000000),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_data enable row level security;

drop policy if exists "own rows: read"   on public.user_data;
drop policy if exists "own rows: insert" on public.user_data;
drop policy if exists "own rows: update" on public.user_data;
drop policy if exists "own rows: delete" on public.user_data;
create policy "own rows: read"   on public.user_data for select to authenticated using (auth.uid() = user_id);
create policy "own rows: insert" on public.user_data for insert to authenticated with check (auth.uid() = user_id);
create policy "own rows: update" on public.user_data for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows: delete" on public.user_data for delete to authenticated using (auth.uid() = user_id);

-- Signed-out visitors (anon key) get no access at all.
revoke all on public.user_data from anon;
grant select, insert, update, delete on public.user_data to authenticated;

-- Keep updated_at honest and stop one account from storing unlimited rows (400 max).
create or replace function public.user_data_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists user_data_touch_trg on public.user_data;
create trigger user_data_touch_trg before update on public.user_data for each row execute function public.user_data_touch();

create or replace function public.user_data_cap() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.user_data where user_id = new.user_id) >= 400 then
    raise exception 'Too many backup items for this account';
  end if;
  return new;
end $$;
drop trigger if exists user_data_cap_trg on public.user_data;
create trigger user_data_cap_trg before insert on public.user_data for each row execute function public.user_data_cap();
