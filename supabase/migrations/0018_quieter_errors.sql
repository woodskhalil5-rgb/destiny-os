-- Agent errors: at most one email per business per day, and when the Claude account itself is out of credit
-- (every business fails the same way), one platform-wide email per day that says what to do.
create or replace function os.on_run_error() returns trigger language plpgsql security definer set search_path = os as $$
begin
  if new.status = 'error' and old.status is distinct from 'error' then
    if coalesce(new.error, '') ilike '%credit balance is too low%' or coalesce(new.error, '') ilike '%API access%turned off%' then
      perform os.alert(null, 'platform', 'api_credit',
        'Destiny OS: the AI account is out of credit, agents are stopped',
        'The Claude API account that powers the agents has run out of credit, so every team is stopped until it is topped up. Add credit (or turn on auto-reload) at console.anthropic.com under Billing. The teams pick back up on their next work hour; nothing else needs doing.',
        'api_credit:' || to_char(now(), 'YYYYMMDD'));
    else
      perform os.alert(new.business_id, 'platform', 'agent_error',
        (select name from os.businesses where id = new.business_id) || ': an agent hit an error',
        coalesce(new.slot, '?') || ': ' || coalesce(new.error, 'unknown error'),
        'err:' || new.business_id || ':' || to_char(now(), 'YYYYMMDD'));
    end if;
  end if;
  return new;
end $$;
