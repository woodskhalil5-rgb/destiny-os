-- 0063 (Nov 11 2026): os.auto_acquisitions waited until EVERY agent had instructions, but the CEO slot (executive,
-- added in 0057) stays empty and switched off on client accounts, so new acquisitions sign-ups never got set up
-- (JTM Holding LLC, Jason Moore). Only enabled agents need instructions now. JTM was then given the same team
-- instructions, acquisitions config (kind, own-phone call sheet, property records) and strategy notes as Moore
-- Holding LLC by hand in the session; the alert was marked setup_failed_fixed.
do $d$ declare f text := pg_get_functiondef('os.auto_acquisitions()'::regprocedure);
begin
  f := replace(f, $r$where a.business_id = b.id and coalesce(a.role_instructions, '') = '')$r$,
                  $r$where a.business_id = b.id and a.enabled and coalesce(a.role_instructions, '') = '')$r$);
  execute f;
end $d$;
