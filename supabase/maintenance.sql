-- ============================================================================
-- StudyNest · storage housekeeping
-- ----------------------------------------------------------------------------
-- Safe to run at any time (Supabase → SQL Editor). It only removes expired
-- authentication junk and old read notifications, then reclaims disk space.
-- Nothing a student can still see is deleted.
--
-- Free plan budget: 500 MB database / 1 GB storage / 5 GB egress.
-- StudyNest currently uses ~13 MB (2.6%), so this is preventive, not urgent.
-- ============================================================================

-- 1. Expired / revoked auth tokens and abandoned OAuth flows.
--    These are the rows that quietly grow on every login. Wrapped in DO blocks
--    so a schema difference can never abort the whole script.
do $$ begin
  delete from auth.refresh_tokens where updated_at < now() - interval '30 days';
exception when others then raise notice 'refresh_tokens skipped: %', sqlerrm; end $$;

do $$ begin
  delete from auth.one_time_tokens where created_at < now() - interval '1 day';
exception when others then raise notice 'one_time_tokens skipped: %', sqlerrm; end $$;

do $$ begin
  delete from auth.flow_state where created_at < now() - interval '1 day';
exception when others then raise notice 'flow_state skipped: %', sqlerrm; end $$;

-- 2. Old notifications that the user has already read.
do $$ begin
  delete from public.notifications where read = true and created_at < now() - interval '60 days';
exception when others then raise notice 'old notifications skipped: %', sqlerrm; end $$;

-- 3. Keep only the newest 60 notifications per user.
do $$ begin
  delete from public.notifications n
   using (
     select id, row_number() over (partition by user_id order by created_at desc) as rn
       from public.notifications
   ) ranked
   where n.id = ranked.id and ranked.rn > 60;
exception when others then raise notice 'notification cap skipped: %', sqlerrm; end $$;

-- 4. Report the footprint (run this on its own if the editor complains).
select 'db_total' as metric, pg_size_pretty(pg_database_size(current_database())) as value
union all
select 'public_tables', pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)), 0))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r' and n.nspname = 'public';
