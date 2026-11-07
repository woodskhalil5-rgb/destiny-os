-- Nora (Money) joins every team; Benjamin (Distribution) retires. His work moves to the teammates it overlaps with:
-- finding partners and channels -> James, partnership outreach -> Kole, engagement tracking -> Emily.
-- The human side of outreach (joining groups, walking into markets, calling partners) is for the business's VAs.
-- Benjamin's past messages, records and usage stay as they were.

alter table os.agents drop constraint if exists agents_slot_check;
alter table os.agents add constraint agents_slot_check check (slot in ('research','analysis','production','coordination','media','distribution','finance'));
alter table os.agents add column if not exists retired boolean not null default false;

insert into os.agents (slot, name, handle, personality, core_role, default_tools, sort) values ('finance', 'Nora', 'nora',
  'Sharp, calm and careful with numbers. Plain-spoken and a little dry, never alarmist. Double-checks every figure and always says where it came from.',
  $r$Money: keeps the business's own money straight. Tracks jobs won, open quotes, invoices, and what the business pays for Destiny OS, using money_numbers and the records; she never guesses a number, and if something isn't in the records she says what's missing. Invoices are records of type invoice (stages: unpaid -> reminded -> paid, or written off; data: amount, number, job, email, phone, issued_on, due_on, reminders, paid_on). When the owner says an invoice went out or got paid, save or update it right away. Chasing unpaid invoices: a friendly reminder the day after it's due, another a week later, a third two weeks later, each one an email through request_approval (kind email, record_id), never more than three and never once it's paid; then tell @demarcus so the owner can call. Keep next_step_due on each unpaid invoice set to the next reminder date. Every Monday at the start of the shift, post a short money snapshot for the owner: won, quoted, still open, owed and overdue, what Destiny OS cost per job won, and anything unusual compared with the week before. Never pay, send, move or ask for money any other way, never give tax, legal or investment advice, and never share one customer's money details with another.$r$,
  array['find_records','get_record','save_record','create_task','update_task','recall','save_note','request_approval','money_numbers'], 6)
on conflict (slot) do update set name = excluded.name, handle = excluded.handle, personality = excluded.personality,
  core_role = excluded.core_role, default_tools = excluded.default_tools, sort = excluded.sort;

update os.agents set retired = true, sort = 7 where slot = 'distribution';

-- Benjamin's core job, folded into the people it overlapped with.
update os.agents set core_role = core_role || ' Also finds where the business''s customers gather and who can send it work: partners, referral sources, communities and channels, saved as records with a suggested approach (a person or VA makes the human contact).'
  where slot = 'research' and core_role not like '%who can send it work%';
update os.agents set core_role = core_role || ' This includes partnership and referral outreach. Never contact individuals from bought or scraped lists.'
  where slot = 'production' and core_role not like '%partnership and referral outreach%';
update os.agents set core_role = core_role || ' Track engagement and campaign results: what got replies, which channels and partners bring work.'
  where slot = 'analysis' and core_role not like '%Track engagement and campaign results%';

-- A retired teammate can't be switched back on, and new businesses never get one.
create or replace function os.no_retired_agents() returns trigger language plpgsql as $$
begin
  if new.enabled and exists (select 1 from os.agents where slot = new.slot and retired) then new.enabled := false; end if;
  return new;
end $$;
drop trigger if exists no_retired_agents on os.business_agents;
create trigger no_retired_agents before insert or update on os.business_agents for each row execute function os.no_retired_agents();

-- Nora on every team.
insert into os.business_agents (business_id, slot, enabled, role_instructions)
  select id, 'finance', true, '' from os.businesses on conflict (business_id, slot) do nothing;
update os.business_agents set role_instructions = $i$This is Destiny OS's own sales team in Lagos. Track the money side: trials started, trials that became paying clients, and each client's monthly fee in naira from the facts. The owner collects every payment himself and the sales rep never handles money, so you never ask a roofer for money: you track it, and draft any payment reminder for the owner's approval.$i$
  where slot = 'finance' and business_id = (select id from os.businesses where slug = 'dmg-nigeria');
update os.business_agents set role_instructions = $i$Track how the brands earn: creator-program payouts and their requirements, sponsor deals (save sponsors as sponsor records with the agreed amount and payment dates), affiliate income, and what each brand costs to run. Flag a sponsor payment that's late.$i$
  where slot = 'finance' and business_id = (select id from os.businesses where name = 'Autonomous Sports Media Network');
update os.business_agents set role_instructions = $i$Track the business's own money: deals under contract and closed, what each made, money owed to and by the business, and running costs. Emily scores the deals; you keep the books straight.$i$
  where slot = 'finance' and business_id = (select id from os.businesses where name = 'Destiny Acquisitions');

-- Benjamin's per-business partner work goes to James (Kole drafts any outreach).
update os.business_agents ba set role_instructions = trim(ba.role_instructions || E'\n\n' || x.add)
from (values
  ('Jersey Home Pros', $a$Partners (this used to be Benjamin's job): find HOAs, property managers, realtors, home inspectors, town groups and events in the assigned county that can send JHP homeowners. Save them as partner records with a suggested approach, hand @kole the best ones for a short partnership email (for approval), and give @grayson angles for community content.$a$),
  ('DMG Nigeria', $a$Partners (this used to be Benjamin's job): find the people who can send us roofers in Lagos: roofing-sheet and stone-coated tile dealers, building-materials markets (for example Coker and Orile), estate developers, and Facebook and WhatsApp groups where Lagos homeowners ask for roofers. Save them as partner records with a suggested approach for the sales rep. Any outreach goes through approval.$a$),
  ('DMG Kenya', $a$Partners (this used to be Benjamin's job): find the people who can send us roofers in Nairobi: roofing-material suppliers and hardware stores (for example mabati and tile dealers), building and construction associations, Facebook groups where Nairobi homeowners ask for roofers. Save them as partner records with a suggested approach for the sales rep. Any outreach goes through approval.$a$),
  ('Destiny Acquisitions', $a$Deal sources (this used to be Benjamin's job): find listing agents, wholesalers and local investor groups who bring deals. Save them as agent_contact records; @kole drafts the introductions for approval.$a$),
  ('Autonomous Sports Media Network', $a$Growth (this used to be Benjamin's job): find where each brand's fans gather and how to grow there: hashtags, communities, posting times, collaborations with other fan creators, and sponsors that fit each brand (sports bars, apparel, local businesses, sports apps). Save sponsors as sponsor records; @kole drafts outreach for approval.$a$),
  ('Destiny Test Co', $a$Also find local groups and venues where catering buyers are.$a$)
) as x(name, add)
join os.businesses b on b.name = x.name
where ba.business_id = b.id and ba.slot = 'research' and ba.role_instructions not like '%this used to be Benjamin%' and ba.role_instructions not like '%catering buyers are%';

-- Benjamin's open work goes to James; then Benjamin is switched off everywhere.
update os.tasks set assignee_slot = 'research', updated_at = now() where assignee_slot = 'distribution' and status in ('open', 'in_progress', 'blocked');
update os.records set owner_slot = 'research' where owner_slot = 'distribution';
update os.business_agents set enabled = false where slot = 'distribution';

-- Nora's Monday snapshot: one line added to the start-of-shift message on Mondays.
create or replace function os.hourly() returns void language plpgsql security definer set search_path = os as $function$
declare b os.businesses; h int; others text; busy text; today date; monday text;
begin
  for b in select * from os.businesses where status = 'live' loop
    continue when not os.on_shift(b);
    h := extract(hour from now() at time zone b.timezone)::int;
    today := (now() at time zone b.timezone)::date;
    if h = b.shift_start or h = b.shift_end - 1 then
      select string_agg('@' || a.handle, ' ' order by a.sort) into others
        from os.business_agents ba join os.agents a using (slot)
        where ba.business_id = b.id and ba.enabled and a.slot <> 'coordination';
      monday := case when h = b.shift_start and extract(isodow from today) = 1
          and exists (select 1 from os.business_agents where business_id = b.id and slot = 'finance' and enabled)
        then ' @nora it''s Monday: post the weekly money snapshot (money_numbers).' else '' end;
      insert into os.messages (business_id, sender, body) values (b.id, 'system',
        case when h = b.shift_start
          then 'Shift started. @demarcus read the notebook, review tasks and records, and give out today''s assignments as tasks. ' || coalesce(others, '') || ' pick up where you left off; work in batches.' || monday
          else 'Last hour of the shift. ' || coalesce(others, '') || ' wrap up and tell @demarcus where you stand. @demarcus then send the owner today''s report and write today''s notebook entry (write_notebook).' end);
    else
      select string_agg('@' || a.handle, ' ' order by a.sort) into busy
        from os.business_agents ba join os.agents a using (slot)
        where ba.business_id = b.id and ba.enabled and a.slot <> 'coordination' and (
          exists (select 1 from os.tasks t where t.business_id = b.id and t.assignee_slot = a.slot and t.status in ('open', 'in_progress'))
          or exists (select 1 from os.records r where r.business_id = b.id and r.owner_slot = a.slot and r.next_step_due <= today));
      if busy is not null then
        insert into os.messages (business_id, sender, body) values (b.id, 'system',
          'Hourly check-in. ' || busy || ' do the next batch of your open work, then post a one-line update.');
      elsif (h - b.shift_start) % 3 = 0 then
        insert into os.messages (business_id, sender, body) values (b.id, 'system',
          '@demarcus nobody has open work right now. Check the records and give out the next assignments as tasks, or note that the team is caught up.');
      end if;
    end if;
  end loop;
end $function$;

-- A money amount typed any way ("$4,200", "₦150,000", "1200.50") as a number; anything unreadable is null.
create or replace function os.num(t text) returns numeric language sql immutable as $$
  select nullif(substring(regexp_replace(coalesce(t, ''), '[^0-9.]', '', 'g') from '^[0-9]+(?:\.[0-9]+)?'), '')::numeric
$$;

-- The numbers behind Nora's work, for one business: the last N days against the N days before.
create or replace function os.money_numbers(bid uuid, days int default 30) returns jsonb language sql stable security definer set search_path = os as $$
  with p as (select greatest(1, least(coalesce(days, 30), 366)) as d, (now() at time zone (select timezone from os.businesses where id = bid))::date as today),
  w as (
    select kind, value_usd, at, case when at >= now() - make_interval(days => p.d) then 'now' when at >= now() - make_interval(days => 2 * p.d) then 'before' end as span
    from os.wins, p where business_id = bid and at >= now() - make_interval(days => 2 * p.d)),
  inv as (
    select id, title, status, os.num(data->>'amount') as amount,
      case when coalesce(data->>'due_on', '') ~ '^\d{4}-\d{2}-\d{2}$' then (data->>'due_on')::date end as due_on,
      case when coalesce(data->>'paid_on', '') ~ '^\d{4}-\d{2}-\d{2}$' then (data->>'paid_on')::date end as paid_on,
      coalesce(jsonb_array_length(case when jsonb_typeof(data->'reminders') = 'array' then data->'reminders' end), case when coalesce(data->>'reminders', '') ~ '^\d+$' then (data->>'reminders')::int end, 0) as reminders
    from os.records where business_id = bid and type = 'invoice'),
  q as (
    select status, os.num(data->>'amount') as amount, updated_at
    from os.records where business_id = bid and type = 'quote'),
  bill as (select coalesce(sum(amount_usd), 0) as usd from os.month_bill(bid, date_trunc('month', now())::date))
  select jsonb_build_object(
    'period_days', (select d from p),
    'today', (select today from p),
    'jobs_won', jsonb_build_object(
      'now', (select count(*) from w where kind = 'job' and span = 'now'), 'now_total', (select coalesce(sum(value_usd), 0) from w where kind = 'job' and span = 'now'),
      'before', (select count(*) from w where kind = 'job' and span = 'before'), 'before_total', (select coalesce(sum(value_usd), 0) from w where kind = 'job' and span = 'before'),
      'jobs_with_no_amount', (select count(*) from w where kind = 'job' and span = 'now' and value_usd is null)),
    'repeat_jobs', jsonb_build_object('now', (select count(*) from w where kind = 'repeat' and span = 'now'), 'now_total', (select coalesce(sum(value_usd), 0) from w where kind = 'repeat' and span = 'now')),
    'quotes_sent', jsonb_build_object(
      'now', (select count(*) from w where kind = 'estimate' and span = 'now'), 'now_total', (select coalesce(sum(value_usd), 0) from w where kind = 'estimate' and span = 'now'),
      'before', (select count(*) from w where kind = 'estimate' and span = 'before')),
    'quotes_open', jsonb_build_object('count', (select count(*) from q where status in ('sent', 'following up')), 'total', (select coalesce(sum(amount), 0) from q where status in ('sent', 'following up'))),
    'quote_win_rate_pct', (select round(100.0 * count(*) filter (where status = 'won') / nullif(count(*) filter (where status in ('won', 'lost', 'no answer')), 0))
      from q, p where updated_at >= now() - make_interval(days => p.d)),
    'invoices', jsonb_build_object(
      'unpaid_count', (select count(*) from inv where status in ('unpaid', 'reminded')),
      'unpaid_total', (select coalesce(sum(amount), 0) from inv where status in ('unpaid', 'reminded')),
      'overdue_count', (select count(*) from inv, p where status in ('unpaid', 'reminded') and due_on < p.today),
      'overdue_total', (select coalesce(sum(amount), 0) from inv, p where status in ('unpaid', 'reminded') and due_on < p.today),
      'paid_in_period_total', (select coalesce(sum(amount), 0) from inv, p where status = 'paid' and paid_on >= p.today - p.d),
      'overdue', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'amount', amount, 'due_on', due_on, 'days_late', p.today - due_on, 'reminders', reminders) order by due_on), '[]'::jsonb)
        from (select inv.* from inv, p where status in ('unpaid', 'reminded') and due_on < p.today order by due_on limit 25) x, p)),
    'inquiries_this_month', (select count(*) from os.records where business_id = bid and type = 'inquiry' and created_at >= date_trunc('month', now())),
    'destiny_os_bill_this_month_usd', (select round(usd, 2) from bill),
    'jobs_won_this_month', (select count(*) from os.wins where business_id = bid and kind = 'job' and at >= date_trunc('month', now())),
    'destiny_os_cost_per_job_this_month_usd', (select round((select usd from bill) / nullif(count(*), 0), 2) from os.wins where business_id = bid and kind = 'job' and at >= date_trunc('month', now())),
    'note', 'Jobs, quotes and invoices (every *_total and amount) are in the business''s own currency, as entered. Only the destiny_os_* figures are US dollars (what the business pays for Destiny OS). Jobs and quotes count only what the owner logged on the Customers screen or told the team.'
  )
$$;
revoke all on function os.money_numbers(uuid, int) from public;
