-- Markets removed at the owner's request: no price job, no tables.
select cron.unschedule('os-markets') where exists (select 1 from cron.job where jobname = 'os-markets');
drop table if exists os.market_rules;
drop table if exists os.market_watch;
drop table if exists os.market_prefs;
