-- More automation (owner's choice, Nov 10):
-- 1. Routine emails send themselves: once the owner has approved 5 quote follow-ups (or 5 review requests) for a
--    business, new ones of that kind are approved automatically and sent by os-routine-send. New-prospect outreach
--    and anything else still waits for the owner. Off switch: business_config.config.auto_send.routine = 'off'.
-- 2. Weekly money statement: Fridays, one hour before the shift ends, DeMarcus emails the rep and the owner the week's
--    logged payments, the rep's commission and the share due to DMG.
-- 3. Call sheet auto-refill: hourly on shift, if a rep has fewer than 10 roofers to call, the team is told to find and
--    plan more (at most every 6 hours).
-- 4. Allowance reminder: on the 1st, the owner gets one email per rep with the allowance to send.

-- Rep pay terms (from the rep agreement), used by 2 and 4.
update os.business_config set config = config || jsonb_build_object('rep_pay',
    jsonb_build_object('level', 'Sales Representative', 'commission_pct', 20, 'allowance_ngn', 15000, 'remit_by', 'Wednesday'))
  where active and business_id = (select id from os.businesses where slug = 'dmg-nigeria') and not config ? 'rep_pay';

-- 1. Routine emails
create or replace function os.routine_kind(summary text) returns text language sql immutable as $$
  select case when summary like 'Follow-up _ of 3 on the estimate for %' then 'quote_followup'
              when summary like 'Review request to %' then 'review_ask' end;
$$;

create or replace function os.auto_approve_routine() returns trigger language plpgsql security definer set search_path = os as $$
declare rk text; owner_ok int; today int; lim int;
begin
  if new.kind <> 'email' or new.status <> 'pending' or new.requested_by <> 'production' then return new; end if;
  rk := os.routine_kind(new.summary);
  if rk is null then return new; end if;
  if exists (select 1 from os.business_config c where c.business_id = new.business_id and c.active and c.config->'auto_send'->>'routine' = 'off') then return new; end if;
  if not exists (select 1 from os.businesses where id = new.business_id and status = 'live') then return new; end if;
  select count(*) into owner_ok from os.approvals a where a.business_id = new.business_id and os.routine_kind(a.summary) = rk
    and a.status in ('approved', 'done') and (a.decided_by like 'user:%' or a.decided_by like 'owner:%');
  if owner_ok < 5 then return new; end if;
  select coalesce((c.config->'approvals'->'email'->>'daily_limit')::int, 15) into lim from os.business_config c where c.business_id = new.business_id and c.active;
  select count(*) into today from os.approvals a where a.business_id = new.business_id and a.decided_by like 'auto:routine%' and a.decided_at > now() - interval '24 hours';
  if today >= coalesce(lim, 15) then return new; end if;
  new.status := 'approved'; new.decided_by := 'auto:routine'; new.decided_at := now();
  new.note := 'Sent automatically: you had approved ' || owner_ok || ' of these before.';
  return new;
end $$;
create or replace trigger auto_approve_routine before insert on os.approvals for each row execute function os.auto_approve_routine();

select cron.schedule('os-routine-send', '*/5 * * * *', $c$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-routine-send',
    headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY'),
      'content-type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
  where exists (select 1 from os.approvals where status = 'approved' and decided_by = 'auto:routine')
$c$);

-- 2. Weekly money statement
create or replace function os.rep_weekly_money(force boolean default false) returns integer language plpgsql security definer set search_path = os as $$
declare b os.businesses; m record; localnow timestamp; today date; monday date; pay jsonb; pct numeric; total numeric; cnt int;
  lines text; body text; owner text; n int := 0; wk text;
begin
  owner := coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'OS_OWNER_EMAIL'), 'admin@destinymarketinggroup.com');
  for b in select * from os.businesses where status = 'live' loop
    localnow := now() at time zone b.timezone; today := localnow::date; monday := date_trunc('week', localnow)::date;
    if not force then
      continue when extract(isodow from today)::int <> 5 or extract(hour from localnow)::int <> b.shift_end - 1;
    end if;
    select c.config->'rep_pay' into pay from os.business_config c where c.business_id = b.id and c.active;
    continue when pay is null;
    pct := coalesce((pay->>'commission_pct')::numeric, 20);
    wk := to_char(monday, 'IYYY-IW');
    select count(*), coalesce(sum(os.num(r.data->>'amount')), 0),
           string_agg('• ' || to_char((r.updated_at at time zone b.timezone)::date, 'Dy DD Mon') || ': ' || r.title || ', ₦' || to_char(os.num(r.data->>'amount'), 'FM999,999,990'), E'\n' order by r.updated_at)
      into cnt, total, lines
      from os.records r where r.business_id = b.id and r.type = 'invoice' and r.status = 'paid'
        and (r.updated_at at time zone b.timezone)::date between monday and today;
    body := 'Weekly money statement for ' || b.name || ', week of ' || to_char(monday, 'DD Mon YYYY') || E'.\n\n'
      || 'PAYMENTS LOGGED THIS WEEK (' || cnt || E')\n' || coalesce(lines, '• None this week.') || E'\n\n'
      || 'Total received: ₦' || to_char(total, 'FM999,999,990') || E'\n'
      || 'Rep commission (' || pct || '%): ₦' || to_char(round(total * pct / 100), 'FM999,999,990') || E'\n'
      || 'DMG share due by ' || coalesce(pay->>'remit_by', 'Wednesday') || ': ₦' || to_char(total - round(total * pct / 100), 'FM999,999,990') || E'\n\n'
      || 'Please reply with this week''s account statement screenshot. If anything here doesn''t match the bank, say so in the reply.'
      || E'\n\nDeMarcus\n' || b.name || ' team manager';
    for m in select u.id uid, u.email from os.business_members bm join auth.users u on u.id = bm.user_id
             where bm.business_id = b.id and bm.role = 'caller' loop
      insert into os.person_mail (business_id, kind, to_addr, from_addr, reply_to, subject, body, dedupe_key)
      values (b.id, 'rep_money', m.email, 'DeMarcus · ' || b.name || ' <team@destinymarketinggroup.com>', owner,
        b.name || ': weekly money statement (₦' || to_char(total, 'FM999,999,990') || ')', body,
        'rep_money:' || m.uid || ':' || wk || case when force then ':' || extract(epoch from clock_timestamp())::bigint else '' end)
      on conflict (dedupe_key) do nothing;
      n := n + 1;
    end loop;
    if n > 0 then
      insert into os.person_mail (business_id, kind, to_addr, from_addr, reply_to, subject, body, dedupe_key)
      values (b.id, 'rep_money_owner', owner, 'DeMarcus · ' || b.name || ' <team@destinymarketinggroup.com>', null,
        b.name || ': weekly money statement (₦' || to_char(total, 'FM999,999,990') || ')', body,
        'rep_money_owner:' || b.id || ':' || wk || case when force then ':' || extract(epoch from clock_timestamp())::bigint else '' end)
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;
  return n;
end $$;
revoke all on function os.rep_weekly_money(boolean) from public;
select cron.schedule('os-rep-money', '40 * * * *', 'select os.rep_weekly_money()');

-- 3. Call sheet auto-refill
create or replace function os.call_sheet_refill() returns integer language plpgsql security definer set search_path = os as $$
declare b os.businesses; planned int; n int := 0;
begin
  for b in select * from os.businesses where status = 'live' loop
    continue when not os.on_shift(b);
    continue when not exists (select 1 from os.business_members where business_id = b.id and role = 'caller');
    select count(*) into planned from os.records where business_id = b.id and status = 'call planned';
    continue when planned >= 10;
    continue when exists (select 1 from os.messages where business_id = b.id and sender = 'system'
      and body like '@demarcus Call sheet is low%' and created_at > now() - interval '6 hours');
    insert into os.messages (business_id, sender, body) values (b.id, 'system',
      '@demarcus Call sheet is low: only ' || planned || ' ready for our sales rep. @kole first write call plans for any audited records that don''t have one yet '
      || '(save data.call_plan, move to "call planned"). If that still leaves fewer than 10, @james find 6 to 8 new ones in the next area on the rotation '
      || 'and @emily audit them, then Kole plans them. Businesses only, from their own published contacts.');
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('os-call-refill', '45 * * * *', 'select os.call_sheet_refill()');

-- 4. Allowance reminder (1st of the month, 8:45 New York)
create or replace function os.rep_allowance_reminder(force boolean default false) returns integer language plpgsql security definer set search_path = os as $$
declare b os.businesses; m record; pay jsonb; owner text; n int := 0; mo text;
begin
  if not force and (extract(day from now() at time zone 'America/New_York') <> 1 or extract(hour from now() at time zone 'America/New_York') <> 8) then return 0; end if;
  owner := coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'OS_OWNER_EMAIL'), 'admin@destinymarketinggroup.com');
  mo := to_char(now() at time zone 'America/New_York', 'YYYY-MM');
  for b in select * from os.businesses where status = 'live' loop
    select c.config->'rep_pay' into pay from os.business_config c where c.business_id = b.id and c.active;
    continue when pay is null or pay->>'allowance_ngn' is null;
    for m in select u.email from os.business_members bm join auth.users u on u.id = bm.user_id where bm.business_id = b.id and bm.role = 'caller' loop
      insert into os.person_mail (business_id, kind, to_addr, from_addr, subject, body, dedupe_key)
      values (b.id, 'allowance_reminder', owner, 'DeMarcus · ' || b.name || ' <team@destinymarketinggroup.com>',
        'Send ' || split_part(m.email, '@', 1) || '''s allowance: ₦' || to_char((pay->>'allowance_ngn')::numeric, 'FM999,999,990'),
        'It''s the 1st. Time to send this month''s airtime and data allowance for ' || b.name || E':\n\n'
          || '• Rep: ' || m.email || E'\n• Level: ' || coalesce(pay->>'level', 'Sales Representative')
          || E'\n• Amount: ₦' || to_char((pay->>'allowance_ngn')::numeric, 'FM999,999,990')
          || E'\n\nSend it on Sendwave. If he moves up a level, tell Sean so the amount here changes too.\n\nDeMarcus',
        'allowance:' || m.email || ':' || mo || case when force then ':' || extract(epoch from clock_timestamp())::bigint else '' end)
      on conflict (dedupe_key) do nothing;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function os.rep_allowance_reminder(boolean) from public;
select cron.schedule('os-allowance', '45 * * * *', 'select os.rep_allowance_reminder()');
