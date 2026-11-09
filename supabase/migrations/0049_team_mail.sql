-- DeMarcus's daily brief to the sales rep now goes from team@destinymarketinggroup.com through its own small sender
-- (os-team-mail), not the platform alerts. Replies go to the owner. Replaces the alerts-based version (0047/0048).

create table if not exists os.person_mail (
  id bigserial primary key,
  business_id uuid references os.businesses(id) on delete cascade,
  kind text not null,
  to_addr text not null,
  from_addr text not null,
  reply_to text,
  subject text not null,
  body text not null,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text,
  attempts int not null default 0
);
alter table os.person_mail enable row level security;

create or replace function os.rep_brief(force boolean default false) returns integer language plpgsql security definer set search_path = os as $$
declare b os.businesses; m record; localnow timestamp; today date; tomorrow date; monthstart date; n int := 0;
  first text; todayline text; outcomes text; pay text; month text; lvl jsonb; signed int; due text; fresh text; body text; c int; mtg int;
begin
  for b in select * from os.businesses where status = 'live' and timezone like 'Africa/%' loop
    localnow := now() at time zone b.timezone; today := localnow::date; monthstart := date_trunc('month', localnow)::date;
    tomorrow := today + case extract(isodow from today)::int when 6 then 2 else 1 end;  -- Saturday's brief looks to Monday
    if not force then
      continue when extract(hour from localnow)::int <> b.shift_end - 1 or not (extract(isodow from today)::int = any(b.shift_days));
    end if;
    select c2.config->'rep_next_level' into lvl from os.business_config c2 where c2.business_id = b.id and c2.active;

    for m in select u.id as uid, u.email from os.business_members bm join auth.users u on u.id = bm.user_id
             where bm.business_id = b.id and bm.role = 'caller' loop
      continue when not force and exists (select 1 from os.person_mail where dedupe_key = 'rep_brief:' || m.uid || ':' || today);
      first := initcap(split_part(split_part(m.email, '@', 1), '.', 1));
      first := regexp_replace(first, '[0-9]+$', '');
      if first ilike 'egbeola%' then first := 'Egbeola'; end if;

      -- Today
      select string_agg(x.label || ' ' || x.n, ', ' order by x.n desc) into outcomes
        from (select count(*) n,
                case outcome when 'no_answer' then 'no answer' when 'callback' then 'call back' when 'meeting' then 'meeting booked'
                  when 'signed' then 'signed up' when 'not_interested' then 'not interested' when 'wrong_number' then 'wrong number' else outcome end label
              from os.calls where business_id = b.id and user_id = m.uid and status = 'whatsapp'
                and (ended_at at time zone b.timezone)::date = today group by outcome) x;
      select count(*) into c from os.calls where business_id = b.id and user_id = m.uid and status = 'whatsapp' and (ended_at at time zone b.timezone)::date = today;
      select count(*) into mtg from os.calls where business_id = b.id and user_id = m.uid and status = 'whatsapp' and outcome = 'meeting' and (ended_at at time zone b.timezone)::date = today;
      todayline := '• Calls logged: ' || c || coalesce(' (' || outcomes || ')', '');
      select count(*) || coalesce(', ₦' || to_char(sum(os.num(r.data->>'amount')), 'FM999,999,990'), '') into pay
        from os.records r where r.business_id = b.id and r.type = 'invoice' and r.status = 'paid' and (r.updated_at at time zone b.timezone)::date = today;
      todayline := todayline || E'\n• Payments logged: ' || pay;

      -- This month
      select count(*) filter (where status = 'whatsapp'), count(*) filter (where status = 'whatsapp' and outcome = 'meeting')
        into c, mtg from os.calls where business_id = b.id and user_id = m.uid and (ended_at at time zone b.timezone)::date >= monthstart;
      select count(*) into signed from os.records where business_id = b.id and type = 'roofer' and status = 'signed';
      month := '• Calls: ' || c || E'\n• Meetings booked: ' || mtg || E'\n• Roofers signed (all time): ' || signed;
      if lvl is not null then
        month := month || E'\n• Next level, ' || (lvl->>'name') || ': ' || signed || ' of ' || (lvl->>'signed_roofers') || ' signed roofers'
          || case when signed >= (lvl->>'signed_roofers')::int then '. Target reached, well done!' else ' (' || ((lvl->>'signed_roofers')::int - signed) || ' to go)' end;
      end if;

      -- Tomorrow: call-backs and meetings due, then the best new roofers on the call sheet
      select string_agg('• ' || r.title || coalesce(' · ' || coalesce(nullif(r.data->>'whatsapp', ''), nullif(r.data->>'phone', '')), '') || ': ' || coalesce(r.next_step, r.status), E'\n' order by r.next_step_due, r.id)
        into due from os.records r
        where r.business_id = b.id and r.status in ('called', 'meeting') and r.next_step_due is not null and r.next_step_due <= tomorrow;
      select string_agg('• ' || x.title || coalesce(' · ' || x.phone, '') || coalesce(E'\n  Open with: ' || x.opening, ''), E'\n' order by x.rk)
        into fresh from (
          select r.title, coalesce(nullif(r.data->>'whatsapp', ''), nullif(r.data->>'phone', '')) phone,
            left(coalesce(r.data->'call_plan'->>'opening', case when jsonb_typeof(r.data->'call_plan') = 'string' then r.data->>'call_plan' end), 220) opening,
            row_number() over (order by os.num(r.data->>'score') desc nulls last, r.id) rk
          from os.records r where r.business_id = b.id and r.status = 'call planned') x
        where x.rk <= 8;

      body := 'Hi ' || first || E',\n\nHere''s your day at ' || b.name || ' and your list for ' || to_char(tomorrow, 'FMDay') || E'.\n\n'
        || E'TODAY\n' || todayline || E'\n\nTHIS MONTH\n' || month || E'\n\n'
        || 'FOR ' || upper(to_char(tomorrow, 'FMDay')) || E'\n'
        || coalesce(E'Call-backs and meetings due:\n' || due || E'\n\n', '')
        || coalesce(E'Best new roofers on your call sheet:\n' || fresh, 'Your call sheet is being prepared. New call plans will be there in the morning.')
        || E'\n\nLog every call on the call sheet the same day so your numbers count: https://app.destinymarketinggroup.com/app\n\n'
        || 'DeMarcus' || E'\n' || b.name || ' team manager';

      insert into os.person_mail (business_id, kind, to_addr, from_addr, reply_to, subject, body, dedupe_key)
      values (b.id, 'rep_brief', m.email, 'DeMarcus · ' || b.name || ' <team@destinymarketinggroup.com>', 'admin@destinymarketinggroup.com',
        'DeMarcus: your day and ' || to_char(tomorrow, 'FMDay') || chr(39) || 's list', body,
        'rep_brief:' || m.uid || ':' || today || case when force then ':' || extract(epoch from clock_timestamp())::bigint else '' end)
      on conflict (dedupe_key) do nothing;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function os.rep_brief(boolean) from public;
-- (os.rep_brief_gated from 0048 is left in place unused; the cron below no longer calls it.)

select cron.unschedule('os-rep-brief') where exists (select 1 from cron.job where jobname = 'os-rep-brief');
select cron.schedule('os-rep-brief', '35 * * * *', 'select os.rep_brief()');

select cron.unschedule('os-team-mail') where exists (select 1 from cron.job where jobname = 'os-team-mail');
select cron.schedule('os-team-mail', '*/5 * * * *', $c$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-team-mail',
    headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY'),
      'content-type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 30000)
  where exists (select 1 from os.person_mail where sent_at is null)
$c$);
