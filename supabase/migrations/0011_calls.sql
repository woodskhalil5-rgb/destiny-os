-- The dialer: every business can get its own phone number, and its people (including a VA with the
-- "caller" role) call from the browser. Billed like AI usage: Twilio's cost plus a per-minute fee,
-- plus a monthly fee for the number.

-- 1. A "caller" role for VAs: can make calls and use Team chat, nothing else.
alter table os.business_members drop constraint if exists business_members_role_check;
alter table os.business_members add constraint business_members_role_check check (role in ('owner', 'admin', 'operator', 'caller', 'viewer'));

-- 2. Pricing per business (the platform owner can change both under Money > Pricing).
alter table os.businesses
  add column if not exists call_fee_per_min numeric not null default 0.50,
  add column if not exists phone_fee_usd numeric not null default 5;

-- 3. What Twilio charges the platform (edit here if their prices change).
create table if not exists os.call_rates (
  id int primary key default 1 check (id = 1),
  outbound_per_min numeric not null default 0.014,
  inbound_per_min numeric not null default 0.0085,
  browser_per_min numeric not null default 0.004,
  record_per_min numeric not null default 0.0025,
  number_per_month numeric not null default 1.15,
  updated_at timestamptz not null default now()
);
insert into os.call_rates (id) values (1) on conflict do nothing;

-- 4. Every call, in and out.
create table if not exists os.calls (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  direction text not null check (direction in ('outbound', 'inbound')),
  to_number text, from_number text,
  record_id bigint references os.records(id) on delete set null,
  queue_id bigint,
  user_id uuid,
  twilio_sid text unique,
  status text not null default 'started',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_sec int not null default 0,
  minutes int not null default 0,
  recorded boolean not null default false,
  recording_sid text,
  voicemail boolean not null default false,
  cost_usd numeric not null default 0,
  billed_usd numeric not null default 0,
  outcome text,
  note text
);
create index if not exists calls_biz on os.calls (business_id, started_at desc);

-- 5. The VA's call list. The agents (and people) add to it; one open entry per number.
create table if not exists os.call_queue (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  record_id bigint references os.records(id) on delete set null,
  phone text not null,
  name text,
  reason text,
  queued_by text not null,
  status text not null default 'open' check (status in ('open', 'done', 'skipped')),
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create unique index if not exists call_queue_open on os.call_queue (business_id, phone) where status = 'open';

-- 6. Numbers that must never be called again (anyone who says stop).
create table if not exists os.never_call (
  business_id uuid not null references os.businesses(id) on delete cascade,
  phone text not null,
  reason text,
  added_by text,
  created_at timestamptz not null default now(),
  primary key (business_id, phone)
);

alter table os.call_rates enable row level security;
alter table os.calls enable row level security;
alter table os.call_queue enable row level security;
alter table os.never_call enable row level security;
grant all on os.call_rates, os.calls, os.call_queue, os.never_call to service_role;
grant all on all sequences in schema os to service_role;

-- 7. The bill: calls and the phone number become their own lines (invoices use these lines too).
create or replace function os.month_bill(bid uuid, month date default date_trunc('month', now())::date)
returns table (line text, kind text, amount_usd numeric, our_cost_usd numeric)
language sql stable security definer set search_path = os as $$
  select 'AI team (your six agents)', 'ai_usage', coalesce(sum(billed_usd), 0), coalesce(sum(cost_usd), 0)
    from os.usage_events where business_id = bid and at >= month and at < month + interval '1 month'
  union all
  select 'Platform fee', 'platform_fee', platform_fee_usd, 0 from os.businesses where id = bid and platform_fee_usd > 0
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
revoke all on function os.month_bill(uuid, date) from public;
grant execute on function os.month_bill(uuid, date) to service_role;

-- 8. The agents can put people on the VA's call list.
update os.agents set default_tools = default_tools || array['queue_call']
  where slot in ('research', 'coordination', 'distribution') and not ('queue_call' = any(default_tools));
