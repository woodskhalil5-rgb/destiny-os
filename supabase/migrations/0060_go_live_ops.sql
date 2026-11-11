-- 0060: "do it all" (Nov 10 2026). Applied by hand in the session; recorded here for history.
--   * Grant (JHP CEO) works from JHP's real per-lead pricing (first 3 free; roofing $45, heating & cooling $40,
--     windows & doors $35, hardscaping $35, pest control $20, landscaping $20, moving $15, cleaning $12; max 3
--     companies per request; bad leads credited) and never changes it.
--   * JHP and DMG (destiny-os) set back to live (budgets unchanged: $200/month each, about $10/day).
--   * os.hq_scoreboard(force): every Monday 7am ET a WEEKLY SCOREBOARD in Destiny HQ (cron os-hq-scoreboard).
--   * Bid Desk: own-phone call sheet on; record type 'client' stages: call planned, called, bid check requested,
--     bid check sent, meeting, signed, lost; 10 JHP contractors in public-work trades copied as 'call planned' with a
--     Bid Desk call plan, for Khalil to call.
create or replace function os.hq_scoreboard(force boolean default false) returns integer language plpgsql security definer set search_path = os as $$
declare hq uuid; lt timestamp := now() at time zone 'America/New_York'; txt text; c record;
begin
  select id into hq from os.businesses where slug = 'destiny-hq';
  if hq is null then return 0; end if;
  if not force and (extract(isodow from lt) <> 1 or extract(hour from lt) <> 7) then return 0; end if;
  if not force and exists (select 1 from os.messages m where m.business_id = hq and m.body like 'WEEKLY SCOREBOARD%' and m.created_at > now() - interval '6 days') then return 0; end if;
  txt := 'WEEKLY SCOREBOARD · week of ' || to_char(lt::date, 'Mon DD') || E'\n';
  for c in select o.name, o.short, o.business_id from os.ceos o join os.businesses b on b.id = o.business_id where b.status <> 'archived' order by o.short loop
    txt := txt || E'\n' || upper(c.short) || ' (' || c.name || '): ' || os.ceo_numbers(c.business_id) || E'\n';
  end loop;
  txt := txt || E'\nAI cost across everything this month: $' || coalesce((select round(sum(cost_usd), 2) from os.usage_events where at >= date_trunc('month', now())), 0)
    || '. Waiting for your OK across your businesses: ' || (select count(*) from os.approvals a join os.businesses b on b.id = a.business_id where a.status = 'pending' and b.status <> 'archived' and b.plan = 'internal') || '.';
  insert into os.messages (business_id, sender, body, status) values (hq, 'system', txt, 'handled');
  return 1;
end $$;
revoke all on function os.hq_scoreboard(boolean) from public;
select cron.unschedule('os-hq-scoreboard') where exists (select 1 from cron.job where jobname = 'os-hq-scoreboard');
select cron.schedule('os-hq-scoreboard', '0 * * * 1', 'select os.hq_scoreboard()');
