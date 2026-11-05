-- Free trials: 14 days, no platform fee, DMG covers AI usage up to a cap (the business's monthly limit during the trial).
-- Started by the platform owner (invite) or by the business itself on /trial after confirming its email.
-- When it ends: card on file -> full plan; no card -> the team pauses until one is added.

alter table os.businesses add column if not exists trial_ends_at timestamptz;
alter table os.businesses add column if not exists trial_converted boolean not null default false;

create table if not exists os.trial_signups (
  id bigserial primary key,
  email text not null,
  ip text,
  details jsonb not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used boolean not null default false,
  business_id uuid references os.businesses(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists trial_signups_email on os.trial_signups (lower(email), created_at desc);
alter table os.trial_signups enable row level security;

-- The bill: nothing for the trial period. AI usage before the trial ended isn't billed (DMG covers it), and the platform
-- fee is prorated from the day the trial ended.
create or replace function os.month_bill(bid uuid, month date default (date_trunc('month', now()))::date)
returns table(line text, kind text, amount_usd numeric, our_cost_usd numeric)
language sql stable security definer set search_path to 'os' as $$
  with t as (select trial_ends_at as te from os.businesses where id = bid)
  select 'AI team (your six agents)', 'ai_usage', coalesce(sum(u.billed_usd), 0), coalesce(sum(u.cost_usd), 0)
    from os.usage_events u, t where u.business_id = bid and u.at >= month and u.at < month + interval '1 month' and (t.te is null or u.at >= t.te)
  union all
  select case when t.te > month then 'Platform fee (from the end of your free trial)' else 'Platform fee' end, 'platform_fee',
         round(b.platform_fee_usd * case when t.te is null or t.te <= month then 1
                                         when t.te >= month + interval '1 month' then 0
                                         else extract(epoch from (month + interval '1 month' - t.te)) / extract(epoch from (month + interval '1 month' - month::timestamptz)) end, 2), 0
    from os.businesses b, t where b.id = bid and b.platform_fee_usd > 0 and (t.te is null or t.te < month + interval '1 month')
  union all
  select 'Phone calls (' || coalesce(sum(minutes), 0) || ' min)', 'calls', coalesce(sum(billed_usd), 0), coalesce(sum(cost_usd), 0)
    from os.calls where business_id = bid and started_at >= month and started_at < month + interval '1 month'
    having count(*) > 0
  union all
  select 'Business phone number', 'phone_number', b.phone_fee_usd, r.number_per_month
    from os.businesses b cross join os.call_rates r
    where b.id = bid and exists (select 1 from os.integrations i where i.business_id = bid and i.provider = 'phone' and i.status = 'connected')
  union all
  select description, kind, amount_usd, null from os.charges
    where business_id = bid and (
      (recurring and starts_on < month + interval '1 month' and (ends_on is null or ends_on >= month))
      or (not recurring and starts_on >= month and starts_on < month + interval '1 month'))
$$;

-- Hourly: remind 3 days before the end; at the end, move to the full plan (card on file) or pause (no card).
create or replace function os.trial_sweep() returns void language plpgsql security definer set search_path to 'os' as $$
declare b record;
begin
  for b in select * from os.businesses where trial_ends_at between now() + interval '2 days' and now() + interval '3 days'
      and not trial_converted and billing_status <> 'active' and status <> 'archived' loop
    perform os.alert(b.id, 'business', 'trial_ending', 'Your Destiny OS free trial ends in 3 days',
      format('Your free trial for %s ends on %s. To keep your team working after that, add a card on the Money tab of your dashboard. You''re only billed from the day the trial ends.',
        b.name, to_char(b.trial_ends_at at time zone b.timezone, 'FMMonth FMDD')), 'trial3:' || b.id);
  end loop;
  for b in select * from os.businesses where trial_ends_at <= now() and not trial_converted and status <> 'archived' loop
    if b.billing_status = 'active' then
      update os.businesses set trial_converted = true, monthly_budget_usd = 200 where id = b.id;
      insert into os.messages (business_id, sender, body, status) values (b.id, 'system',
        'Your free trial is over and your card is on file, so the team keeps working on the full plan.', 'handled');
    elsif coalesce(b.monthly_budget_usd, -1) <> 0 then
      update os.businesses set status = case when status = 'live' then 'paused' else status end, monthly_budget_usd = 0 where id = b.id;
      insert into os.messages (business_id, sender, body, status) values (b.id, 'system',
        'Your free trial has ended, so the team is paused. Add a card on the Money tab and the team picks up where it left off.', 'handled');
      perform os.alert(b.id, 'business', 'trial_ended', 'Your Destiny OS free trial has ended',
        format('Your free trial for %s has ended and the team is paused. Add a card on the Money tab of your dashboard to keep it working; everything it did is saved.', b.name), 'trialend:' || b.id);
      perform os.alert(b.id, 'platform', 'trial_ended', b.name || ': trial ended without a card', 'The team is paused until they add a card.', 'trialend-p:' || b.id);
    end if;
  end loop;
end $$;

select cron.schedule('os-trials', '7 * * * *', 'select os.trial_sweep()') where not exists (select 1 from cron.job where jobname = 'os-trials');
