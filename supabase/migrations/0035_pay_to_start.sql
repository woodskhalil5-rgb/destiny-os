-- No more free trial. A business that signs up itself pays its first month (the platform fee, through Stripe Checkout,
-- which also saves the card) before its team can start. That payment covers 30 days of platform fee; after that the
-- usual invoice on the 1st bills the fee (prorated for the rest of that month) plus AI usage. Businesses the platform
-- owner adds by hand are unaffected (pay_to_start stays false).

alter table os.businesses add column if not exists pay_to_start boolean not null default false;
alter table os.businesses add column if not exists fee_paid_until timestamptz;

-- The team can't be started until the first month is paid.
create or replace function os.require_first_payment() returns trigger language plpgsql as $$
begin
  if new.status = 'live' and old.status is distinct from 'live' and new.pay_to_start
     and new.fee_paid_until is null and new.billing_status <> 'active' then
    raise exception 'Pay your first month to start your team. It''s on the Money tab.';
  end if;
  return new;
end $$;
create or replace trigger require_first_payment before update of status on os.businesses for each row execute function os.require_first_payment();

-- The platform fee starts after the free trial (old trials) or after the prepaid first 30 days, whichever is later.
create or replace function os.month_bill(bid uuid, month date default date_trunc('month', now())::date)
returns table(line text, kind text, amount_usd numeric, our_cost_usd numeric) language sql stable security definer set search_path = os as $$
  with t as (select trial_ends_at as te, fee_paid_until as fp,
      nullif(greatest(coalesce(trial_ends_at, '-infinity'::timestamptz), coalesce(fee_paid_until, '-infinity'::timestamptz)), '-infinity'::timestamptz) as fs
    from os.businesses where id = bid)
  select 'AI team (your six agents)', 'ai_usage', coalesce(sum(u.billed_usd), 0), coalesce(sum(u.cost_usd), 0)
    from os.usage_events u, t where u.business_id = bid and u.at >= month and u.at < month + interval '1 month' and (t.te is null or u.at >= t.te)
  union all
  select case when t.fp > month and t.fp = t.fs then 'Platform fee (after your first paid 30 days)'
              when t.fs > month then 'Platform fee (from the end of your free trial)' else 'Platform fee' end, 'platform_fee',
         round(b.platform_fee_usd * case when t.fs is null or t.fs <= month then 1
                                         when t.fs >= month + interval '1 month' then 0
                                         else extract(epoch from (month + interval '1 month' - t.fs)) / extract(epoch from (month + interval '1 month' - month::timestamptz)) end, 2), 0
    from os.businesses b, t where b.id = bid and b.platform_fee_usd > 0 and (t.fs is null or t.fs < month + interval '1 month')
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

-- Getting-started nudges, for new paid sign-ups (and any trials still running).
create or replace function os.trial_nudges() returns integer language plpgsql security definer set search_path = os as $function$
declare b record; n int := 0; app text; todo text; mail boolean; fb boolean; cust int; rl text; quotes int; started timestamptz; unpaid boolean;
begin
  app := coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'OS_APP_URL'), '');
  for b in select * from os.businesses where status <> 'archived' and (
      (trial_ends_at > now() and not trial_converted)
      or (pay_to_start and trial_ends_at is null and created_at > now() - interval '8 days')) loop
    started := coalesce(b.trial_ends_at - interval '14 days', b.created_at);
    unpaid := b.pay_to_start and b.fee_paid_until is null and b.billing_status <> 'active';
    if b.status = 'setup' and now() between started + interval '20 hours' and started + interval '3 days' then
      perform os.alert(b.id, 'business', 'start_nudge', 'Your team is ready to start',
        'Your Destiny OS team for ' || b.name || E' is set up and waiting. Nothing runs until you say so.\n\n'
        || case when unpaid then E'Open your dashboard, pay your first month on the Money tab, then tap Start team. They begin on their next work hour, and nothing goes out without your OK.\n\n'
                else E'Open your dashboard and tap Start team. They begin on their next work hour, and nothing goes out without your OK.\n\n' end
        || app || '/app', 'nudge1:' || b.id);
      n := n + 1;
    end if;
    if not unpaid and now() between started + interval '3 days' and started + interval '5 days' then
      select exists (select 1 from os.integrations where business_id = b.id and provider in ('gmail', 'resend') and status = 'connected') into mail;
      select exists (select 1 from os.integrations where business_id = b.id and provider = 'facebook' and status = 'connected') into fb;
      select count(*)::int into cust from os.records where business_id = b.id and type = 'customer';
      select count(*)::int into quotes from os.records where business_id = b.id and type = 'quote';
      select review_link into rl from os.growth_settings where business_id = b.id;
      todo := concat_ws(E'\n',
        case when b.status = 'setup' then '• Start your team (Home, Start team). Nothing happens until you do.' end,
        case when not mail then '• Connect your email (Connections). Without it, the team can draft emails but can''t send them.' end,
        case when not fb then '• Connect your Facebook Page (Connections), so approved posts publish on their own.' end,
        case when cust = 0 then '• Add your past customers (Customers). They''re your cheapest work, and the team can send them seasonal reminders.' end,
        case when quotes = 0 then '• Log a quote you sent (Customers). The team follows up on day 2, 5 and 10 so it doesn''t go quiet.' end,
        case when coalesce(rl, '') = '' then '• Add your Google review link (Customers), so happy customers get asked for a review.' end,
        '• Put your inquiry form link on your website and Facebook (Customers). New inquiries reach you right away.');
      perform os.alert(b.id, 'business', 'start_nudge', 'A few steps to get more from your team',
        'You''re a few days in with Destiny OS at ' || b.name || E'. These steps make the biggest difference:\n\n' || todo
        || E'\n\nEach takes a couple of minutes: ' || app || '/app', 'nudge3:' || b.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $function$;
