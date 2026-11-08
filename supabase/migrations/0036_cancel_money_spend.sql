-- 1) Self-serve cancel: the owner cancels on the Money tab; the team keeps working until the end of what's paid
--    (the prepaid first 30 days, or the end of the current month), then pauses. The platform fee stops that day.
-- 2) Money in the owner's morning message and weekly recap: what's owed and what's overdue (Nora's invoices).
-- 3) A daily check on the platform's AI spend: the owner hears when a day costs far more than usual, before credit runs out.

alter table os.businesses add column if not exists cancel_at timestamptz;

-- A cancelled plan can't be started again from the dashboard (the owner contacts us, or keeps the plan before it ends).
create or replace function os.require_first_payment() returns trigger language plpgsql as $$
begin
  if new.status = 'live' and old.status is distinct from 'live' and new.pay_to_start and new.fee_paid_until is null then
    raise exception 'Pay your first month to start your team. It''s on the Money tab.';
  end if;
  if new.status = 'live' and old.status is distinct from 'live' and new.cancel_at is not null and new.cancel_at <= now() then
    raise exception 'Your plan was cancelled. Email us to restart it.';
  end if;
  return new;
end $$;

-- The platform fee covers only the part of the month between the start of billing and the cancel date.
create or replace function os.month_bill(bid uuid, month date default date_trunc('month', now())::date)
returns table(line text, kind text, amount_usd numeric, our_cost_usd numeric) language sql stable security definer set search_path = os as $$
  with t as (select trial_ends_at as te, fee_paid_until as fp, cancel_at as ca,
      nullif(greatest(coalesce(trial_ends_at, '-infinity'::timestamptz), coalesce(fee_paid_until, '-infinity'::timestamptz)), '-infinity'::timestamptz) as fs
    from os.businesses where id = bid),
  f as (select t.*, greatest(month::timestamptz, coalesce(t.fs, '-infinity')) as s, least((month + interval '1 month')::timestamptz, coalesce(t.ca, 'infinity')) as e from t)
  select 'AI team (your six agents)', 'ai_usage', coalesce(sum(u.billed_usd), 0), coalesce(sum(u.cost_usd), 0)
    from os.usage_events u, t where u.business_id = bid and u.at >= month and u.at < month + interval '1 month' and (t.te is null or u.at >= t.te)
  union all
  select case when f.ca is not null and f.ca < month + interval '1 month' then 'Platform fee (until your plan ended)'
              when f.fp > month and f.fp = f.fs then 'Platform fee (after your first paid 30 days)'
              when f.fs > month then 'Platform fee (from the end of your free trial)' else 'Platform fee' end, 'platform_fee',
         round(b.platform_fee_usd * extract(epoch from (f.e - f.s)) / extract(epoch from (month + interval '1 month' - month::timestamptz)), 2), 0
    from os.businesses b, f where b.id = bid and b.platform_fee_usd > 0 and f.e > f.s
      and not (b.pay_to_start and b.fee_paid_until is null)   -- nothing to bill until the first month is paid
  union all
  select 'Phone calls (' || coalesce(sum(minutes), 0) || ' min)', 'calls', coalesce(sum(billed_usd), 0), coalesce(sum(cost_usd), 0)
    from os.calls where business_id = bid and started_at >= month and started_at < month + interval '1 month'
    having count(*) > 0
  union all
  select 'Business phone number', 'phone_number', b.phone_fee_usd, r.number_per_month
    from os.businesses b cross join os.call_rates r
    where b.id = bid and exists (select 1 from os.integrations i where i.business_id = bid and i.provider = 'phone' and i.status = 'connected')
      and (b.cancel_at is null or b.cancel_at > month)
  union all
  select description, kind, amount_usd, null from os.charges
    where business_id = bid and (
      (recurring and starts_on < month + interval '1 month' and (ends_on is null or ends_on >= month))
      or (not recurring and starts_on >= month and starts_on < month + interval '1 month'))
$$;

-- Plans whose cancel date has come: the team pauses. Runs hourly.
create or replace function os.apply_cancellations() returns int language plpgsql security definer set search_path = os as $$
declare b record; n int := 0;
begin
  for b in select * from os.businesses where cancel_at is not null and cancel_at <= now() and status in ('live', 'setup') loop
    update os.businesses set status = 'paused' where id = b.id;
    insert into os.messages (business_id, sender, body, status) values (b.id, 'system',
      'Your plan has ended, so the team is paused. Everything it did is saved. Your last invoice comes on the 1st. Email us any time to restart.', 'handled');
    perform os.alert(b.id, 'platform', 'plan_ended', b.name || ': plan ended', b.name || ' cancelled and their plan has now ended. The team is paused.', 'ended:' || b.id || ':' || b.cancel_at::date);
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('os-cancellations', '17 * * * *', 'select os.apply_cancellations()') where not exists (select 1 from cron.job where jobname = 'os-cancellations');

-- Money lines for the owner (shared by the morning message and the weekly recap). Amounts in the business's own currency.
create or replace function os.money_line(bid uuid) returns text language sql stable security definer set search_path = os as $$
  with i as (select os.num(data->>'amount') as amt,
      case when coalesce(data->>'due_on', '') ~ '^\d{4}-\d{2}-\d{2}$' then (data->>'due_on')::date end as due
    from os.records where business_id = bid and type = 'invoice' and status in ('unpaid', 'reminded'))
  select case when count(*) = 0 then null else
    to_char(coalesce(sum(amt), 0), 'FM999,999,990') || ' owed to you on ' || count(*) || ' unpaid invoice' || case when count(*) = 1 then '' else 's' end
    || case when count(*) filter (where due < current_date) > 0
         then ' (' || count(*) filter (where due < current_date) || ' overdue: ' || to_char(coalesce(sum(amt) filter (where due < current_date), 0), 'FM999,999,990') || ')' else '' end
  end from i
$$;

create or replace function os.morning_digest() returns int language plpgsql security definer set search_path = os as $$
declare b record; n int := 0; app text; waiting int; inq int; due int; calls int; overdue int; money text; lines text; total int; localday date; wd int; hr int;
begin
  app := coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'OS_APP_URL'), '');
  for b in select bz.* from os.businesses bz left join os.growth_settings gs on gs.business_id = bz.id
      where bz.status in ('live', 'paused', 'setup') and coalesce(gs.morning_message, true) loop
    localday := (now() at time zone b.timezone)::date;
    hr := extract(hour from now() at time zone b.timezone)::int;
    wd := extract(isodow from now() at time zone b.timezone)::int;
    continue when hr <> b.shift_start or not (wd = any(b.shift_days));
    select (select count(*) from os.approvals where business_id = b.id and status = 'pending')
         + (select count(*) from os.content where business_id = b.id and status in ('pending', 'needs_manual')) into waiting;
    select count(*)::int into inq from os.records where business_id = b.id and type = 'inquiry' and status = 'new';
    select count(*)::int into due from os.records where business_id = b.id and next_step_due <= localday and type <> 'invoice'
      and status not in ('won', 'lost', 'signed', 'no answer', 'handled', 'done', 'rejected', 'passed')
      and (next_step ilike '%call%' or next_step ilike '%meeting%' or next_step ilike '%answer%');
    select case when b.timezone like 'Africa/%' then (select count(*)::int from os.records where business_id = b.id and status = 'call planned') else 0 end into calls;
    select count(*)::int into overdue from os.records where business_id = b.id and type = 'invoice' and status in ('unpaid', 'reminded')
      and coalesce(data->>'due_on', '') ~ '^\d{4}-\d{2}-\d{2}$' and (data->>'due_on')::date < localday;
    money := os.money_line(b.id);
    total := waiting + inq + due + calls + overdue;
    continue when total = 0;
    lines := concat_ws(E'\n',
      case when waiting > 0 then '• ' || waiting || case when waiting = 1 then ' thing is' else ' things are' end || ' waiting for your OK' end,
      case when inq > 0 then '• ' || inq || ' new inquir' || case when inq = 1 then 'y' else 'ies' end || ' to answer' end,
      case when due > 0 then '• ' || due || ' callback' || case when due = 1 then '' else 's' end || ' or meeting' || case when due = 1 then '' else 's' end || ' due today' end,
      case when calls > 0 then '• ' || calls || ' compan' || case when calls = 1 then 'y' else 'ies' end || ' ready on the call sheet' end,
      case when overdue > 0 and money is not null then '• Money: ' || money end);
    perform os.alert(b.id, 'business', 'morning',
      'Good morning: ' || b.name || ' · ' || total || case when total = 1 then ' thing needs you' else ' things need you' end,
      'Here''s what needs you today at ' || b.name || E':\n\n' || lines || E'\n\nOpen your dashboard: ' || app || '/app'
        || E'\n\n(To stop these, turn off "Morning message" on the Customers screen.)',
      'morning:' || b.id || ':' || localday);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function os.weekly_recap() returns integer language plpgsql security definer set search_path = os as $function$
declare b record; n int := 0; w record; app text; txt text; idea text; waiting int; openq int; inq int; sent int; posts int; spend numeric; wk text; stats text; money text;
begin
  app := coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'OS_APP_URL'), '');
  wk := to_char(now(), 'IYYY-IW');
  for b in select bz.* from os.businesses bz
      left join os.growth_settings gs on gs.business_id = bz.id
      where bz.status in ('live', 'paused', 'setup') and coalesce(gs.weekly_recap, true)
        and bz.created_at < now() - interval '3 days' loop
    select count(*) filter (where kind = 'job')::int as jobs, coalesce(sum(value_usd) filter (where kind = 'job'), 0) as job_usd,
           count(*) filter (where kind = 'estimate')::int as est, count(*) filter (where kind = 'reply')::int as replies,
           count(*) filter (where kind = 'review_ask')::int as reviews, count(*) filter (where kind = 'repeat')::int as repeats
      into w from os.wins where business_id = b.id and at > now() - interval '7 days';
    select count(*)::int into inq from os.records where business_id = b.id and type = 'inquiry' and created_at > now() - interval '7 days';
    select count(*)::int into sent from os.approvals where business_id = b.id and status = 'done' and kind in ('email', 'campaign') and decided_at > now() - interval '7 days';
    select count(*)::int into posts from os.content where business_id = b.id and status = 'published' and published_at > now() - interval '7 days';
    select (select count(*) from os.approvals where business_id = b.id and status = 'pending')
         + (select count(*) from os.content where business_id = b.id and status = 'pending') into waiting;
    select count(*)::int into openq from os.records where business_id = b.id and type = 'quote' and status in ('sent', 'following up');
    select coalesce(sum(billed_usd), 0) into spend from os.usage_events where business_id = b.id and at >= date_trunc('month', now())
      and (b.trial_ends_at is null or at >= b.trial_ends_at);
    select p.idea into idea from os.playbook_for(b.id) p;
    money := os.money_line(b.id);

    stats := concat_ws(E'\n',
      case when w.jobs > 0 then 'Jobs won: ' || w.jobs || case when w.job_usd > 0 then ' (' || to_char(w.job_usd, 'FM999,999,990') || ')' else '' end end,
      case when w.est > 0 then 'Quotes logged: ' || w.est end,
      case when inq > 0 then 'New inquiries: ' || inq end,
      case when w.replies > 0 then 'Replies from leads: ' || w.replies end,
      case when sent > 0 then 'Emails sent for you: ' || sent end,
      case when posts > 0 then 'Posts published: ' || posts end,
      case when w.reviews > 0 then 'Review requests: ' || w.reviews end,
      case when w.repeats > 0 then 'Repeat jobs: ' || w.repeats end);
    txt := 'Here''s your week at ' || b.name || E'.\n\n'
      || coalesce(nullif(stats, ''), 'A quiet week: nothing came in or went out.') || E'\n'
      || E'\n'
      || case when waiting > 0 then waiting || case when waiting = 1 then ' thing is' else ' things are' end || E' waiting for your OK.\n' else E'Nothing is waiting for your OK.\n' end
      || case when openq > 0 then openq || ' open quote' || case when openq = 1 then ' is' else 's are' end || E' being followed up.\n' else E'No open quotes. Log the estimates you send and the team follows up on each one.\n' end
      || case when money is not null then 'Money: ' || money || E'. Nora drafts the reminders for your OK.\n' else '' end
      || case when b.status = 'setup' and b.pay_to_start and b.fee_paid_until is null then E'Your team hasn''t started yet. Pay your first month on the Money tab and it starts right away.\n'
              when b.status = 'setup' then E'Your team hasn''t been started yet. Open your dashboard and tap Start team.\n'
              when b.status = 'paused' then E'Your team is paused.\n' else '' end
      || case when idea is not null then E'\nIdea for this month: ' || idea || E'. Open Customers in your dashboard and tap "Have Kole write it".\n' else '' end
      || case when spend > 0 then E'\nAI work so far this month: $' || to_char(spend, 'FM999,990.00') || E'.\n' else '' end
      || E'\nYour dashboard: ' || app || '/app'
      || E'\n\n(To stop these Monday emails, turn off "Weekly recap" on the Customers screen.)';
    perform os.alert(b.id, 'business', 'weekly', 'Your week: ' || b.name
      || case when w.jobs > 0 then ' · ' || w.jobs || ' job' || case when w.jobs = 1 then '' else 's' end || ' won' when inq > 0 then ' · ' || inq || ' new inquir' || case when inq = 1 then 'y' else 'ies' end else '' end,
      txt, 'week:' || b.id || ':' || wk);
    n := n + 1;
  end loop;
  return n;
end $function$;

-- The platform's AI spend, checked every morning: a day far above the week before gets the owner's attention,
-- so credit can be topped up before it runs out (the AI account's balance itself can't be read from here).
create or replace function os.spend_watch() returns text language plpgsql security definer set search_path = os as $$
declare y numeric; avg7 numeric; top text; d date := (now() at time zone 'America/New_York')::date - 1;
begin
  select coalesce(sum(cost_usd), 0) into y from os.usage_events where (at at time zone 'America/New_York')::date = d;
  select coalesce(sum(cost_usd), 0) / 7 into avg7 from os.usage_events where (at at time zone 'America/New_York')::date between d - 7 and d - 1;
  if y >= 10 and y >= 2 * greatest(avg7, 1) then
    select string_agg(name || ' $' || to_char(c, 'FM990.00'), ', ' order by c desc) into top from (
      select b.name, sum(u.cost_usd) c from os.usage_events u join os.businesses b on b.id = u.business_id
      where (u.at at time zone 'America/New_York')::date = d group by b.name order by 2 desc limit 3) x;
    perform os.alert(null, 'platform', 'spend_spike', 'Destiny OS: AI spend jumped yesterday ($' || to_char(y, 'FM9,990.00') || ')',
      'Yesterday the teams used $' || to_char(y, 'FM9,990.00') || ' of AI, against about $' || to_char(avg7, 'FM9,990.00') || ' a day the week before.'
      || E'\n\nBiggest: ' || coalesce(top, '-') || E'.\n\nIf your Anthropic credit is low, top it up (or turn on auto-reload) so the teams don''t stop. Each business''s monthly limit is in Settings.',
      'spend:' || d);
    return 'alerted';
  end if;
  return 'ok';
end $$;
select cron.schedule('os-spend-watch', '9 12 * * *', 'select os.spend_watch()') where not exists (select 1 from cron.job where jobname = 'os-spend-watch');
