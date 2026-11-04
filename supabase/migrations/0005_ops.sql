-- Operations: spending cap, alerts to owners, publishing schedule.

-- 1. Every new business starts with a monthly AI cap (billed dollars). The platform owner can raise or clear it.
alter table os.businesses alter column monthly_budget_usd set default 200;
create index if not exists usage_events_biz_at on os.usage_events (business_id, at);

-- 2. Alerts: things a person should hear about by email. Sent in batches by os-jobs.
create table if not exists os.alerts (
  id bigserial primary key,
  business_id uuid references os.businesses(id) on delete cascade,
  audience text not null default 'platform' check (audience in ('platform', 'business')),
  kind text not null,
  subject text not null,
  body text not null,
  dedupe_key text unique,                -- one alert per key (e.g. budget warning once a month)
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);
alter table os.alerts enable row level security;
grant all on os.alerts to service_role;
grant all on all sequences in schema os to service_role;

create or replace function os.alert(bid uuid, aud text, k text, subj text, msg text, dkey text default null)
returns void language sql security definer set search_path = os as $$
  insert into os.alerts (business_id, audience, kind, subject, body, dedupe_key)
  values (bid, aud, k, subj, msg, dkey) on conflict (dedupe_key) do nothing;
$$;
revoke all on function os.alert(uuid, text, text, text, text, text) from public;

-- Agent errors: at most one alert per business per hour.
create or replace function os.on_run_error() returns trigger language plpgsql security definer set search_path = os as $$
begin
  if new.status = 'error' and old.status is distinct from 'error' then
    perform os.alert(new.business_id, 'platform', 'agent_error',
      (select name from os.businesses where id = new.business_id) || ': an agent hit an error',
      coalesce(new.slot, '?') || ': ' || coalesce(new.error, 'unknown error'),
      'err:' || new.business_id || ':' || to_char(now(), 'YYYYMMDDHH24'));
  end if;
  return new;
end $$;
drop trigger if exists agent_runs_error on os.agent_runs;
create trigger agent_runs_error after update on os.agent_runs for each row execute function os.on_run_error();

-- Billing problems: the platform owner and the business owner both hear about it.
create or replace function os.on_billing_change() returns trigger language plpgsql security definer set search_path = os as $$
begin
  if new.billing_status = 'past_due' and old.billing_status is distinct from 'past_due' then
    perform os.alert(new.id, 'platform', 'past_due', new.name || ': payment failed, team on hold',
      'A payment for ' || new.name || ' failed. Their team is on hold until it is paid.', null);
    perform os.alert(new.id, 'business', 'past_due', 'Your Destiny OS payment didn''t go through',
      'We couldn''t charge the card on file for ' || new.name || ', so your team is on hold. Sign in and update the card on the Costs tab; the team picks right back up once it''s paid.', null);
  end if;
  return new;
end $$;
drop trigger if exists businesses_billing on os.businesses;
create trigger businesses_billing after update of billing_status on os.businesses for each row execute function os.on_billing_change();

-- 3. The wake trigger also enforces the monthly cap and warns at 80%.
create or replace function os.wake_router() returns trigger language plpgsql security definer set search_path = os, public as $$
declare b os.businesses; spent numeric; from_person boolean;
begin
  if new.status <> 'queued' then return new; end if;
  select * into b from os.businesses where id = new.business_id;
  from_person := new.sender = 'owner' or new.sender like 'user:%';
  if b.billing_status = 'past_due' then
    update os.messages set status = 'handled' where id = new.id;
    if from_person then
      insert into os.messages (business_id, sender, body, status) values (new.business_id, 'system',
        'The team is on hold: a payment is overdue. Update the card on the Costs tab and they''ll pick right back up.', 'handled');
    end if;
    return new;
  end if;
  if b.monthly_budget_usd is not null then
    select coalesce(sum(billed_usd), 0) into spent from os.usage_events
      where business_id = b.id and at >= date_trunc('month', now());
    if spent >= b.monthly_budget_usd then
      update os.messages set status = 'handled' where id = new.id;
      if from_person then
        insert into os.messages (business_id, sender, body, status) values (new.business_id, 'system',
          'The team has used this month''s AI budget ($' || b.monthly_budget_usd || ') and is resting until next month or until the budget is raised.', 'handled');
      end if;
      perform os.alert(b.id, 'platform', 'budget_reached', b.name || ' reached its monthly AI budget',
        b.name || ' used $' || round(spent, 2) || ' of its $' || b.monthly_budget_usd || ' monthly AI budget. Its team is resting. Raise the budget on its Costs tab to continue.',
        'budget100:' || b.id || ':' || to_char(now(), 'YYYYMM'));
      perform os.alert(b.id, 'business', 'budget_reached', 'Your AI team reached this month''s budget',
        'Your team used this month''s $' || b.monthly_budget_usd || ' AI budget and is resting until next month. Reply to this email if you want it raised.',
        'budget100b:' || b.id || ':' || to_char(now(), 'YYYYMM'));
      return new;
    elsif spent >= 0.8 * b.monthly_budget_usd then
      perform os.alert(b.id, 'business', 'budget_80', 'Your AI team has used 80% of this month''s budget',
        'Your team has used $' || round(spent, 2) || ' of its $' || b.monthly_budget_usd || ' monthly AI budget. It keeps working until the budget is reached.',
        'budget80:' || b.id || ':' || to_char(now(), 'YYYYMM'));
    end if;
  end if;
  perform net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-brain',
    headers := jsonb_build_object('content-type','application/json','authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY')),
    body := jsonb_build_object('message_id', new.id),
    timeout_milliseconds := 5000);
  return new;
end $$;

-- 4. Background jobs (alerts, publishing) every 5 minutes.
create or replace function os.jobs() returns void language plpgsql security definer set search_path = os, public as $$
begin
  perform net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-jobs',
    headers := jsonb_build_object('content-type','application/json','authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY')),
    body := jsonb_build_object('action','tick'),
    timeout_milliseconds := 5000);
end $$;
revoke all on function os.jobs() from public;
select cron.schedule('os-jobs', '*/5 * * * *', 'select os.jobs()');
