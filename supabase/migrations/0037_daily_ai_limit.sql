-- A daily AI limit per business, so one busy day can't burn through the month.
-- Unset means the default: the monthly limit spread over 20 work days (e.g. $100/month -> $5/day). No monthly limit, no daily one.
alter table os.businesses add column if not exists daily_budget_usd numeric;
comment on column os.businesses.daily_budget_usd is 'AI spend allowed per day (business time zone). Null = monthly_budget_usd / 20.';
