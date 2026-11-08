-- A trial whose team setup failed (usually because the AI was down) is set up automatically once the AI is back:
-- up to 3 tries per business, checked every 10 minutes. The owner gets the normal "your team is set up" note.
create or replace function os.retry_trial_setups() returns int language plpgsql security definer set search_path = os as $$
declare r record; n int := 0;
begin
  if os.ai_down() then return 0; end if;
  for r in select b.id from os.businesses b join os.business_config c on c.business_id = b.id and c.active
      where c.note = 'free trial sign-up' and b.status <> 'archived'
        and b.created_at between now() - interval '30 days' and now() - interval '3 minutes'
        and exists (select 1 from os.alerts a where a.business_id = b.id and a.kind = 'setup_failed')
        and (select count(*) from os.activity_log l where l.business_id = b.id and l.action = 'setup_retry') < 3
      order by b.created_at limit 5 loop
    insert into os.activity_log (business_id, actor_type, actor, action, target, details) values (r.id, 'system', 'setup', 'setup_retry', r.id::text, '{}');
    perform net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-signup',
      headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY'), 'content-type', 'application/json'),
      body := jsonb_build_object('action', 'retry_setup', 'business_id', r.id), timeout_milliseconds := 120000);
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('os-retry-setup', '*/10 * * * *', 'select os.retry_trial_setups()') where not exists (select 1 from cron.job where jobname = 'os-retry-setup');
