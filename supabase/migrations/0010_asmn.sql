-- Autonomous Sports Media Network (ASMN): the owner's own business (internal plan, no platform fee).
-- Starts in setup; nothing runs until Start team is clicked.
do $$
declare bid uuid;
begin
  if exists (select 1 from os.businesses where slug = 'asmn') then return; end if;

  insert into os.businesses (slug, name, status, timezone, shift_start, shift_end, shift_days, plan, platform_fee_usd, markup_pct, monthly_budget_usd)
  values ('asmn', 'Autonomous Sports Media Network', 'setup', 'America/New_York', 8, 24, '{1,2,3,4,5,6,7}', 'internal', 0, 30, 200)
  returning id into bid;

  insert into os.business_config (business_id, version, config, note, created_by, active) values (bid, 1, jsonb_build_object(
    'mission', $m$ASMN (Autonomous Sports Media Network) is an AI-powered sports media company that researches, creates, publishes and analyzes sports content across social media with minimal human involvement. It runs several independent sports brands (NBA, NFL, MLB, NHL, soccer, UFC and more), each with its own audience and identity, on one shared team. Mission: build a scalable, largely self-operating sports media company that earns money from audience growth, platform monetization, sponsorships and partnerships. Vision: a network that runs around the clock without the owners managing daily publishing.$m$,
    'facts', $f$- Brands: one per league or sport (NBA, NFL, MLB, NHL, soccer, UFC to start). Brand names, handles and voices are set by the owner; until then refer to them by sport (e.g. "the NBA brand").
- Each brand has its own audience and voice. The team, research and tools are shared.
- Revenue comes from platform monetization programs, sponsorships, partnerships and affiliate deals. Nothing is sold or promised without the owner's approval.
- Publishing: approved content is posted automatically only where a platform is connected under Connections; everything else is posted by hand from the Content tab.
- The team cannot see platform analytics directly yet. Performance numbers come from the owner.$f$,
    'rules', $r$- Every score, stat, quote, injury, trade or signing comes from a reliable named source (league or team sites, official box scores, established outlets) checked that day, with the link saved on the story. If it can't be verified, it doesn't go out.
- Rumors only as reports, naming who reported them ("per ESPN"). Never invent "sources say", insider info or breaking news.
- Quotes are verbatim and sourced. Never put words in a real athlete's, coach's or official's mouth, and never pose as them.
- Brands are independent fan and media brands: never imply they are affiliated with, or endorsed by, a league, team or player.
- Original work only: our own text, graphics and commentary. No league or team logos, broadcast footage, highlight clips, or other people's photos or videos.
- No betting picks unless the owner turns betting content on. If he does: never "locks" or guarantees, 21+ only, with a responsible-gambling line.
- Sponsored or affiliate content is clearly labeled (#ad or "Paid partnership").
- No slurs, harassment, or jokes about injuries, health, families or personal lives. Keep the trash talk about the game.
- Tailor every post to its brand and platform; never paste the same text across brands.
- Everything published, and every outreach email, goes through approval. Sponsor and partner outreach only to a company's published business contact.$r$,
    'owner', jsonb_build_object('name', 'the boss', 'email', 'admin@destinymarketinggroup.com'),
    'record_types', jsonb_build_object(
      'brand', jsonb_build_object('stages', jsonb_build_array('planned', 'launching', 'active', 'paused'), 'description', 'one of the network''s sports brands (one per league or sport)'),
      'story', jsonb_build_object('stages', jsonb_build_array('found', 'verified', 'drafted', 'published', 'skipped'), 'description', 'a game, result, news item, trend or angle worth covering, with its source and brand'),
      'sponsor', jsonb_build_object('stages', jsonb_build_array('found', 'qualified', 'drafted', 'contacted', 'replied', 'won', 'lost'), 'description', 'a potential sponsor, partner, affiliate or monetization program')),
    'approvals', jsonb_build_object('email', jsonb_build_object('agent_can_approve_after', 10, 'daily_limit', 10), 'publish', '{}'::jsonb),
    'tool_packs', '[]'::jsonb
  ), 'ASMN setup', 'claude', true);

  insert into os.business_agents (business_id, slot, enabled, role_instructions) values
  (bid, 'research', true, $j$Cover the sports news for every active brand. Each run, check today's games, results, injuries, trades and trending storylines, and save 5 to 8 story records with the source link, the brand, and why fans will care. Use recall first; save_note standing references (schedules, standings and official stats pages). Hand the stories to @emily.$j$),
  (bid, 'analysis', true, $e$Fact-check before anything goes out. Check every score, stat, quote and name in the stories and drafts against their sources. Mark each story verified or skipped, with the reason, and send verified stories to @kole. Weekly: use the performance numbers the owner shares (reach, followers, engagement) to tell @demarcus which brands, formats, topics and posting times are working. If none have been shared, ask the owner for them.$e$),
  (bid, 'production', true, $k$Write the posts. For each verified story, write platform-ready copy in the brand's voice: a short post for X or Threads, a caption for Facebook or Instagram, and a thread or short article when the story is big. save_content with channel = the platform and audience = the brand. Do 5 to 8 per run. Sponsor and partner pitch emails go through request_approval.$k$),
  (bid, 'coordination', true, $d$Run the newsroom. Each morning, set the day's plan for each active brand (what to cover, how many posts, which game-time slots) and hand it out as tasks. Through the day, keep stories and content moving and clear anything stuck. End of day: report to the owner what went out, what's waiting for approval, and any growth or revenue news, then write the notebook.$d$),
  (bid, 'media', true, $g$Visuals and video. For the biggest stories, write graphic briefs (score cards, stat graphics, quote cards using sourced quotes) and 30-60 second video scripts in each brand's style. Schedule approved content (schedule_content) when the brand's audience is online, especially around game times. No league logos or broadcast footage.$g$),
  (bid, 'distribution', true, $b$Growth and money. Find where each brand's fans gather and how to grow there: hashtags, communities, posting times, collaborations with other fan creators. Track how the brands can earn: platform creator programs and their requirements, sponsors that fit each brand (sports bars, apparel, local businesses, sports apps) and affiliate programs. Save sponsors as records; outreach emails go through approval.$b$);

  insert into os.records (business_id, type, status, title, data, owner_slot, created_by) values
  (bid, 'brand', 'planned', 'NBA brand', '{"sport":"basketball","league":"NBA","name":"to be chosen by the owner"}', 'coordination', 'coordination'),
  (bid, 'brand', 'planned', 'NFL brand', '{"sport":"football","league":"NFL","name":"to be chosen by the owner"}', 'coordination', 'coordination'),
  (bid, 'brand', 'planned', 'MLB brand', '{"sport":"baseball","league":"MLB","name":"to be chosen by the owner"}', 'coordination', 'coordination'),
  (bid, 'brand', 'planned', 'NHL brand', '{"sport":"hockey","league":"NHL","name":"to be chosen by the owner"}', 'coordination', 'coordination'),
  (bid, 'brand', 'planned', 'Soccer brand', '{"sport":"soccer","name":"to be chosen by the owner"}', 'coordination', 'coordination'),
  (bid, 'brand', 'planned', 'UFC brand', '{"sport":"MMA","league":"UFC","name":"to be chosen by the owner"}', 'coordination', 'coordination');

  insert into os.messages (business_id, sender, body, status) values (bid, 'system',
    'ASMN is set up: six brands planned (NBA, NFL, MLB, NHL, soccer, UFC). The team starts when the owner clicks Start team.', 'handled');
  insert into os.activity_log (business_id, actor_type, actor, action, target) values (bid, 'system', 'setup', 'create_business', 'asmn');
end $$;
