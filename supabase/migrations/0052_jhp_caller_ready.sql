-- 0052: make Jersey Home Pros ready for a phone caller (same setup DMG Nigeria's WhatsApp caller has).
-- * JHP gets the own-phone call sheet (os-callsheet edge function; tap-to-call, the rep dials from their own phone).
-- * Kole (production) writes call plans for verified contractors where a call is the next step; DeMarcus keeps the sheet stocked.
-- * The call-sheet refill note is wording-neutral (not just "audited records").
-- * The evening rep brief covers every live business with a caller, counting own-phone ('manual') calls as well as WhatsApp ones.

update os.business_config set config = coalesce(config, '{}'::jsonb) || '{"call_sheet":"own_phone","call_sheet_country":"1"}'::jsonb
where active and business_id = (select id from os.businesses where slug = 'jhp');

update os.business_agents ba set role_instructions = ba.role_instructions || E'\n\n'
  || 'CALL SHEET: our sales rep calls contractors from their own phone. For every verified contractor with a phone number whose best next step is a call '
  || '(no business email, or next_step "call lead"/"call"), write a call plan and save it in data.call_plan as {"opening": one or two friendly sentences '
  || 'that name one real detail of their business, "pitch": the JHP offer in plain words, "questions": 2 or 3 short questions, "objections": the likely '
  || 'pushback with a short answer}, then set the record status to "call planned". Keep about 10 call-planned contractors ready. Businesses only, '
  || 'from their own published contacts. Never text anyone.'
from os.businesses b where b.id = ba.business_id and b.slug = 'jhp' and ba.slot = 'production'
  and ba.role_instructions not like '%CALL SHEET:%';

update os.business_agents ba set role_instructions = ba.role_instructions || E'\n\n'
  || 'CALL SHEET: when the sales rep logs a call you get a board note. Call-backs, meetings and sign-ups need you: confirm the next step and date on the '
  || 'record, and for a meeting or sign-up tell the owner. If the sheet drops under 10 call-planned contractors, ask @kole to plan more from the verified '
  || 'list and the finder to find more. Put the call numbers (calls, meetings, sign-ups) in the end-of-day report.'
from os.businesses b where b.id = ba.business_id and b.slug = 'jhp' and ba.slot = 'coordination'
  and ba.role_instructions not like '%CALL SHEET:%';

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
      '@demarcus Call sheet is low: only ' || planned || ' ready for our sales rep. @kole first write call plans for any checked (verified/audited) records '
      || 'with a phone number that don''t have one yet (save data.call_plan, move to "call planned"). If that still leaves fewer than 10, get new ones found '
      || 'and checked in the next area, then Kole plans them. Businesses only, from their own published contacts.');
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function os.rep_brief(force boolean default false) returns integer language plpgsql security definer set search_path = os as $$
declare b os.businesses; m record; localnow timestamp; today date; tomorrow date; monthstart date; n int := 0;
  first text; todayline text; outcomes text; pay text; month text; lvl jsonb; signed int; due text; fresh text; body text; c int; mtg int; cur text;
begin
  for b in select * from os.businesses x where x.status = 'live'
             and exists (select 1 from os.business_members bm where bm.business_id = x.id and bm.role = 'caller') loop
    localnow := now() at time zone b.timezone; today := localnow::date; monthstart := date_trunc('month', localnow)::date;
    tomorrow := today + case extract(isodow from today)::int when 5 then case when 6 = any(b.shift_days) then 1 else 3 end when 6 then 2 else 1 end;
    cur := case when b.timezone = 'Africa/Lagos' then '₦' else '$' end;
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

      select string_agg(x.label || ' ' || x.n, ', ' order by x.n desc) into outcomes
        from (select count(*) n,
                case outcome when 'no_answer' then 'no answer' when 'callback' then 'call back' when 'meeting' then 'meeting booked'
                  when 'signed' then 'signed up' when 'not_interested' then 'not interested' when 'wrong_number' then 'wrong number' else outcome end label
              from os.calls where business_id = b.id and user_id = m.uid and status in ('whatsapp', 'manual')
                and (ended_at at time zone b.timezone)::date = today group by outcome) x;
      select count(*) into c from os.calls where business_id = b.id and user_id = m.uid and status in ('whatsapp', 'manual') and (ended_at at time zone b.timezone)::date = today;
      todayline := '• Calls logged: ' || c || coalesce(' (' || outcomes || ')', '');
      select count(*) || coalesce(', ' || cur || to_char(sum(os.num(r.data->>'amount')), 'FM999,999,990'), '') into pay
        from os.records r where r.business_id = b.id and r.type = 'invoice' and r.status = 'paid' and (r.updated_at at time zone b.timezone)::date = today;
      todayline := todayline || E'\n• Payments logged: ' || pay;

      select count(*) filter (where status in ('whatsapp', 'manual')), count(*) filter (where status in ('whatsapp', 'manual') and outcome = 'meeting')
        into c, mtg from os.calls where business_id = b.id and user_id = m.uid and (ended_at at time zone b.timezone)::date >= monthstart;
      select count(*) into signed from os.records where business_id = b.id and type <> 'invoice' and status = 'signed';
      month := '• Calls: ' || c || E'\n• Meetings booked: ' || mtg || E'\n• Signed up (all time): ' || signed;
      if lvl is not null then
        month := month || E'\n• Next level, ' || (lvl->>'name') || ': ' || signed || ' of ' || (lvl->>'signed_roofers') || ' signed'
          || case when signed >= (lvl->>'signed_roofers')::int then '. Target reached, well done!' else ' (' || ((lvl->>'signed_roofers')::int - signed) || ' to go)' end;
      end if;

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
        || coalesce(E'Best new prospects on your call sheet:\n' || fresh, 'Your call sheet is being prepared. New call plans will be there in the morning.')
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
