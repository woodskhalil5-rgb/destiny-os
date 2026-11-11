-- 0066 (Nov 11 2026): the old team portal (public.team_*, replaced by Destiny OS; last message Nov 4) no longer needs
-- its every-2-minutes watchdog. Paused, not deleted: turn back on with active := true.
select cron.alter_job(jobid, active := false) from cron.job where jobname = 'team-watchdog';
