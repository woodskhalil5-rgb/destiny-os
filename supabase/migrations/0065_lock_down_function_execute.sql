-- 0065 (Nov 11 2026, health check): server-side functions run only from cron and the edge functions (as the database
-- owner), never from signed-in API users. Remove the default EXECUTE every new function gets in os and reels, keep only
-- os.member_role (row-level security calls it), stop new functions getting it, lock the old team-portal and trigger
-- functions in public, and pin search paths the linter flagged.
do $d$ declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('os', 'reels') and p.prokind = 'f' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $d$;
grant execute on function os.member_role(uuid) to authenticated;
alter default privileges in schema os revoke execute on functions from public;
alter default privileges in schema reels revoke execute on functions from public;
revoke execute on function public.team_hourly() from public, anon, authenticated;
revoke execute on function public.trade_owner_msg() from public, anon, authenticated;
revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;
revoke execute on function public.enforce_agent_publication_gate() from public, anon, authenticated;
revoke execute on function public.enforce_service_request_consent() from public, anon, authenticated;
alter function os.bid_trades(text) set search_path = os;
alter function os.executive_off_by_default() set search_path = os;
alter function os.no_retired_agents() set search_path = os;
alter function os.routine_kind(text) set search_path = os;
