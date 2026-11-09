-- The rep brief needs os-jobs to understand audience 'person' (send to ref.to). Until that os-jobs version is live,
-- an older os-jobs would send the brief to the business owner instead. So the brief only runs once the platform
-- flag 'person_alerts_ready' is set (set it after deploying os-jobs from main).
create or replace function os.rep_brief_gated() returns integer language sql security definer set search_path = os as $$
  select case when exists (select 1 from os.platform_state where key = 'person_alerts_ready') then os.rep_brief() else 0 end;
$$;
select cron.unschedule('os-rep-brief') where exists (select 1 from cron.job where jobname = 'os-rep-brief');
select cron.schedule('os-rep-brief', '35 * * * *', 'select os.rep_brief_gated()');
