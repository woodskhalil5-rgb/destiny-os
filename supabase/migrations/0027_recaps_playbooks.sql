-- Stage 4: the owner hears what the team did without opening the dashboard, and new trials get a nudge toward the
-- setup steps that make the team useful.
--  * Industry playbooks: one seasonal idea per month for common home-service trades (and a general fallback).
--    Shown on the Customers screen and in the weekly recap; one tap asks Kole to draft that email.
--  * Weekly recap (Mondays): wins, inquiries, what went out, what's waiting, AI spend so far this month.
--  * Trial nudges: day 1 if the team was never started, day 3 with the setup steps still missing.

create table if not exists os.playbooks (
  key text primary key,
  label text not null,
  match text not null,          -- regex (case-insensitive) against the type of business and its name
  months jsonb not null,        -- {"1": "idea for January", ... "12": "..."}
  sort int not null default 100
);
alter table os.playbooks enable row level security;

insert into os.playbooks (key, label, match, months, sort) values
('roofing', 'Roofing', 'roof', '{
 "1":"Ice dam and winter leak checks: offer a quick inspection after the first big freeze",
 "2":"Book spring roof work early: the calendar fills fast once the weather breaks",
 "3":"Post-winter roof inspection: missing shingles and flashing damage show up now",
 "4":"Spring storm season: a free check after high winds, before small leaks get big",
 "5":"Gutter and roof tune-up before summer storms",
 "6":"Summer is the best time to replace: dry weather, faster installs",
 "7":"Attic ventilation check: a hot attic shortens a roof''s life and raises cooling bills",
 "8":"Hurricane-season prep: secure loose shingles and flashing now",
 "9":"Fall roof inspection before leaves and winter weather",
 "10":"Last call to replace a roof before cold weather slows installs",
 "11":"Gutter cleaning and leak check before the first snow",
 "12":"Year-end: storm damage claims and inspections before the holidays"}', 10),
('hvac', 'Heating and cooling', 'hvac|heating|cooling|air condition|furnace|heat pump|\bac\b', '{
 "1":"No-heat emergencies: remind customers you answer fast, and offer a furnace check",
 "2":"Mid-winter furnace tune-up and filter change",
 "3":"Book your AC tune-up before the first warm week",
 "4":"AC tune-up season: beat the summer rush",
 "5":"Last chance for an AC check before the heat hits",
 "6":"Is your AC struggling? A quick service call before it fails in a heat wave",
 "7":"Heat-wave season: fast AC repair, and a reminder to change filters",
 "8":"Thinking about a new system? Late summer is a good time to quote it",
 "9":"Book your fall furnace tune-up before the cold",
 "10":"Furnace check and carbon monoxide safety before heating season",
 "11":"Heating tune-up before the holidays and the first hard freeze",
 "12":"Winter maintenance plans: one visit a season, priority service"}', 20),
('plumbing', 'Plumbing', 'plumb|drain|sewer|water heater', '{
 "1":"Frozen pipe prevention and emergency service",
 "2":"Water heater check: sediment and age, before it fails",
 "3":"Spring sump pump test before the rainy season",
 "4":"Outdoor spigot and irrigation turn-on, with a leak check",
 "5":"Drain cleaning before summer guests arrive",
 "6":"Summer water bills: find hidden leaks and running toilets",
 "7":"Garbage disposal and drain care after summer cookouts",
 "8":"Back-to-school: water heater ready for busier mornings",
 "9":"Fall plumbing check before cold weather",
 "10":"Winterize outdoor lines and spigots",
 "11":"Holiday drain prep: keep the kitchen sink running on Thanksgiving",
 "12":"Frozen pipe tips and fast winter service"}', 30),
('landscaping', 'Landscaping and lawn care', 'landscap|lawn|garden|tree|mow|hardscap|snow', '{
 "1":"Plan your spring yard now: book design and install dates early",
 "2":"Pruning and tree work while plants are dormant",
 "3":"Spring cleanup: leaves, beds and the first mow",
 "4":"Mulch, planting and lawn treatment season",
 "5":"Weekly mowing slots are filling up",
 "6":"Summer watering and irrigation check",
 "7":"Patio and outdoor living projects for the rest of summer",
 "8":"Aeration and overseeding are coming up: reserve a spot",
 "9":"Fall aeration and seeding: the best time for a thick lawn",
 "10":"Fall cleanup and leaf removal",
 "11":"Last leaf pickup and winter prep",
 "12":"Snow removal sign-ups and next year''s plans"}', 40),
('cleaning', 'Cleaning', 'clean|maid|janitor|housekeep', '{
 "1":"New year deep clean: start the year fresh",
 "2":"Mid-winter refresh: carpets and upholstery",
 "3":"Spring cleaning: book your deep clean",
 "4":"Spring cleaning is in full swing: last openings this month",
 "5":"Move-out and move-in cleans for moving season",
 "6":"Summer schedule: regular cleaning while you enjoy the season",
 "7":"Post-party and vacation-rental turnover cleans",
 "8":"Back-to-school reset clean",
 "9":"Fall deep clean before the holidays",
 "10":"Get the house ready for holiday guests",
 "11":"Pre-Thanksgiving clean: openings going fast",
 "12":"Holiday and New Year''s cleaning, and gift certificates"}', 50),
('painting', 'Painting', 'paint|stain', '{
 "1":"Interior painting: winter is the slow season, so dates are open",
 "2":"Refresh a room before spring: interior painting specials",
 "3":"Book exterior painting now for late spring",
 "4":"Exterior painting season starts: free estimates",
 "5":"Deck and fence staining before summer",
 "6":"Exterior painting: get on the summer schedule",
 "7":"Curb appeal for sellers: paint before you list",
 "8":"Last exterior slots before fall",
 "9":"Fall exterior painting while the weather holds",
 "10":"Interior painting before holiday guests",
 "11":"Cabinets and trim refresh before the holidays",
 "12":"Book winter interior jobs and lock in this year''s price"}', 60),
('pest', 'Pest control', 'pest|extermin|termite|bug|rodent|mosquito', '{
 "1":"Mice and rodents moving indoors for winter",
 "2":"Winter rodent sealing and inspection",
 "3":"Termite swarm season is coming: book an inspection",
 "4":"Ants and termites: spring treatment",
 "5":"Mosquito and tick season starts",
 "6":"Summer pest plan: mosquitoes, ticks, wasps",
 "7":"Wasp and hornet nest removal",
 "8":"Late-summer mosquito and stinging insect control",
 "9":"Fall pest-proofing before rodents move in",
 "10":"Stink bugs and rodents: seal up for winter",
 "11":"Rodent season: inspection and exclusion",
 "12":"Year-round protection plans"}', 70),
('electrical', 'Electrical', 'electric', '{
 "1":"Space heaters and overloaded circuits: a winter safety check",
 "2":"Panel upgrade quotes before spring projects",
 "3":"Outdoor lighting and outlet installs for spring",
 "4":"Generator check before storm season",
 "5":"Ceiling fans before summer",
 "6":"EV charger installs",
 "7":"Surge protection for summer storms",
 "8":"Back-to-school: smoke and CO detector check",
 "9":"Fall safety inspection for older homes",
 "10":"Holiday lighting and outdoor outlets",
 "11":"Generator service before winter storms",
 "12":"Holiday lights safety and year-end panel upgrades"}', 80),
('remodeling', 'Remodeling and construction', 'remodel|contract|construct|kitchen|bath|basement|carpent|handyman|floor|tile|deck|window|door|siding|gutter|masonry|concrete|fenc', '{
 "1":"Plan your spring project now: design and quotes take time",
 "2":"Book spring start dates before the calendar fills",
 "3":"Spring projects: decks, siding and exterior work",
 "4":"Outdoor projects season: free estimates",
 "5":"Get summer projects on the schedule",
 "6":"Summer is a good time for kitchens and baths while the kids are out",
 "7":"Selling soon? Repairs that help a home sell",
 "8":"Last summer start dates for outdoor work",
 "9":"Fall projects: finish before the holidays",
 "10":"Basement and interior projects for the winter",
 "11":"Small repairs before holiday guests",
 "12":"Plan next year''s project and lock in this year''s price"}', 90),
('exterior_cleaning', 'Pressure washing and exterior cleaning', 'pressure|power wash|soft wash|window clean|exterior clean', '{
 "1":"Book spring washing early and get the best dates",
 "2":"Plan your spring house wash",
 "3":"Spring house and driveway wash",
 "4":"Spring washing: siding, decks and walkways",
 "5":"Deck and patio wash before summer cookouts",
 "6":"Summer curb appeal: driveway and house wash",
 "7":"Window cleaning for summer views",
 "8":"Pre-sale washing for home sellers",
 "9":"Fall wash before winter grime",
 "10":"Gutter brightening and fall cleanup",
 "11":"Holiday-ready exterior: walkways and entries",
 "12":"Gift certificates for spring washing"}', 95),
('general', 'Any business', '.', '{
 "1":"New year check-in: thank past customers and invite them back",
 "2":"Winter special for past customers on a slower month",
 "3":"Spring is coming: book early and get the best dates",
 "4":"Spring check-in with past customers",
 "5":"Before summer: a reason to book now",
 "6":"Mid-year thank-you and a referral ask",
 "7":"Summer reminder of what you offer",
 "8":"Back-to-school timing: what customers should do before fall",
 "9":"Fall check-in: get on the schedule before the busy season",
 "10":"Before the holidays: last openings this year",
 "11":"Thank-you note to past customers, and a referral ask",
 "12":"Year-end thanks, and book early for next year"}', 1000)
on conflict (key) do update set label = excluded.label, match = excluded.match, months = excluded.months, sort = excluded.sort;

-- The playbook that fits a business: by the type of business it signed up with, else its name and mission.
create or replace function os.playbook_for(bid uuid) returns table(key text, label text, idea text)
language sql stable security definer set search_path = os as $$
  with t as (
    select lower(concat_ws(' ', (select s.details->>'industry' from os.trial_signups s where s.business_id = bid order by s.id desc limit 1),
      b.name, left(c.config->>'mission', 400))) as txt
    from os.businesses b left join os.business_config c on c.business_id = b.id and c.active where b.id = bid)
  select p.key, p.label, p.months->>extract(month from now())::int::text
  from os.playbooks p, t where t.txt ~* p.match order by p.sort limit 1
$$;

alter table os.growth_settings add column if not exists weekly_recap boolean not null default true;

-- Mondays: one plain email per business owner. Quiet weeks still get one, with what to do next.
create or replace function os.weekly_recap() returns int language plpgsql security definer set search_path = os as $$
declare b record; n int := 0; w record; app text; txt text; idea text; waiting int; openq int; inq int; sent int; posts int; spend numeric; wk text; stats text;
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

    stats := concat_ws(E'\n',
      case when w.jobs > 0 then 'Jobs won: ' || w.jobs || case when w.job_usd > 0 then ' ($' || to_char(w.job_usd, 'FM999,999,990') || ')' else '' end end,
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
      || case when b.status = 'setup' then E'Your team hasn''t been started yet. Open your dashboard and tap Start team.\n'
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
end $$;

-- New trials: day 1 if the team was never started; day 3 with the setup steps still missing.
create or replace function os.trial_nudges() returns int language plpgsql security definer set search_path = os as $$
declare b record; n int := 0; app text; todo text; mail boolean; fb boolean; cust int; rl text; quotes int; started timestamptz;
begin
  app := coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'OS_APP_URL'), '');
  for b in select * from os.businesses where trial_ends_at > now() and not trial_converted and status <> 'archived' loop
    started := b.trial_ends_at - interval '14 days';
    if b.status = 'setup' and now() between started + interval '20 hours' and started + interval '3 days' then
      perform os.alert(b.id, 'business', 'trial_nudge', 'Your team is ready to start',
        'Your Destiny OS team for ' || b.name || E' is set up and waiting. Nothing runs until you say so.\n\n'
        || E'Open your dashboard and tap Start team. They begin on their next work hour, and nothing goes out without your OK.\n\n' || app || '/app',
        'nudge1:' || b.id);
      n := n + 1;
    end if;
    if now() between started + interval '3 days' and started + interval '5 days' then
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
      perform os.alert(b.id, 'business', 'trial_nudge', 'A few steps to get more from your trial',
        'You''re 3 days into your free trial for ' || b.name || E'. These steps make the biggest difference:\n\n' || todo
        || E'\n\nEach takes a couple of minutes: ' || app || '/app',
        'nudge3:' || b.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

select cron.schedule('os-weekly', '23 13 * * 1', 'select os.weekly_recap()') where not exists (select 1 from cron.job where jobname = 'os-weekly');
select cron.schedule('os-trial-nudges', '37 * * * *', 'select os.trial_nudges()') where not exists (select 1 from cron.job where jobname = 'os-trial-nudges');
