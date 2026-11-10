-- 0056: invite offers for sign-up pages (first one: /acquisitions, $200/month founding price for house buyers).
-- A sign-up whose "type of business" equals an offer's industry tag gets that offer's monthly fee the moment the owner is
-- added, while the offer has uses left. Their "how you buy" answer is kept and written into the business's Rules as its
-- buying strategy once the team's setup has finished (os.auto_acquisitions), so the bots follow their strategy, not ours.
create table if not exists os.signup_offers (
  tag text primary key,             -- matched against the sign-up's "type of business"
  fee_usd numeric not null check (fee_usd >= 0),
  max_uses int not null default 5,
  uses int not null default 0,
  expires_at timestamptz,
  note text
);
create table if not exists os.signup_offer_uses (
  business_id uuid primary key references os.businesses(id) on delete cascade,
  tag text not null references os.signup_offers(tag),
  strategy text,
  strategy_applied boolean not null default false,
  created_at timestamptz not null default now()
);
alter table os.signup_offers enable row level security;
alter table os.signup_offer_uses enable row level security;
revoke all on os.signup_offers, os.signup_offer_uses from anon, authenticated;

insert into os.signup_offers (tag, fee_usd, max_uses, expires_at, note)
values ('Real estate investing (acquisitions)', 200, 5, now() + interval '90 days', 'Founding price for the /acquisitions invite page (Jason and Jared first)')
on conflict (tag) do nothing;

create or replace function os.apply_signup_offer() returns trigger language plpgsql security definer set search_path = os as $$
declare em text; d jsonb; o os.signup_offers;
begin
  if new.role <> 'owner' then return new; end if;
  select lower(email) into em from auth.users where id = new.user_id;
  select details into d from os.trial_signups where lower(email) = em and used and created_at > now() - interval '2 hours' order by id desc limit 1;
  if d is null then return new; end if;
  select * into o from os.signup_offers where tag = d->>'industry' and uses < max_uses and (expires_at is null or expires_at > now()) for update;
  if o.tag is null or exists (select 1 from os.signup_offer_uses where business_id = new.business_id) then return new; end if;
  update os.businesses set platform_fee_usd = o.fee_usd
    where id = new.business_id and plan = 'customer' and fee_paid_until is null and created_at > now() - interval '10 minutes';
  if not found then return new; end if;
  update os.signup_offers set uses = uses + 1 where tag = o.tag;
  insert into os.signup_offer_uses (business_id, tag, strategy) values (new.business_id, o.tag, nullif(trim(d->>'offer'), ''));
  insert into os.activity_log (business_id, actor_type, actor, action, target, details)
    values (new.business_id, 'system', 'signup', 'signup_offer', o.tag, jsonb_build_object('fee_usd', o.fee_usd));
  return new;
end $$;
drop trigger if exists signup_offer on os.business_members;
create trigger signup_offer after insert on os.business_members for each row execute function os.apply_signup_offer();

-- Acquisitions auto-setup waits until the team's own setup has finished (every teammate has instructions), so the setup
-- that writes the team's jobs from the sign-up answers can't overwrite it. Invite sign-ups are set up even without the
-- keywords, and their "how you buy" answer goes into Rules first.
create or replace function os.auto_acquisitions() returns integer language plpgsql security definer set search_path = os as $$
declare r record; n int := 0;
begin
  for r in select b.id, b.slug, u.strategy, u.strategy_applied, u.business_id is not null as invited
    from os.businesses b join os.business_config c on c.business_id = b.id and c.active
    left join os.signup_offer_uses u on u.business_id = b.id
    where b.status <> 'archived' and c.config->>'kind' is null
      and ((coalesce(c.config->>'mission', '') || ' ' || coalesce(c.config->>'facts', '') || ' ' || coalesce(c.config->>'rules', '')) ~* '(we buy (houses|homes)|buy(ing)? (houses|homes|properties|real estate)|wholesal(e|er|ers|ing) (real estate|houses|homes|properties)|house flip|fix[ -]and[ -]flip|flipping (houses|homes)|real estate invest|off[ -]market (houses|homes|properties|deals)|motivated sellers|seller financ|creative financ|subject[ -]to (deals|the existing))'
           or u.tag = 'Real estate investing (acquisitions)')
      and (select count(*) from os.business_agents a where a.business_id = b.id) >= 4
      and not exists (select 1 from os.business_agents a where a.business_id = b.id and coalesce(a.role_instructions, '') = '')
  loop
    if r.invited and r.strategy is not null and not r.strategy_applied then
      update os.business_config set config = jsonb_set(config, '{rules}', to_jsonb(coalesce(config->>'rules', '')
        || E'\n\nBUYING STRATEGY (from the owner, edit any time): ' || r.strategy))
        where business_id = r.id and active;
      update os.signup_offer_uses set strategy_applied = true where business_id = r.id;
    end if;
    perform os.setup_acquisitions(r.slug);
    insert into os.messages (business_id, sender, body, status)
      values (r.id, 'system', '@demarcus This business buys houses, so the acquisitions setup is on: property records with a deal calculator (cash or seller financing), deal stages, the own-phone call sheet, and the rules for listing agents vs homeowners. Follow the owner''s own buying strategy in Rules; if it isn''t written down yet, ask the owner for it.', 'queued');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function os.auto_acquisitions() from public;
revoke all on function os.apply_signup_offer() from public;

-- Founding price lowered to $100/month until the first deal closes; then pricing is set on a call.
update os.signup_offers set fee_usd = 100, note = 'Founding price for /acquisitions: $100/month until the first deal closes, then pricing on a call' where tag = 'Real estate investing (acquisitions)';
alter table os.signup_offer_uses add column if not exists first_close_at timestamptz;
create or replace function os.first_deal_closed() returns trigger language plpgsql security definer set search_path = os as $$
declare u os.signup_offer_uses; bname text;
begin
  if new.status is distinct from 'closed' or old.status = 'closed' or new.type <> 'property' then return new; end if;
  select * into u from os.signup_offer_uses where business_id = new.business_id and first_close_at is null for update;
  if u.business_id is null then return new; end if;
  update os.signup_offer_uses set first_close_at = now() where business_id = new.business_id;
  select name into bname from os.businesses where id = new.business_id;
  perform os.alert(new.business_id, 'platform', 'first_deal_closed', 'First deal closed: ' || bname,
    bname || ' closed its first deal (' || new.title || '). Their founding price ($100/month) was until now; set up the pricing call with them.', 'firstclose:' || new.business_id);
  insert into os.messages (business_id, sender, body, status) values (new.business_id, 'system',
    'Congratulations on closing your first deal (' || new.title || ')! Your founding price covered the time up to now. Our team will reach out to set up a short call about your plan going forward.', 'handled');
  return new;
end $$;
revoke all on function os.first_deal_closed() from public;
drop trigger if exists first_deal_closed on os.records;
create trigger first_deal_closed after update of status on os.records for each row execute function os.first_deal_closed();
