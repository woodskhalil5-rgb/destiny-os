-- 0067 (Nov 11 2026): Destiny OS for real estate agents (a DMG product, sold by Celeste). A sign-up whose business is a
-- realtor / agent / brokerage gets the realtor setup automatically once its team is built (same pattern as acquisitions):
-- lead and listing records with stages, the own-phone call sheet, and the rules that keep an agent's marketing legal.
create or replace function os.setup_realtor(p_slug text) returns text language plpgsql security definer set search_path = os as $function$
declare b os.businesses; n int := 0;
  rules text := 'REAL ESTATE AGENT: this business is a licensed real estate agent or brokerage. '
    || 'ADVERTISING RULES (every post, email, ad and flyer): show the agent''s licensed (legal) name and the broker''s business name, '
    || 'and when an agent''s own phone or email appears, the brokerage office phone too. The agent''s broker must be able to approve marketing: '
    || 'everything waits for the owner''s OK, and remind them their broker''s policy may require broker sign-off. '
    || 'Never promise a sale price, a time to sell or a result. Never market another agent''s listing as this agent''s own; use only this '
    || 'agent''s listings and sales, and public market statistics with their source. '
    || 'FAIR HOUSING: describe the property, never the people. Never mention or hint at race, religion, national origin, sex, disability, '
    || 'familial status, age, sexual orientation or similar, and no steering ("perfect for young families", "safe area", "great schools" as a selling '
    || 'point for a type of buyer). If asked about schools or crime, point people to official public sources. '
    || 'WHO WE CONTACT: people who asked (inquiries, open-house sign-ins, website forms) and the agent''s own past clients and sphere. Never cold text, '
    || 'never contact anyone from bought or scraped lists, honour every opt-out at once. Calls only from lists the owner provides, checked '
    || 'against the Do Not Call registry, 8am to 9pm their time. '
    || 'REVIEWS: ask real clients after a closing; never write, edit or pay for reviews. '
    || 'RECORDS: each person is a record of type "lead" (title = name) with data: phone, email, side (buyer/seller), area, price_range, timeline, '
    || 'source. Stages: new, contacted, appointment, signed, under contract, closed, lost. Each of the agent''s listings is a record of type '
    || '"listing" (title = street address, town) with data: list_price, beds, baths, sqft, status_date, link. Stages: coming soon, active, '
    || 'under contract, sold, withdrawn.';
begin
  select * into b from os.businesses where slug = p_slug;
  if b.id is null then raise exception 'No business with slug %', p_slug; end if;
  update os.business_config set config = coalesce(config, '{}'::jsonb)
    || jsonb_build_object('call_sheet', 'own_phone', 'call_sheet_country', '1', 'kind', 'realtor')
    || jsonb_build_object('record_types', coalesce(config->'record_types', '{}'::jsonb)
         || jsonb_build_object('lead', jsonb_build_object('stages', jsonb_build_array('new', 'contacted', 'call planned', 'appointment', 'signed', 'under contract', 'closed', 'lost'),
              'description', 'a buyer or seller who reached out, or a past client'))
         || jsonb_build_object('listing', jsonb_build_object('stages', jsonb_build_array('coming soon', 'active', 'under contract', 'sold', 'withdrawn'),
              'description', 'one of the agent''s own listings')))
  where business_id = b.id and active;
  update os.business_agents set role_instructions = role_instructions || E'\n\n' || rules
    || case slot
      when 'research' then ' YOUR PART: once a week, pull public market numbers for the agent''s areas (median price, days on market, homes for sale) with the source, for posts and seller check-ins. Never copy other agents'' listings or photos.'
      when 'analysis' then ' YOUR PART: speed to lead: the moment a new lead arrives, score it (side, timeline, price range), draft the first reply for approval and, if they gave a phone number, a call plan in data.call_plan with status "call planned". Flag leads with no reply after 24 hours.'
      when 'production' then ' YOUR PART: write the follow-ups (day 1, 3, 7, then monthly for 6 months), "just listed" and "just sold" emails to the agent''s sphere, and monthly home-value check-ins for past clients. Every piece goes through request_approval.'
      when 'media' then ' YOUR PART: 3 to 4 posts a week for the agent''s pages: their own listings (just listed, open house, just sold), local market numbers with the source, and buyer/seller tips. Every post shows the agent''s licensed name and brokerage.'
      when 'coordination' then ' YOUR PART: keep leads moving: no lead waits more than a day, after every closing ask the client for a review (approval first), and put new leads / appointments / signed / under contract / closed counts in the daily report.'
      when 'finance' then ' YOUR PART: track each deal the agent reports: sale price, commission rate and split as the owner gives them, expected pay date. Never guess commission figures.'
      else ''
    end
  where business_id = b.id and enabled and role_instructions not like '%REAL ESTATE AGENT: this business is a licensed%';
  get diagnostics n = row_count;
  return format('%s set up for real estate agents (%s agents updated, call sheet on).', b.name, n);
end $function$;
revoke all on function os.setup_realtor(text) from public, anon, authenticated;

-- Runs every 10 minutes: new sign-ups that are agents (not investors) get the realtor setup once their team is built.
create or replace function os.auto_realtor() returns integer language plpgsql security definer set search_path = os as $function$
declare r record; n int := 0; t text;
begin
  for r in select b.id, b.slug, c.config from os.businesses b join os.business_config c on c.business_id = b.id and c.active
    where b.status <> 'archived' and c.config->>'kind' is null
      and (select count(*) from os.business_agents a where a.business_id = b.id) >= 4
      and not exists (select 1 from os.business_agents a where a.business_id = b.id and a.enabled and coalesce(a.role_instructions, '') = '')
  loop
    t := coalesce(r.config->>'mission', '') || ' ' || coalesce(r.config->>'facts', '');
    continue when t !~* '(realtor|real estate (agent|salesperson|broker|brokerage|team)|listing agent|buyer.?s agent|licensed (agent|salesperson)|brokerage|help (people|clients|families) (buy|sell) (homes|houses))';
    continue when t ~* '(we buy (houses|homes)|wholesal|fix[ -]and[ -]flip|seller financ|creative financ|real estate invest)';
    perform os.setup_realtor(r.slug);
    insert into os.messages (business_id, sender, body, status) values (r.id, 'system',
      '@demarcus This business is a real estate agent, so the realtor setup is on: lead and listing records with stages, the own-phone call sheet, speed-to-lead follow-ups, and the advertising and fair-housing rules every post and email must follow. Ask the owner for their licensed name, brokerage name and office phone if they are not in the facts yet.', 'queued');
    n := n + 1;
  end loop;
  return n;
end $function$;
revoke all on function os.auto_realtor() from public, anon, authenticated;
select cron.unschedule('os-auto-realtor') where exists (select 1 from cron.job where jobname = 'os-auto-realtor');
select cron.schedule('os-auto-realtor', '*/10 * * * *', 'select os.auto_realtor()');

-- Celeste (DMG's CEO) sells it.
update os.business_agents set role_instructions = role_instructions || E'\n\nPRODUCT (Nov 11 2026): Destiny OS for real estate agents. Realtors sign up at /trial and pick "Real estate agent / Realtor"; their team is set up for speed-to-lead follow-ups, listing and just-sold posts, past-client check-ins and review requests, with New Jersey advertising and fair-housing rules built in. Flat monthly price only: never a per-lead fee or a share of commission (New Jersey bars licensees from paying unlicensed people for referrals).'
where slot = 'executive' and business_id = (select id from os.businesses where slug = 'destiny-os')
  and role_instructions not like '%Destiny OS for real estate agents%';
