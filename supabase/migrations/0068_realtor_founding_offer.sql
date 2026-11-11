-- 0068 (Nov 11 2026): founding price for realtors, $500/month for the first 5 (standard is $650). Sign-ups from /realtors
-- or /trial with "Real estate agent / Realtor" get it. When any founding offer is used up, Khalil gets an alert: for
-- realtors that is the signal to raise the price and start the agent directory with sponsored spots.
insert into os.signup_offers (tag, fee_usd, max_uses, uses, expires_at, note)
values ('Real estate agent / Realtor', 500, 5, 0, now() + interval '180 days',
  'Founding price for realtors (/realtors and /trial): $500/month for the first 5 agents, then the standard price ($650)')
on conflict (tag) do nothing;

create or replace function os.offer_used_up() returns trigger language plpgsql security definer set search_path = os as $$
begin
  if new.uses >= new.max_uses and old.uses < old.max_uses then
    perform os.alert(null, 'platform', 'offer_used_up', 'Founding offer full: ' || new.tag,
      'All ' || new.max_uses || ' founding spots for "' || new.tag || '" ($' || new.fee_usd || '/month) are taken. New sign-ups now get the standard price.'
      || case when new.tag = 'Real estate agent / Realtor' then E'\n\nYour plan: raise the realtor price and start the agent directory with sponsored spots. Tell Sean.' else '' end,
      'offer_full:' || new.tag);
  end if;
  return new;
end $$;
revoke all on function os.offer_used_up() from public, anon, authenticated;
drop trigger if exists offer_used_up on os.signup_offers;
create trigger offer_used_up after update of uses on os.signup_offers for each row execute function os.offer_used_up();

update os.business_agents set role_instructions = role_instructions || E' Founding price: $500 a month for the first 5 realtors (standard $650), sign-up page /realtors. Once 5 are paying, the price goes up and the agent directory with sponsored spots comes next.'
where slot = 'executive' and business_id = (select id from os.businesses where slug = 'destiny-os')
  and role_instructions like '%Destiny OS for real estate agents%' and role_instructions not like '%first 5 realtors%';
