-- 0054: os.setup_acquisitions(slug), one call that makes a business ready to buy houses (wholesale / flip):
-- own-phone call sheet, deal stages, the offer calculator fields, and the rules for contacting listing agents vs homeowners.
-- Safe to run twice (each instruction block is added once).
create or replace function os.setup_acquisitions(p_slug text, p_pct int default 70) returns text
language plpgsql security definer set search_path = os as $$
declare b os.businesses; n int := 0;
  rules text := 'ACQUISITIONS RULES: we buy houses. Two kinds of people: LISTING AGENTS are businesses; we may email and call them from their '
    || 'published business contacts about their listings (stale, price-reduced, as-is, estate, vacant). HOMEOWNERS are consumers; we never cold '
    || 'text or cold email them and never contact them from scraped or bought lists. Homeowners come in through the website form, ads and mail '
    || 'the owner approves; reply fast to those. The human caller may phone homeowners only from lists the owner provides and has checked against '
    || 'the Do Not Call registry, 8am to 9pm their time, and stops at the first "no". '
    || 'Track each house as a record of type "property" (title = street address, city) with data: address, list_price, beds, baths, sqft, '
    || 'days_on_market, agent_name, agent_phone, agent_email, source. Stages (status): found, checked, contacted, offer sent, under contract, closed, dead.';
begin
  select * into b from os.businesses where slug = p_slug;
  if b.id is null then raise exception 'No business with slug %', p_slug; end if;

  update os.business_config set config = coalesce(config, '{}'::jsonb)
    || jsonb_build_object('call_sheet', 'own_phone', 'call_sheet_country', '1', 'offer_pct', p_pct, 'kind', 'acquisitions')
  where business_id = b.id and active;

  update os.business_agents set role_instructions = role_instructions || E'\n\n' || rules
    || case slot
      when 'research' then ' YOUR PART: find listings and listing agents in the target areas (stale or price-reduced listings first), save each house as a property record with the agent''s published contacts.'
      when 'analysis' then ' YOUR PART: check each property. Estimate the after-repair value from 3 nearby recent sales (save data.arv and data.comps with addresses and prices) and the repairs (data.repairs, with a one-line why). Save data.max_offer = arv x ' || p_pct || '% - repairs - fee (data.fee, default 15000) and move it to "checked". Flag deals where max_offer is within 15% of list price.'
      when 'production' then ' YOUR PART: for checked properties, write the email to the listing agent (short, names the house, asks if the seller would consider a cash offer around max_offer, never states a number above max_offer) and queue it with request_approval; and a call plan in data.call_plan for the caller, then status "call planned" if a call is the next step.'
      when 'coordination' then ' YOUR PART: keep the pipeline moving: follow up offers after 2 and 5 days, tell the owner the moment a property hits "under contract", and put found / checked / offers sent / under contract counts in the daily report.'
      else ''
    end
  where business_id = b.id and role_instructions not like '%ACQUISITIONS RULES:%';
  get diagnostics n = row_count;
  return format('%s set up for acquisitions (%s agents updated, call sheet on, offers at %s%%).', b.name, n, p_pct);
end $$;
revoke all on function os.setup_acquisitions(text, int) from public;
