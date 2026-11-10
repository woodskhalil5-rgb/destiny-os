-- 0057: a CEO for each of Khalil's businesses, and Destiny HQ, his own room where they report to him.
--   Grant   runs Jersey Home Pros (jhp)
--   Celeste runs Destiny OS (destiny-os), including DMG Nigeria and the client accounts
--   Ezra    runs Destiny Reels (destiny-reels, a new internal business that only he works in)
-- A CEO is the "executive" slot, switched on only in its own business. It sets priorities, directs @demarcus and the
-- team, keeps the money and the tax set-aside straight, and reports to Khalil. It can't spend, change prices, hire or
-- fire, sign, contact customers or prospects, or touch the site; routine approvals follow the usual 5-approvals rule.
-- Everything a CEO says is copied into Destiny HQ; what Khalil writes in HQ goes to the CEO he names (or all three).

alter table os.agents drop constraint if exists agents_slot_check;
alter table os.agents add constraint agents_slot_check check (slot = any (array['research','analysis','production','coordination','media','distribution','finance','executive']));

insert into os.agents (slot, name, handle, personality, core_role, default_tools, sort, retired) values ('executive', 'CEO', 'ceo',
  'A calm, decisive owner-operator. Thinks in numbers and priorities, says what it decided and why in plain words, and never overpromises.',
  'Chief executive: runs this business for the owner as if it were theirs. Sets the plan and the priorities, directs the manager (@demarcus) and the team, keeps the money straight (income, costs, profit and what to set aside for taxes) and reports to the owner, Khalil, who has the final say.',
  array['find_records','get_record','list_tasks','create_task','update_task','review_approval','request_approval','report_to_owner','recall','save_note','write_notebook','update_guide','money_numbers','web_search'],
  0, true)
on conflict (slot) do nothing;

-- New businesses get an executive row like every other slot, but switched off until a CEO is set up for them.
create or replace function os.executive_off_by_default() returns trigger language plpgsql as $$
begin
  if new.slot = 'executive' and coalesce(new.role_instructions, '') = '' then new.enabled := false; end if;
  return new;
end $$;
drop trigger if exists executive_off on os.business_agents;
create trigger executive_off before insert on os.business_agents for each row execute function os.executive_off_by_default();
insert into os.business_agents (business_id, slot, enabled, role_instructions)
  select id, 'executive', false, '' from os.businesses on conflict do nothing;

-- Destiny Reels as a business Ezra can work in (internal; no team of its own yet).
insert into os.businesses (slug, name, status, timezone, platform_fee_usd, markup_pct, monthly_budget_usd, plan, shift_start, shift_end, shift_days)
values ('destiny-reels', 'Destiny Reels', 'live', 'America/New_York', 0, 0, 60, 'internal', 8, 18, '{1,2,3,4,5}')
on conflict (slug) do nothing;
insert into os.business_config (business_id, version, config, note, created_by, active)
  select id, 1, jsonb_build_object(
    'mission', 'Destiny Reels makes and posts short AI videos (reels) for creators and pages on autopilot. Plans: Starter $49, Pro $99, Agency $249 a month. Grow paying creators, keep them, and keep the cost per reel well under what they pay.',
    'facts', '', 'rules', '', 'owner', jsonb_build_object('name', 'Khalil', 'email', (select decrypted_secret from vault.decrypted_secrets where name = 'OS_OWNER_EMAIL')),
    'record_types', jsonb_build_object('lead', jsonb_build_object('stages', jsonb_build_array('found','contacted','trial','paying','lost'), 'description', 'a creator or page that could use Destiny Reels')),
    'approvals', jsonb_build_object('email', jsonb_build_object('agent_can_approve_after', 5, 'daily_limit', 15), 'publish', '{}'::jsonb), 'tool_packs', '[]'::jsonb),
    'created for Ezra', 'sean', true
  from os.businesses where slug = 'destiny-reels' and not exists (select 1 from os.business_config c join os.businesses b on b.id = c.business_id where b.slug = 'destiny-reels');
insert into os.business_agents (business_id, slot, enabled, role_instructions)
  select b.id, a.slot, false, '' from os.businesses b cross join os.agents a where b.slug = 'destiny-reels' on conflict do nothing;

-- Destiny HQ: Khalil's own room. Nobody works in it; it only carries messages to and from the CEOs.
insert into os.businesses (slug, name, status, timezone, platform_fee_usd, markup_pct, monthly_budget_usd, plan)
values ('destiny-hq', 'Destiny HQ', 'live', 'America/New_York', 0, 0, null, 'internal')
on conflict (slug) do nothing;
insert into os.business_config (business_id, version, config, note, created_by, active)
  select id, 1, jsonb_build_object('mission', 'Khalil''s room: the CEOs of JHP (Grant), Destiny OS (Celeste) and Destiny Reels (Ezra) report here. Name one to talk to them, or write to all three.',
    'facts', '', 'rules', '', 'record_types', '{}'::jsonb, 'approvals', '{}'::jsonb, 'tool_packs', '[]'::jsonb), 'HQ room', 'sean', true
  from os.businesses where slug = 'destiny-hq' and not exists (select 1 from os.business_config c join os.businesses b on b.id = c.business_id where b.slug = 'destiny-hq');
insert into os.business_agents (business_id, slot, enabled, role_instructions)
  select b.id, a.slot, false, '' from os.businesses b cross join os.agents a where b.slug = 'destiny-hq' on conflict do nothing;
update os.business_agents set enabled = false where business_id = (select id from os.businesses where slug = 'destiny-hq');

-- Who is CEO where.
create table if not exists os.ceos (
  business_id uuid primary key references os.businesses(id) on delete cascade,
  name text not null unique,
  short text not null
);
alter table os.ceos enable row level security;
revoke all on os.ceos from anon, authenticated;
insert into os.ceos (business_id, name, short)
  select id, v.name, v.short from (values ('jhp', 'Grant', 'JHP'), ('destiny-os', 'Celeste', 'Destiny OS'), ('destiny-reels', 'Ezra', 'Destiny Reels')) v(slug, name, short)
  join os.businesses b on b.slug = v.slug
on conflict (business_id) do nothing;

-- The CEOs' jobs.
update os.business_agents ba set enabled = true, role_instructions = x.ins
from (select b.id, case b.slug
  when 'jhp' then 'You are Grant, CEO of Jersey Home Pros (JHP). '
  when 'destiny-os' then 'You are Celeste, CEO of Destiny OS, the AI team platform Destiny Marketing Group sells (standard price $650 a month plus AI usage; house-buyer founding accounts $100 a month until their first closing). You also run DMG Nigeria (Lagos roofers, sold by Egbeola on WhatsApp for a 20% commission plus a monthly allowance) and you look after the client accounts (Moore Holding LLC, JTM Holding LLC and anyone who signs up): you watch them and report on them, but each client runs their own team. Your own team here sells Destiny OS and answers the website. '
  when 'destiny-reels' then 'You are Ezra, CEO of Destiny Reels: AI reels made and posted for creators and pages (Starter $49, Pro $99, Agency $249 a month). You have no team of your own yet: you decide, plan, track the money and tell Khalil what to build or change. '
  end
  || 'You run this business for Khalil as if it were yours: decide what matters most each day, give @demarcus clear instructions (he runs the team), check the work, and keep the money straight. '
  || 'MONEY: every month know the income, the costs (AI, phone, people, tools), the profit, and what to set aside for taxes: 30% of profit as a working estimate until Khalil''s accountant gives a real rate. Keep a running tax log with save_note (subject "Tax log YYYY-MM") listing income, costs and the set-aside, so the accountant has it all at year end. '
  || 'PEOPLE: you are the boss of the people working this business. Give goals and feedback through @demarcus, or queue an email to them with request_approval; Khalil approves each kind of message until he has approved 5 of that kind. '
  || 'LIMITS: you never spend or move money, change prices, hire or fire, sign anything, contact customers or prospects yourself, or change the website or code (Sean, the engineer, does that; tell Khalil what you need built). If the team is paused, say so and recommend whether to restart it; only Khalil restarts it. Approve routine items with review_approval only when the system clears you. '
  || 'REPORTING: what you write here goes to Khalil''s HQ room. Keep reports short: what is working, what is not, what you decided, and what only Khalil can decide, with numbers. Use report_to_owner only for urgent things (it also emails him).'
  as ins
  from os.businesses b where b.slug in ('jhp', 'destiny-os', 'destiny-reels')) x
where ba.business_id = x.id and ba.slot = 'executive';

-- Messages: everything a CEO says is copied into HQ; what Khalil writes in HQ goes to the CEO(s).
create or replace function os.hq_bridge() returns trigger language plpgsql security definer set search_path = os as $$
declare hq uuid; c record; names text[];
begin
  select id into hq from os.businesses where slug = 'destiny-hq';
  if hq is null then return new; end if;
  if new.business_id = hq then
    if not (new.sender = 'owner' or new.sender like 'user:%') then return new; end if;
    select array_agg(name) into names from os.ceos where new.body ~* ('(^|[^a-z])' || name || '([^a-z]|$)');
    for c in select o.business_id, o.name from os.ceos o where names is null or o.name = any(names) loop
      insert into os.messages (business_id, sender, sender_name, body, status)
        values (c.business_id, 'owner', 'Khalil (HQ)', '@ceo ' || new.body, 'queued');
    end loop;
    return new;
  end if;
  select o.name, o.short into c from os.ceos o where o.business_id = new.business_id;
  if c.name is null then return new; end if;
  if new.sender = 'executive' or new.body like 'CEO reported to the owner:%' then
    insert into os.messages (business_id, sender, sender_name, body, status)
      values (hq, 'executive', c.name || ' · ' || c.short, new.body, 'handled');
  end if;
  return new;
end $$;
revoke all on function os.hq_bridge() from public;
drop trigger if exists hq_bridge on os.messages;
create trigger hq_bridge after insert on os.messages for each row execute function os.hq_bridge();

-- The numbers each CEO gets with its check-ins.
create or replace function os.ceo_numbers(p_bid uuid) returns text language plpgsql security definer set search_path = os as $$
declare b os.businesses; t text := ''; monthstart timestamptz := date_trunc('month', now());
begin
  select * into b from os.businesses where id = p_bid;
  t := 'Team status: ' || b.status || '. AI cost this month: $' || coalesce((select round(sum(cost_usd), 2) from os.usage_events where business_id = p_bid and at >= monthstart), 0)
    || '. Waiting for Khalil''s OK: ' || (select count(*) from os.approvals where business_id = p_bid and status = 'pending') || '.';
  if b.slug = 'jhp' then
    t := t || ' Pipeline: ' || coalesce((select string_agg(status || ' ' || n, ', ' order by n desc) from (select status, count(*) n from os.records where business_id = p_bid and type <> 'invoice' group by status) x), 'empty')
      || '. Emails sent last 7 days: ' || (select count(*) from os.approvals where business_id = p_bid and kind = 'email' and status = 'done' and decided_at > now() - interval '7 days')
      || '. Use money_numbers for jobs won and invoices.';
  elsif b.slug = 'destiny-os' then
    t := t || ' Client accounts: ' || coalesce((select string_agg(name || ' (' || status || case when fee_paid_until is null then ', first month not paid' else ', paid through ' || to_char(fee_paid_until, 'Mon DD') end || ', $' || platform_fee_usd || '/mo)', '; ') from os.businesses where plan = 'customer' and status <> 'archived'), 'none')
      || '. Paid invoices this month: $' || coalesce((select sum(amount_usd) from os.invoices where status = 'paid' and updated_at >= monthstart), 0)
      || '. AI billed to clients this month: $' || coalesce((select round(sum(u.billed_usd), 2) from os.usage_events u join os.businesses c on c.id = u.business_id and c.plan = 'customer' where u.at >= monthstart), 0)
      || '. Sign-ups last 7 days: ' || (select count(*) from os.trial_signups where used and created_at > now() - interval '7 days')
      || '. DMG Nigeria: ' || (select count(*) from os.calls c join os.businesses n on n.id = c.business_id and n.slug = 'dmg-nigeria' where c.status = 'whatsapp' and c.started_at > now() - interval '7 days') || ' calls logged last 7 days, '
      || (select count(*) from os.records r join os.businesses n on n.id = r.business_id and n.slug = 'dmg-nigeria' where r.status = 'signed') || ' roofers signed in total, '
      || (select count(*) from os.records r join os.businesses n on n.id = r.business_id and n.slug = 'dmg-nigeria' where r.status = 'call planned') || ' on the call sheet.';
  elsif b.slug = 'destiny-reels' then
    t := t || ' Creators: ' || coalesce((select string_agg(plan || ' ' || status || ' ' || n, ', ') from (select plan, status, count(*) n from reels.creators where not is_admin group by plan, status) x), 'none yet')
      || '. Monthly revenue from active plans: $' || coalesce((select sum(case plan when 'starter' then 49 when 'pro' then 99 when 'agency' then 249 else 0 end) from reels.creators where status = 'active' and not is_admin), 0)
      || '. Reels AI and render cost this month: $' || coalesce((select round(sum(cost_usd), 2) from reels.usage where at >= monthstart), 0)
      || '. New creators last 7 days: ' || (select count(*) from reels.creators where created_at > now() - interval '7 days' and not is_admin) || '.';
  end if;
  return t;
end $$;
revoke all on function os.ceo_numbers(uuid) from public;

-- Check-ins: morning (8am) and end of day (5pm) on weekdays, and the monthly close (1st, 9am), in each business's time.
-- They're sent as Khalil's own request, so the CEO answers even when the team is paused (the team itself stays paused).
create or replace function os.ceo_cycle(force text default null) returns integer language plpgsql security definer set search_path = os as $$
declare c record; lt timestamp; kind text; body text; n int := 0;
begin
  for c in select o.business_id, o.name, b.timezone from os.ceos o join os.businesses b on b.id = o.business_id where b.status <> 'archived' loop
    lt := now() at time zone c.timezone;
    kind := coalesce(force,
      case when extract(day from lt) = 1 and extract(hour from lt) = 9 then 'monthly'
           when extract(isodow from lt) <= 5 and extract(hour from lt) = 8 then 'morning'
           when extract(isodow from lt) <= 5 and extract(hour from lt) = 17 then 'evening' end);
    continue when kind is null;
    continue when force is null and exists (select 1 from os.messages where business_id = c.business_id and sender_name = 'HQ schedule'
      and body like '@ceo ' || initcap(kind) || '%' and created_at > now() - interval '20 hours');
    body := '@ceo ' || initcap(kind) || ' check-in. ' || os.ceo_numbers(c.business_id) || ' '
      || case kind
        when 'morning' then 'Decide today''s 1 to 3 priorities, give @demarcus his instructions, and tell Khalil in 5 lines or fewer: what''s working, what''s not, what you decided, and anything only he can decide.'
        when 'evening' then 'Check what got done today against this morning''s priorities and tell Khalil in 5 lines or fewer: done, not done and why, money today, and tomorrow''s plan.'
        else 'Close last month: income, costs, profit and the tax set-aside (30% of profit as an estimate). Save it to the tax log with save_note (subject "Tax log ' || to_char(lt - interval '1 month', 'YYYY-MM') || '") and give Khalil the summary plus your top 3 moves for this month.'
      end;
    insert into os.messages (business_id, sender, sender_name, body, status) values (c.business_id, 'owner', 'HQ schedule', body, 'queued');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function os.ceo_cycle(text) from public;
select cron.unschedule('os-ceo-cycle') where exists (select 1 from cron.job where jobname = 'os-ceo-cycle');
select cron.schedule('os-ceo-cycle', '5 * * * *', 'select os.ceo_cycle()');

insert into os.messages (business_id, sender, body, status)
  select id, 'system', 'Welcome to Destiny HQ. Your CEOs report here: Grant runs JHP, Celeste runs Destiny OS (with DMG Nigeria and the client accounts), Ezra runs Destiny Reels. You''ll get a morning check-in and an end-of-day wrap from each on weekdays, and a monthly money and tax close on the 1st. Name one to talk to them ("Celeste, how is Nigeria doing?"), or just write and all three answer.', 'handled'
  from os.businesses where slug = 'destiny-hq' and not exists (select 1 from os.messages m where m.business_id = os.businesses.id);

-- The CEO slot is kept out of new teams (retired), but may be switched on where a CEO has been set up.
create or replace function os.no_retired_agents() returns trigger language plpgsql as $$
begin
  if new.enabled and new.slot <> 'executive' and exists (select 1 from os.agents where slot = new.slot and retired) then new.enabled := false; end if;
  return new;
end $$;
update os.business_agents ba set enabled = true from os.ceos o where ba.business_id = o.business_id and ba.slot = 'executive' and ba.role_instructions <> '';
