-- When the AI service itself is down for everyone (out of credit, key turned off), stop sending work to the agents
-- instead of letting every run fail. Messages wait in the queue; os-jobs checks every 5 minutes whether the service is
-- back, and when it is, clears the stale check-ins, re-sends what people wrote, and gives each live team a fresh start.
create table if not exists os.platform_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table os.platform_state enable row level security;

create or replace function os.ai_down() returns boolean language sql stable security definer set search_path = os as $$
  select exists (select 1 from os.platform_state where key = 'ai_down')
$$;

create or replace function os.is_ai_outage(err text) returns boolean language sql immutable as $$
  select coalesce(err, '') ilike any (array['%credit balance is too low%', '%API access%turned off%', '%authentication_error%', '%invalid x-api-key%', '%billing%permission%'])
$$;

create or replace function os.on_run_error() returns trigger language plpgsql security definer set search_path = os as $$
begin
  if new.status = 'error' and old.status is distinct from 'error' then
    if os.is_ai_outage(new.error) then
      insert into os.platform_state (key, value) values ('ai_down', jsonb_build_object('since', now(), 'error', left(new.error, 300)))
      on conflict (key) do nothing;
      perform os.alert(null, 'platform', 'api_credit',
        'Destiny OS: the AI service is down, teams are paused',
        'The Claude API account that powers the agents stopped working (' || left(new.error, 160) || '). Every team is paused and their work is waiting in line. Usually it means the credit ran out: add credit (and turn on auto-reload) at console.anthropic.com under Billing. The teams start again by themselves within 5 minutes of it working.',
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

-- The router: same as before, plus "wait while the AI service is down".
create or replace function os.wake_router() returns trigger language plpgsql security definer set search_path = os, public as $$
declare b os.businesses; spent numeric; from_person boolean;
begin
  if new.status <> 'queued' then return new; end if;
  if os.ai_down() then return new; end if;   -- stays queued; os.ai_back() picks it up
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

-- Called by os-jobs once a test call to the AI service works again.
create or replace function os.ai_back() returns int language plpgsql security definer set search_path = os, public as $$
declare since timestamptz; m record; n int := 0;
begin
  select coalesce((value->>'since')::timestamptz, now() - interval '1 day') into since from os.platform_state where key = 'ai_down';
  if not found then return 0; end if;
  delete from os.platform_state where key = 'ai_down';
  -- Automatic check-ins that piled up are dropped; each live team gets one fresh start instead.
  update os.messages set status = 'handled' where status = 'queued' and sender in ('system') and created_at >= since - interval '1 hour';
  -- What people wrote while it was down is sent to the team now.
  for m in select id from os.messages where status = 'queued' and created_at >= since - interval '1 hour' order by id loop
    perform net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-brain',
      headers := jsonb_build_object('content-type','application/json','authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY')),
      body := jsonb_build_object('message_id', m.id), timeout_milliseconds := 5000);
    n := n + 1;
  end loop;
  insert into os.messages (business_id, sender, body)
  select id, 'system', 'The AI service is back after a pause. @demarcus check where everyone left off and get the team going again.'
    from os.businesses b where b.status = 'live' and os.on_shift(b);
  perform os.alert(null, 'platform', 'api_back', 'Destiny OS: the AI service is back, teams are running',
    'The agents can reach the AI service again, so the teams picked back up. ' || n || ' message(s) people sent during the pause were passed to their teams.',
    'api_back:' || to_char(now(), 'YYYYMMDDHH24MI'));
  return n;
end $$;
