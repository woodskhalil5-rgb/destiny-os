-- Switch JHP from the original team (public.team_*, team-brain) to Destiny OS.
-- Run only after JHP's Resend and Gmail are connected under Connections (status 'connected').
-- Rollback: see the bottom of this file.

do $$
declare jhp uuid := (select id from os.businesses where slug = 'jhp');
begin
  if not exists (select 1 from os.integrations where business_id = jhp and provider = 'resend' and status = 'connected') then
    raise exception 'Connect JHP''s Resend (team@jerseyhomepros.com) under Connections first.';
  end if;

  -- Old team: pause it and stop its clocks (nothing is deleted).
  update public.team_settings set paused = true;
  perform cron.unschedule('team-hourly') where exists (select 1 from cron.job where jobname = 'team-hourly');
  perform cron.unschedule('team-mail-check') where exists (select 1 from cron.job where jobname = 'team-mail-check');

  -- Destiny OS JHP: same hours as before, go live.
  update os.businesses b set shift_start = s.shift_start, shift_end = s.shift_end, shift_days = s.shift_days, timezone = s.timezone, status = 'live'
  from public.team_settings s where b.id = jhp;

  insert into os.messages (business_id, sender, body) values (jhp, 'system',
    'Welcome to Destiny OS, team. Your contractors, past emails and the owner''s email preferences came over from the old board. '
    || '@demarcus check the records and open tasks, then give out today''s assignments. Outreach still goes from team@jerseyhomepros.com, and replies land on this board.');
  insert into os.activity_log (business_id, actor_type, actor, action, target) values (jhp, 'system', 'migration', 'jhp_cutover', 'jhp');
end $$;

-- Rollback (run by hand if needed):
--   update os.businesses set status = 'paused' where slug = 'jhp';
--   update public.team_settings set paused = false;
--   select cron.schedule('team-hourly', '2 * * * *', 'select public.team_hourly()');
--   -- team-mail-check: re-create with the same command it had (see cron history / repo notes).
