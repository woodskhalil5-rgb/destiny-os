-- Every morning at 7:30 (New York) the Destiny OS site report goes to DeMarcus on the Destiny Marketing Group board
-- (on its working days; Monday's covers the weekend) and a copy is emailed to the owner. DeMarcus reads it, has the
-- team act on what it can, and tells the owner only what needs him. He can't change the site or the app.
-- The team's shift moves to 7:00-16:00 so the report arrives on shift (same 9-hour day).

update os.businesses set shift_start = 7, shift_end = 16 where slug = 'destiny-os';

create or replace function os.site_report(force boolean default false) returns integer language plpgsql security definer set search_path = os as $$
declare dos os.businesses; localnow timestamp; since timestamptz; today date;
  attention text; last24 text; ran text; calls text; body text; v text; n int; cap numeric;
begin
  select * into dos from os.businesses where slug = 'destiny-os' and status = 'live';
  if dos.id is null then return 0; end if;
  localnow := now() at time zone dos.timezone; today := localnow::date;
  if not force then
    if extract(hour from localnow)::int <> 7 or not (extract(isodow from today)::int = any(dos.shift_days)) then return 0; end if;
    if exists (select 1 from os.alerts where dedupe_key = 'site_report:' || today) then return 0; end if;
  end if;
  -- Covers everything since the last report (so Monday's covers the weekend), at most 4 days.
  since := greatest(coalesce((select max(created_at) from os.alerts where kind = 'site_report'), now() - interval '24 hours'), now() - interval '4 days');

  -- What needs attention
  attention := '';
  if exists (select 1 from os.platform_state where key = 'ai_down') then
    attention := attention || E'\n• AI is down for every team (usually the Anthropic credit). Owner must top it up.';
  end if;
  select string_agg(r.title || coalesce(' (' || (r.data->>'business') || ')', '') || ', since ' || to_char(r.created_at at time zone dos.timezone, 'Mon DD HH12:MIam'), '; ' order by r.created_at), count(*)
    into v, n from os.records r where r.business_id = dos.id and r.type = 'inquiry' and r.status = 'new';
  if n > 0 then attention := attention || E'\n• ' || n || ' website message' || case when n = 1 then '' else 's' end || ' not answered yet: ' || v; end if;
  select string_agg(b.name || ' (' || coalesce(b.billing_status, '?') || ', signed up ' || to_char(b.created_at at time zone dos.timezone, 'Mon DD') || ')', '; '), count(*)
    into v, n from os.businesses b where b.plan = 'customer' and b.status = 'setup' and b.name not ilike 'test%'
      and b.created_at < now() - interval '2 days';
  if n > 0 then attention := attention || E'\n• ' || n || ' sign-up' || case when n = 1 then '' else 's' end || ' still not paid and started after 2+ days: ' || v; end if;
  select string_agg(b.name || ' (' || b.billing_status || ')', '; '), count(*) into v, n
    from os.businesses b where b.billing_status in ('past_due', 'unpaid', 'payment_failed') and b.status <> 'archived';
  if n > 0 then attention := attention || E'\n• Billing problem: ' || v; end if;
  select string_agg(distinct b.name, ', '), count(distinct b.id) into v, n from os.businesses b
    where b.status <> 'archived' and (select coalesce(sum(u.billed_usd), 0) from os.usage_events u where u.business_id = b.id and u.at > now() - interval '24 hours')
      >= coalesce(b.daily_budget_usd, b.monthly_budget_usd / 20.0, 1e9);
  if n > 0 then attention := attention || E'\n• Hit the daily AI limit: ' || v; end if;
  select string_agg(a.subject, '; ' order by a.created_at), count(*) into v, n from os.alerts a
    where a.created_at > since and a.audience = 'platform' and a.kind in ('setup_failed', 'agent_error', 'inbox_error', 'spend_spike');
  if n > 0 then attention := attention || E'\n• Problems reported: ' || v; end if;
  select count(*) into n from cron.job_run_details d join cron.job j using (jobid) where d.start_time > since and d.status <> 'succeeded' and j.jobname like 'os-%';
  if n > 0 then attention := attention || E'\n• ' || n || ' background job runs failed.'; end if;
  if attention = '' then attention := E'\n• Nothing. All clear.'; end if;

  -- Since the last report
  last24 := '';
  select count(*), string_agg(c.name || ' (' || c.business || ')', '; ') into n, v from os.contact_requests c where c.created_at > since;
  last24 := last24 || E'\n• "Talk to us" messages: ' || n || coalesce(': ' || v, '');
  select count(*), string_agg(b.name, '; ') into n, v from os.businesses b where b.created_at > since and b.plan = 'customer' and b.name not ilike 'test%';
  last24 := last24 || E'\n• New sign-ups: ' || n || coalesce(': ' || v, '');
  select count(*) into n from os.stripe_events e where e.received_at > since and e.type in ('checkout.session.completed', 'invoice.paid');
  last24 := last24 || E'\n• Payments received (Stripe): ' || n;
  select count(*) into n from os.records r join os.businesses b on b.id = r.business_id
    where r.type = 'inquiry' and r.created_at > since and b.slug <> 'destiny-os' and b.name not ilike 'test%';
  last24 := last24 || E'\n• Customer inquiries across all businesses: ' || n;
  select count(*) into n from os.approvals a where a.kind = 'email' and a.status = 'done' and a.decided_at > since;
  last24 := last24 || E'\n• Emails approved and sent across all businesses: ' || n;
  select count(*) into n from os.records r where r.business_id = dos.id and r.type = 'lead' and r.created_at > since and r.status <> 'signed up';
  last24 := last24 || E'\n• New sales leads found by James: ' || n;
  select coalesce(sum(u.billed_usd), 0) into cap from os.usage_events u where u.at > since;
  last24 := last24 || E'\n• AI spend, all businesses: $' || to_char(cap, 'FM999,990.00');

  -- What ran by itself
  select string_agg(x.jobname || ' ' || x.ok || '/' || x.total, ', ' order by x.jobname) into ran from (
    select j.jobname, count(*) filter (where d.status = 'succeeded') ok, count(*) total
    from cron.job_run_details d join cron.job j using (jobid)
    where d.start_time > since and j.jobname like 'os-%' group by j.jobname) x;
  ran := E'\n• ' || coalesce(ran, 'no scheduled jobs ran') || ' (succeeded/runs)';

  -- Call list
  select string_agg('• ' || r.title || coalesce(' · ' || nullif(r.data->>'phone', ''), '') || coalesce(' (' || nullif(r.data->>'business', '') || ')', '')
      || ': ' || coalesce(r.next_step, 'call'), E'\n' order by r.next_step_due nulls last), count(*)
    into calls, n from os.records r
    where r.business_id = dos.id and r.status not in ('lost', 'handled', 'done', 'paid', 'started')
      and coalesce(r.data->>'phone', '') <> ''
      and (r.next_step ilike '%call%' or (r.type = 'inquiry' and r.status = 'new' and coalesce(r.data->>'email', '') = ''));
  calls := coalesce(E'\n' || calls, E'\n• No calls to make.');

  body := 'Morning DeMarcus. Here''s the Destiny OS site report for ' || to_char(today, 'Dy Mon DD') || E'.\n\n'
    || 'NEEDS ATTENTION' || attention || E'\n\nSINCE THE LAST REPORT' || last24 || E'\n\nWHAT RAN BY ITSELF' || ran
    || E'\n\nCALL LIST' || calls || E'\n\n'
    || 'Read it, have the team act on what it can handle (website messages, sign-ups, leads, follow-ups), and tell Khalil only what needs him. '
    || 'You can''t change the site or the app: anything broken goes to Khalil for Sean.';

  insert into os.messages (business_id, sender, body) values (dos.id, 'system', body);
  perform os.alert(dos.id, 'platform', 'site_report', 'Destiny OS site report: ' || to_char(today, 'Dy Mon DD'), body, 'site_report:' || today);
  return 1;
end $$;
revoke all on function os.site_report(boolean) from public;

select cron.unschedule('os-site-report') where exists (select 1 from cron.job where jobname = 'os-site-report');
select cron.schedule('os-site-report', '30 * * * *', 'select os.site_report()');
