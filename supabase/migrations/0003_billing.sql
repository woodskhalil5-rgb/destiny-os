-- Prices (USD per million tokens; web search per 1,000) from Anthropic's pricing page.
insert into os.model_prices (model, input_per_mtok, output_per_mtok, web_search_per_k) values
  ('claude-sonnet-5-5', 2, 10, 10), ('claude-opus-5-5', 4, 20, 10), ('claude-haiku-5-5', 0.10, 0.50, 10), ('claude-sonnet-5', 2, 10, 10)
on conflict (model) do update set input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok, web_search_per_k = excluded.web_search_per_k;

-- Our charge on top of AI usage, and a monthly platform fee, set per business.
alter table os.businesses
  add column if not exists markup_pct numeric not null default 30 check (markup_pct >= 0),
  add column if not exists platform_fee_usd numeric not null default 0 check (platform_fee_usd >= 0);
-- What the customer is billed for each AI call (our cost plus markup), fixed at the time of the call.
alter table os.usage_events add column if not exists billed_usd numeric;

-- Any other cost the customer pays. Recurring ones bill every month.
create table if not exists os.charges (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  kind text not null check (kind in ('integration','service','setup','other')),
  description text not null,
  amount_usd numeric not null check (amount_usd >= 0),
  recurring boolean not null default false,
  starts_on date not null default current_date,
  ends_on date,
  created_by text not null default 'owner',
  created_at timestamptz not null default now()
);
alter table os.charges enable row level security;
grant select on os.charges to authenticated;
create policy member_read on os.charges for select to authenticated using (os.member_role(business_id) is not null);
grant all on os.charges to service_role;
grant all on all sequences in schema os to service_role;

-- One month's bill: AI team usage (with markup), platform fee, other charges. our_cost_usd is shown only to the platform owner.
create or replace function os.month_bill(bid uuid, month date default date_trunc('month', now())::date)
returns table (line text, kind text, amount_usd numeric, our_cost_usd numeric)
language sql stable security definer set search_path = os as $$
  select 'AI team (your six agents)', 'ai_usage', coalesce(sum(billed_usd), 0), coalesce(sum(cost_usd), 0)
    from os.usage_events where business_id = bid and at >= month and at < month + interval '1 month'
  union all
  select 'Platform fee', 'platform_fee', platform_fee_usd, 0 from os.businesses where id = bid and platform_fee_usd > 0
  union all
  select description, kind, amount_usd, null from os.charges
    where business_id = bid and (
      (recurring and starts_on < month + interval '1 month' and (ends_on is null or ends_on >= month))
      or (not recurring and starts_on >= month and starts_on < month + interval '1 month'))
$$;
revoke all on function os.month_bill(uuid, date) from public;
grant execute on function os.month_bill(uuid, date) to service_role;
