-- Destiny OS gets its own team: an internal business ("Destiny Marketing Group", slug destiny-os) whose DeMarcus and
-- Kole handle the platform's own website. "Talk to us" messages become inquiries on its board (Kole drafts the reply
-- for the owner's OK; DeMarcus's hourly inquiry check makes sure none sit unanswered), and every self sign-up is logged
-- as a lead DeMarcus follows until they pay their first month and start. The owner still gets the emails as before.
-- No platform fee; AI usage is capped at $100 a month ($5 a day).

insert into os.businesses (slug, name, status, timezone, shift_start, shift_end, shift_days, plan, platform_fee_usd, markup_pct,
  monthly_budget_usd, billing_status, pay_to_start)
values ('destiny-os', 'Destiny Marketing Group', 'live', 'America/New_York', 9, 18, array[1,2,3,4,5], 'internal', 0, 30, 100, 'none', false)
on conflict (slug) do nothing;

insert into os.business_config (business_id, version, config, note, created_by, active)
select b.id, 1, jsonb_build_object(
  'mission', 'Grow Destiny OS: turn people who contact us or sign up on app.destinymarketinggroup.com into paying businesses, and answer every one of them fast.',
  'facts', $f$Destiny OS gives a small local business (mostly home services) an AI office team of six, at app.destinymarketinggroup.com; it works on a phone like an app. Each business has its own team, data and billing, kept completely separate.
The team: James (research), Emily (analysis), Kole (writing), DeMarcus (coordination), Grayson (Facebook posts and Reels from the owner's photos and videos), Nora (money: invoices, payment reminders, jobs won).
What it does: answers new inquiries fast (web form, website-form emails, lead services; the owner gets an alert and Kole drafts the reply); follows up every quote on day 2, 5 and 10 and stops when it's marked won or lost; logs invoices and drafts payment reminders when one is late ("Got paid" stops them); asks happy customers for Google reviews; sends seasonal emails to past customers with an unsubscribe link; publishes approved Facebook posts; a phone line with a call list and a virtual assistant for missed calls, if connected; a morning message, a Monday recap, push notifications and one-tap approvals by email.
Price: $650 a month, plus AI usage at cost plus 30%, plus phone (a per-minute fee and a fee per number) if used. No free trial: the first 30 days are paid up front through Stripe and the team starts once that's paid; after that a bill on the 1st, the first month prorated. Cancel any time from the Money tab; the team keeps working until the paid time runs out.
Sign up: https://app.destinymarketinggroup.com/trial. Questions: admin@destinymarketinggroup.com.$f$,
  'rules', $r$Nothing is sent, posted or spent without the owner's OK. No invented facts or numbers. No texting, and no contacting consumers from scraped lists. Never mention or share one business's data with another.
When pitching, say: never miss an inquiry, quotes don't go cold, get paid faster, more reviews, nothing goes out without your OK, cancel any time. Never promise specific results, automatic calls or texts, or a free trial (there is none). If you don't know an answer, say Khalil will follow up.$r$,
  'owner', jsonb_build_object('name', 'Khalil', 'email', 'admin@destinymarketinggroup.com'),
  'record_types', jsonb_build_object(
    'inquiry', jsonb_build_object('stages', jsonb_build_array('new', 'contacted', 'handled'), 'description', 'someone who wrote in through "Talk to us" on the Destiny OS website'),
    'lead', jsonb_build_object('stages', jsonb_build_array('signed up', 'paid', 'started', 'lost'), 'description', 'a business that signed up for Destiny OS')),
  'approvals', jsonb_build_object('email', jsonb_build_object('agent_can_approve_after', 5, 'daily_limit', 15), 'publish', '{}'::jsonb),
  'tool_packs', '[]'::jsonb), 'Destiny OS own team (migration 0042)', 'migration', true
from os.businesses b where b.slug = 'destiny-os'
  and not exists (select 1 from os.business_config c where c.business_id = b.id);

insert into os.business_agents (business_id, slot, enabled, role_instructions)
select b.id, x.slot, x.enabled, x.ri from os.businesses b, (values
  ('coordination', true, 'You own the Destiny OS website inbox. Every "Talk to us" message is an inquiry: make sure Kole drafts a reply the same day and the owner approves it. Every sign-up is a lead: check daily whether they have paid their first month and started their team, and tell the owner in one line who is stuck. Keep the owner''s day short: one report at the end of the shift.'),
  ('production', true, 'Draft short, warm replies to people who wrote in through "Talk to us", from our facts only, offering a quick call with Khalil. Queue every email with request_approval; never send on your own.'),
  ('research', true, 'Only when the owner or DeMarcus asks: research a business that wrote in or signed up (what they do, where, their website) so replies can be personal. Don''t build prospect lists unless the owner asks.'),
  ('analysis', true, 'Only when asked: check the facts in Kole''s drafts against our facts and rules before they go to the owner.'),
  ('finance', true, 'Only when asked: say which sign-ups have paid their first month and which haven''t.'),
  ('media', false, '')
) as x(slot, enabled, ri)
where b.slug = 'destiny-os'
on conflict (business_id, slot) do nothing;

-- "Talk to us" -> an inquiry on the Destiny OS board.
create or replace function os.contact_to_inquiry() returns trigger language plpgsql security definer set search_path = os as $$
declare bid uuid; rid bigint;
begin
  select id into bid from os.businesses where slug = 'destiny-os' and status <> 'archived';
  if bid is null then return new; end if;
  insert into os.records (business_id, type, status, title, data, created_by, next_step, next_step_due)
  values (bid, 'inquiry', 'new', left(new.name, 100), jsonb_build_object('name', new.name, 'business', new.business, 'email', new.email,
      'phone', new.phone, 'message', left(new.message, 3000), 'source', 'Destiny OS website (Talk to us)', 'contact_request_id', new.id,
      'received_at', now()), 'form', 'answer today', current_date)
  returning id into rid;
  insert into os.messages (business_id, sender, body, record_id) values (bid, 'system',
    '@kole New "Talk to us" message #' || rid || ' from ' || new.name || ' (' || new.business || ', ' || new.email
      || coalesce(' · ' || new.phone, '') || '): "' || left(new.message, 1500) || '" Draft a short, friendly reply to ' || new.email
      || ' now and queue it with request_approval (kind email, record_id ' || rid || '). Answer only from our facts and offer a quick call with Khalil. @demarcus make sure it''s answered today.',
    rid);
  return new;
exception when others then
  return new; -- never lose the message itself because of this
end $$;
drop trigger if exists contact_to_inquiry on os.contact_requests;
create trigger contact_to_inquiry after insert on os.contact_requests for each row execute function os.contact_to_inquiry();

-- A self sign-up -> a lead on the Destiny OS board. Test sign-ups (names starting "TEST") are skipped.
create or replace function os.signup_to_lead() returns trigger language plpgsql security definer set search_path = os as $$
declare bid uuid; b os.businesses; rid bigint;
begin
  if new.version <> 1 or new.note is distinct from 'free trial sign-up' then return new; end if;
  select * into b from os.businesses where id = new.business_id;
  if b.id is null or b.name ilike 'test%' then return new; end if;
  select id into bid from os.businesses where slug = 'destiny-os' and status <> 'archived';
  if bid is null or bid = b.id then return new; end if;
  insert into os.records (business_id, type, status, title, data, created_by, next_step, next_step_due)
  values (bid, 'lead', 'signed up', left(b.name, 100), jsonb_build_object('signed_up_business_id', b.id, 'slug', b.slug,
      'owner', new.config->'owner', 'source', 'Destiny OS sign-up', 'received_at', now()),
    'form', 'check they paid their first month and started', current_date + 2)
  returning id into rid;
  insert into os.messages (business_id, sender, body, record_id) values (bid, 'system',
    '@demarcus New sign-up #' || rid || ': ' || b.name || coalesce(' (' || (new.config->'owner'->>'email') || ')', '')
      || '. Track them until they pay their first month and start their team; tell the owner if they haven''t in 2 days.', rid);
  return new;
exception when others then
  return new; -- never block a sign-up because of this
end $$;
drop trigger if exists signup_to_lead on os.business_config;
create trigger signup_to_lead after insert on os.business_config for each row execute function os.signup_to_lead();
