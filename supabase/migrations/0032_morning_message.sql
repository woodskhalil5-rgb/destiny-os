-- Morning message: at the start of each business's workday, one short note to the owner (email + phone notification)
-- with only what needs them: items waiting for their OK, new inquiries, callbacks due, and (for African businesses)
-- roofers ready on the call sheet. Nothing needs them, nothing is sent.
alter table os.growth_settings add column if not exists morning_message boolean not null default true;

create or replace function os.morning_digest() returns int language plpgsql security definer set search_path = os as $$
declare b record; n int := 0; app text; waiting int; inq int; due int; calls int; lines text; total int; localday date; wd int; hr int;
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
    select count(*)::int into due from os.records where business_id = b.id and next_step_due <= localday
      and status not in ('won', 'lost', 'signed', 'no answer', 'handled', 'done', 'rejected', 'passed')
      and (next_step ilike '%call%' or next_step ilike '%meeting%' or next_step ilike '%answer%');
    select case when b.timezone like 'Africa/%' then (select count(*)::int from os.records where business_id = b.id and status = 'call planned') else 0 end into calls;
    total := waiting + inq + due + calls;
    continue when total = 0;
    lines := concat_ws(E'\n',
      case when waiting > 0 then '• ' || waiting || case when waiting = 1 then ' thing is' else ' things are' end || ' waiting for your OK' end,
      case when inq > 0 then '• ' || inq || ' new inquir' || case when inq = 1 then 'y' else 'ies' end || ' to answer' end,
      case when due > 0 then '• ' || due || ' callback' || case when due = 1 then '' else 's' end || ' or meeting' || case when due = 1 then '' else 's' end || ' due today' end,
      case when calls > 0 then '• ' || calls || ' compan' || case when calls = 1 then 'y' else 'ies' end || ' ready on the call sheet' end);
    perform os.alert(b.id, 'business', 'morning',
      'Good morning: ' || b.name || ' · ' || total || case when total = 1 then ' thing needs you' else ' things need you' end,
      'Here''s what needs you today at ' || b.name || E':\n\n' || lines || E'\n\nOpen your dashboard: ' || app || '/app'
        || E'\n\n(To stop these, turn off "Morning message" on the Customers screen.)',
      'morning:' || b.id || ':' || localday);
    n := n + 1;
  end loop;
  return n;
end $$;

select cron.schedule('os-morning', '12 * * * *', 'select os.morning_digest()') where not exists (select 1 from cron.job where jobname = 'os-morning');
