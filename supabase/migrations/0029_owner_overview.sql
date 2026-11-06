-- The platform owner's view across every business: money, usage, progress and setup, as counts only (never the
-- businesses' actual messages or records). And a monthly "how to improve Destiny OS" report written from the
-- same numbers, emailed on the 1st and kept here.

create or replace function os.platform_overview(m date default date_trunc('month', now())::date) returns jsonb
language sql stable security definer set search_path = os as $$
  select coalesce(jsonb_agg(x order by (x->>'internal')::boolean, x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', b.id, 'name', b.name, 'slug', b.slug, 'status', b.status, 'plan', b.plan, 'internal', b.plan = 'internal',
      'created_at', b.created_at, 'trial_ends_at', b.trial_ends_at, 'trial_converted', b.trial_converted,
      'billing_status', b.billing_status, 'fee', b.platform_fee_usd, 'markup', b.markup_pct, 'budget', b.monthly_budget_usd, 'model', b.model,
      'revenue', (select coalesce(sum(amount_usd), 0) from os.month_bill(b.id, m)),
      'cost', (select coalesce(sum(our_cost_usd), 0) from os.month_bill(b.id, m)),
      'ai_cost', (select coalesce(sum(cost_usd), 0) from os.usage_events where business_id = b.id and at >= m and at < m + interval '1 month'),
      'last_work', (select max(at) from os.usage_events where business_id = b.id),
      'owner_seen', (select max(s.created_at) from os.sessions s join os.business_members bm on bm.user_id = s.user_id
                      where bm.business_id = b.id and bm.role in ('owner', 'admin')
                        and not exists (select 1 from os.platform_admins pa where pa.user_id = s.user_id)),
      'members', (select count(*) from os.business_members where business_id = b.id),
      'records', (select count(*) from os.records where business_id = b.id and created_at >= m and created_at < m + interval '1 month'),
      'jobs', (select count(*) from os.wins where business_id = b.id and kind = 'job' and at >= m and at < m + interval '1 month'),
      'jobs_usd', (select coalesce(sum(value_usd), 0) from os.wins where business_id = b.id and kind = 'job' and at >= m and at < m + interval '1 month'),
      'quotes', (select count(*) from os.wins where business_id = b.id and kind = 'estimate' and at >= m and at < m + interval '1 month'),
      'replies', (select count(*) from os.wins where business_id = b.id and kind = 'reply' and at >= m and at < m + interval '1 month'),
      'inquiries', (select count(*) from os.records where business_id = b.id and type = 'inquiry' and created_at >= m and created_at < m + interval '1 month'),
      'sent', (select count(*) from os.approvals where business_id = b.id and status = 'done' and decided_at >= m and decided_at < m + interval '1 month'),
      'rejected', (select count(*) from os.approvals where business_id = b.id and status = 'rejected' and decided_by not in ('system') and decided_at >= m and decided_at < m + interval '1 month'),
      'posts', (select count(*) from os.content where business_id = b.id and status = 'published' and published_at >= m and published_at < m + interval '1 month'),
      'waiting', (select count(*) from os.approvals where business_id = b.id and status = 'pending') + (select count(*) from os.content where business_id = b.id and status = 'pending'),
      'errors', (select count(*) from os.messages where business_id = b.id and status = 'error' and created_at >= m and created_at < m + interval '1 month'),
      'calls', (select count(*) from os.calls where business_id = b.id and started_at >= m and started_at < m + interval '1 month'),
      'customers', (select count(*) from os.records where business_id = b.id and type = 'customer'),
      'email_on', exists (select 1 from os.integrations where business_id = b.id and provider in ('gmail', 'resend') and status = 'connected'),
      'fb_on', exists (select 1 from os.integrations where business_id = b.id and provider = 'facebook' and status = 'connected'),
      'phone_on', exists (select 1 from os.integrations where business_id = b.id and provider = 'phone' and status = 'connected')
    ) x from os.businesses b where b.status <> 'archived'
  ) t
$$;
revoke all on function os.platform_overview(date) from public;

-- Everything the monthly report reasons from, for one month: per business and for the platform.
create or replace function os.platform_metrics(m date) returns jsonb
language sql stable security definer set search_path = os as $$
  select jsonb_build_object(
    'month', to_char(m, 'YYYY-MM'),
    'businesses', os.platform_overview(m),
    'trials_started', (select count(*) from os.businesses where trial_ends_at is not null and created_at >= m and created_at < m + interval '1 month'),
    'trials_converted', (select count(*) from os.businesses where trial_converted and trial_ends_at >= m and trial_ends_at < m + interval '1 month'),
    'trials_ended_unconverted', (select count(*) from os.businesses where not trial_converted and trial_ends_at >= m and trial_ends_at < m + interval '1 month'),
    'archived', (select count(*) from os.businesses where status = 'archived'),
    'cost_by_teammate', (select coalesce(jsonb_agg(jsonb_build_object('slot', slot, 'model', model, 'calls', n, 'cost_usd', round(c, 2))), '[]'::jsonb) from (
       select slot, model, count(*) n, sum(cost_usd) c from os.usage_events where at >= m and at < m + interval '1 month' group by slot, model order by 4 desc) s),
    'prompt_cache_share', (select round(100.0 * sum(cache_read_tokens) / nullif(sum(input_tokens), 0)) from os.usage_events where at >= m and at < m + interval '1 month'),
    'alerts_by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from os.alerts where created_at >= m and created_at < m + interval '1 month' group by kind) a),
    'push_devices', (select count(*) from os.push_subs),
    'ai_outage_now', os.ai_down(),
    'prices', (select jsonb_agg(jsonb_build_object('model', model, 'in', input_per_mtok, 'out', output_per_mtok)) from os.model_prices),
    'call_rates', (select to_jsonb(r) from os.call_rates r where id = 1)
  )
$$;
revoke all on function os.platform_metrics(date) from public;

create table if not exists os.platform_reports (
  id bigserial primary key,
  month date not null unique,
  body text not null,
  metrics jsonb,
  cost_usd numeric,
  created_at timestamptz not null default now()
);
alter table os.platform_reports enable row level security;

-- On the 1st, os-growth writes last month's report (it checks the invoke key).
select cron.schedule('os-monthly-report', '41 14 1 * *', $c$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-growth',
    headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY'), 'content-type', 'application/json'),
    body := '{"action":"monthly_report"}'::jsonb, timeout_milliseconds := 120000)
$c$) where not exists (select 1 from cron.job where jobname = 'os-monthly-report');
