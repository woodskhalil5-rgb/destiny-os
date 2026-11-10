-- 0055: acquisitions setup no longer imposes a pricing rule. It adds only what every buyer shares: property records,
-- deal stages, the deal calculator fields (cash or seller financing), the own-phone call sheet, and the legal rules for
-- listing agents vs homeowners. HOW they buy is the business's own strategy in its Rules or Facts; the bots follow that.
drop function if exists os.setup_acquisitions(text, int);
create or replace function os.setup_acquisitions(p_slug text) returns text
language plpgsql security definer set search_path = os as $$
declare b os.businesses; n int := 0;
  rules text := 'ACQUISITIONS: this business buys houses. '
    || 'BUYING STRATEGY: follow the owner''s own strategy in the business rules and facts: how they structure offers (cash, seller financing, '
    || 'lender funding, offering at or above asking, etc.), what they will pay and what they bring to closing. Never invent a strategy or a price '
    || 'formula of your own; if the strategy doesn''t cover something, ask the owner. '
    || 'WHO WE CONTACT: LISTING AGENTS are businesses; email and call them from their published business contacts about their listings. '
    || 'HOMEOWNERS are consumers; never cold text or cold email them and never contact them from scraped or bought lists. Homeowners come in '
    || 'through the website form, ads and mail the owner approves; reply fast to those. The human caller may phone homeowners only from lists '
    || 'the owner provides and has checked against the Do Not Call registry, 8am to 9pm their time, and stops at the first "no". '
    || 'RECORDS: each house is a record of type "property" (title = street address, city) with data: address, list_price, beds, baths, sqft, '
    || 'days_on_market, agent_name, agent_phone, agent_email, source. Stages (status): found, checked, contacted, offer sent, under contract, closed, dead. '
    || 'DEAL NUMBERS (the calculator on each property): data.offer_mode = "cash" (arv, repairs, fee, offer_pct, max_offer) or "seller_finance" '
    || '(price, down, rate, years, rent, costs, emd, appraisal); pick the mode the strategy uses.';
begin
  select * into b from os.businesses where slug = p_slug;
  if b.id is null then raise exception 'No business with slug %', p_slug; end if;

  update os.business_config set config = coalesce(config, '{}'::jsonb)
    || jsonb_build_object('call_sheet', 'own_phone', 'call_sheet_country', '1', 'kind', 'acquisitions')
    || jsonb_build_object('record_types', coalesce(config->'record_types', '{}'::jsonb) || jsonb_build_object('property', jsonb_build_object(
         'stages', jsonb_build_array('found', 'checked', 'contacted', 'call planned', 'offer sent', 'under contract', 'closed', 'dead'),
         'description', 'a house we might buy')))
  where business_id = b.id and active;

  update os.business_agents set role_instructions = role_instructions || E'\n\n' || rules
    || case slot
      when 'research' then ' YOUR PART: find listings and their listing agents in the target areas that fit the strategy''s criteria, and save each as a property record with the agent''s published contacts.'
      when 'analysis' then ' YOUR PART: check each property against the strategy and fill its deal numbers in the strategy''s mode (cash: after-repair value from 3 recent nearby sales, saved in data.comps, and repairs; seller financing: the terms the strategy offers and expected rent from comparable rentals). Move it to "checked" and flag the best fits.'
      when 'production' then ' YOUR PART: for checked properties, write the email to the listing agent pitching the offer the strategy makes (for seller financing: the price, down payment, rate and term), never more than the strategy allows, and queue it with request_approval; write a call plan in data.call_plan when a call is the next step and set status "call planned".'
      when 'coordination' then ' YOUR PART: keep the pipeline moving: follow up offers after 2 and 5 days, tell the owner the moment a property hits "under contract", and put found / checked / offers sent / under contract counts in the daily report.'
      else ''
    end
  where business_id = b.id and role_instructions not like '%ACQUISITIONS: this business buys houses.%';
  get diagnostics n = row_count;
  return format('%s set up for acquisitions (%s agents updated, call sheet on).', b.name, n);
end $$;
revoke all on function os.setup_acquisitions(text) from public;

create or replace function os.auto_acquisitions() returns integer language plpgsql security definer set search_path = os as $$
declare r record; n int := 0;
begin
  for r in select b.slug from os.businesses b join os.business_config c on c.business_id = b.id and c.active
    where b.status <> 'archived' and c.config->>'kind' is null
      and (coalesce(c.config->>'mission', '') || ' ' || coalesce(c.config->>'facts', '') || ' ' || coalesce(c.config->>'rules', '')) ~* '(we buy (houses|homes)|buy(ing)? (houses|homes|properties|real estate)|wholesal(e|er|ers|ing) (real estate|houses|homes|properties)|house flip|fix[ -]and[ -]flip|flipping (houses|homes)|real estate invest|off[ -]market (houses|homes|properties|deals)|motivated sellers|seller financ|creative financ|subject[ -]to (deals|the existing))'
      and (select count(*) from os.business_agents a where a.business_id = b.id) >= 4
  loop
    perform os.setup_acquisitions(r.slug);
    insert into os.messages (business_id, sender, body, status)
      select id, 'system', '@demarcus This business buys houses, so the acquisitions setup is on: property records with a deal calculator (cash or seller financing), deal stages, the own-phone call sheet, and the rules for listing agents vs homeowners. Follow the owner''s own buying strategy in Rules and Facts; if it isn''t written down yet, ask the owner for it.', 'queued'
      from os.businesses where slug = r.slug;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function os.auto_acquisitions() from public;
