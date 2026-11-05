-- DMG Kenya: Destiny Marketing Group's Kenya division (internal plan, no platform fee). Roofing in Nairobi first.
-- Starts in setup; nothing runs until Start team is clicked.
do $$
declare bid uuid;
begin
  if exists (select 1 from os.businesses where slug = 'dmg-kenya') then return; end if;

  insert into os.businesses (slug, name, status, timezone, shift_start, shift_end, shift_days, plan, platform_fee_usd, markup_pct, monthly_budget_usd)
  values ('dmg-kenya', 'DMG Kenya', 'setup', 'Africa/Nairobi', 8, 18, '{1,2,3,4,5,6}', 'internal', 0, 30, 100)
  returning id into bid;

  insert into os.business_config (business_id, version, config, note, created_by, active) values (bid, 1, jsonb_build_object(
    'mission', $m$DMG Kenya is the Kenya division of Destiny Marketing Group (DMG), a US marketing company. It helps Kenyan home-improvement contractors win more jobs with modern marketing: a strong online presence, social content made from their own work, and a steady flow of customer enquiries. It starts with roofing companies in Nairobi, then other trades and cities once roofing works.$m$,
    'facts', $f$- First market: roofing contractors in Nairobi and its surrounding towns.
- DMG Kenya has a country lead on the ground in Kenya with roofing experience and industry connections. He meets contractors in person and makes the calls. His name and contact details are added by the owner; until then refer to him as "our country lead".
- Services, prices and terms are not set yet. The owner decides them; prices will be in Kenyan shillings (KES).
- DMG's tools: an AI team that researches, writes and schedules content, a media library for contractors' job photos, and Facebook posting for connected Pages.
- Many Kenyan businesses pay by M-Pesa; how DMG Kenya takes payment is not decided yet.$f$,
    'rules', $r$- Never promise a number of leads, jobs, rankings or results. Never invent prices, terms, clients, case studies or reviews: until the owner sets the offer, offers go to the owner as proposals only.
- Contact businesses only, through their own published business contacts (website, business page or listing). Never contact private individuals, and never use bought or scraped lists of people (Kenya Data Protection Act).
- Every outreach email says who we are (DMG Kenya, part of Destiny Marketing Group) and includes a simple way to opt out; anyone who opts out is never contacted again.
- Don't say DMG Kenya has a registered Kenyan company, an office address or a local phone line until the owner confirms it.
- Prices in KES. Plain, respectful English; Swahili only where the owner asks for it.
- Contractors' photos are used only with their permission (marked "cleared" in the media library).
- Everything sent or published goes through approval.$r$,
    'owner', jsonb_build_object('name', 'the boss', 'email', 'admin@destinymarketinggroup.com'),
    'record_types', jsonb_build_object(
      'roofer', jsonb_build_object('stages', jsonb_build_array('found', 'qualified', 'contacted', 'replied', 'meeting', 'signed', 'lost'), 'description', 'a roofing company in Kenya we could work with, with its source, area and public business contacts'),
      'partner', jsonb_build_object('stages', jsonb_build_array('found', 'contacted', 'talking', 'partner', 'passed'), 'description', 'a roofing-material supplier, hardware store, developer or association that could send us contractors')),
    'approvals', jsonb_build_object('email', jsonb_build_object('agent_can_approve_after', 10, 'daily_limit', 10), 'publish', '{}'::jsonb),
    'tool_packs', '[]'::jsonb
  ), 'DMG Kenya setup', 'claude', true);

  insert into os.business_agents (business_id, slot, enabled, role_instructions) values
  (bid, 'research', true, $j$Find roofing companies in Nairobi and nearby towns that are real, active businesses with public business contacts (website, Google listing, Facebook or Instagram business page, directories). Save 5 to 8 roofer records per run with: area, roofing types they do (mabati/iron sheets, tiles, waterproofing, gutters), their public phone/email/page, links, and what their marketing looks like now. Also research the market once and save_note it: common roofing types and price ranges, how homeowners find roofers, seasons (rains), and the biggest material suppliers. Use recall first. Hand new records to @emily.$j$),
  (bid, 'analysis', true, $e$Qualify each roofer: is it a real, active business, how good is its online presence (no page, weak page, few photos, no reviews), and how much better marketing could help. Mark qualified or lost with the reason. Once you have 15 or more qualified, write the owner a short proposal for DMG Kenya's first offer: 2 or 3 simple packages in KES, based on what you found, clearly marked as a proposal for the owner to decide.$e$),
  (bid, 'production', true, $k$Write first-contact emails to qualified roofers that have a published business email: under 120 words, one real detail about their business, who we are (DMG Kenya, part of Destiny Marketing Group), a light ask (a short meeting with our country lead), and an opt-out line. Never quote prices or promise results until the owner sets the offer. Queue each with request_approval (kind email, payload to/subject/body, record_id).$k$),
  (bid, 'coordination', true, $d$Run the plan. Each morning hand out the day's work. Keep a list of the best roofers for our country lead to visit or call in person (the owner passes it on), and track meetings and signed clients in the records. End of day: report to the owner what was found, what's waiting for approval and what the country lead should do next, then write the notebook.$d$),
  (bid, 'media', true, $g$DMG Kenya's own content: posts that show what good roofing marketing looks like (before-and-after showcases, tips for homeowners in the rainy season, how to choose a roofer) for DMG Kenya's page, plus sample posts we can show a roofer in a meeting. Use contractors' photos only from the media library and only when cleared. Everything goes through approval.$g$),
  (bid, 'distribution', true, $b$Find where Kenyan roofers and homeowners gather online and offline: Facebook groups, LinkedIn, building and construction associations, trade fairs, and the big roofing-material suppliers and hardware stores that could refer contractors to us. Save them as partner records with a suggested approach; any outreach goes through approval.$b$);

  insert into os.messages (business_id, sender, body, status) values (bid, 'system',
    'DMG Kenya is set up: roofing in Nairobi first, with our country lead on the ground. The team starts when the owner clicks Start team.', 'handled');
  insert into os.activity_log (business_id, actor_type, actor, action, target) values (bid, 'system', 'setup', 'create_business', 'dmg-kenya');
end $$;
