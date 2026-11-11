-- 0061: Bid Desk collector, matching and morning digest (Nov 10 2026).
-- Bid Desk sells to contractors who are records in a business with config bid_desk = 'on' (Bid Desk itself), so a
-- profile and its matches belong to one contractor record, not to a whole business. 0059's tables were still empty,
-- so they are rebuilt keyed that way.

drop table if exists os.bid_packets, os.bid_matches, os.bid_profiles;

-- Optional details for a contractor (signed clients); prospects are matched from their record's trade and county.
create table os.bid_profiles (
  record_id bigint primary key references os.records(id) on delete cascade,
  business_id uuid not null references os.businesses(id) on delete cascade,
  trades text[] not null default '{}',          -- os.bid_trades words: roofing, hvac, plumbing, electrical, paving, masonry, ...
  counties text[] not null default '{}',
  min_job_usd numeric,
  max_job_usd numeric,
  pwcr_number text,
  pwcr_expires date,
  insurance_expires date,
  njstart_vendor_id text,
  dpmc_classified boolean,
  brc_status text check (brc_status in ('have', 'missing', 'expired', 'unknown')) default 'unknown',
  bonding_limit_usd numeric,
  active boolean not null default true,
  notes text,
  updated_at timestamptz not null default now()
);

create table os.bid_matches (
  id bigint generated always as identity primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  record_id bigint not null references os.records(id) on delete cascade,
  bid_id bigint not null references os.bids(id) on delete cascade,
  fit_score int not null check (fit_score between 0 and 100),
  reason text not null,
  hard_stop text,
  decision text not null default 'pending' check (decision in ('pending', 'pitched', 'pursue', 'pass')),
  decided_at timestamptz,
  outcome text check (outcome in ('submitted', 'won', 'lost', 'not_awarded', 'withdrawn')),
  award_usd numeric,
  created_at timestamptz not null default now(),
  unique (record_id, bid_id)
);
create index bid_matches_biz on os.bid_matches (business_id, decision, created_at desc);

create table os.bid_packets (
  id bigint generated always as identity primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  match_id bigint not null unique references os.bid_matches(id) on delete cascade,
  checklist jsonb not null default '[]',
  drafts jsonb not null default '[]',
  client_price_usd numeric,                  -- entered by the client only
  approval_id bigint references os.approvals(id) on delete set null,
  submitted_at timestamptz,
  submitted_by text,                         -- a person, never an agent
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table os.bid_profiles enable row level security;
alter table os.bid_matches enable row level security;
alter table os.bid_packets enable row level security;
revoke all on os.bid_profiles, os.bid_matches, os.bid_packets from anon, authenticated;

-- New Jersey counties and the counties that border them (a contractor will usually travel one county over).
create table if not exists os.nj_county_near (county text primary key, near text[] not null);
alter table os.nj_county_near enable row level security;
revoke all on os.nj_county_near from anon, authenticated;
insert into os.nj_county_near values
  ('Atlantic', '{Burlington,Camden,Gloucester,Cape May,Cumberland,Ocean}'), ('Bergen', '{Hudson,Passaic,Essex}'),
  ('Burlington', '{Atlantic,Camden,Mercer,Monmouth,Ocean}'), ('Camden', '{Atlantic,Burlington,Gloucester}'),
  ('Cape May', '{Atlantic,Cumberland}'), ('Cumberland', '{Atlantic,Cape May,Gloucester,Salem}'),
  ('Essex', '{Bergen,Hudson,Morris,Passaic,Union}'), ('Gloucester', '{Atlantic,Camden,Cumberland,Salem}'),
  ('Hudson', '{Bergen,Essex,Union}'), ('Hunterdon', '{Mercer,Morris,Somerset,Warren}'),
  ('Mercer', '{Burlington,Hunterdon,Middlesex,Monmouth,Somerset}'), ('Middlesex', '{Mercer,Monmouth,Somerset,Union}'),
  ('Monmouth', '{Burlington,Mercer,Middlesex,Ocean}'), ('Morris', '{Essex,Hunterdon,Passaic,Somerset,Sussex,Union,Warren}'),
  ('Ocean', '{Atlantic,Burlington,Monmouth}'), ('Passaic', '{Bergen,Essex,Morris,Sussex}'), ('Salem', '{Cumberland,Gloucester}'),
  ('Somerset', '{Hunterdon,Mercer,Middlesex,Morris,Union}'), ('Sussex', '{Morris,Passaic,Warren}'),
  ('Union', '{Essex,Hudson,Middlesex,Morris,Somerset}'), ('Warren', '{Hunterdon,Morris,Sussex}')
on conflict (county) do update set near = excluded.near;

-- A contractor's trade (as written on their record) in the words os-bids tags bids with.
create or replace function os.bid_trades(t text) returns text[] language sql immutable as $$
  select array_remove(array[
    case when t ~* 'roof' then 'roofing' end,
    case when t ~* 'heat|cool|hvac|air cond|mechanical' then 'hvac' end,
    case when t ~* 'plumb' then 'plumbing' end,
    case when t ~* 'electric' then 'electrical' end,
    case when t ~* 'pav|asphalt' then 'paving' end,
    case when t ~* 'mason|concrete|hardscap' then 'masonry' end,
    case when t ~* 'hardscap|paver|patio' then 'hardscaping' end,
    case when t ~* 'landscap|lawn|tree' then 'landscaping' end,
    case when t ~* 'paint' then 'painting' end,
    case when t ~* 'window|door' then 'windows_doors' end,
    case when t ~* 'floor' then 'flooring' end,
    case when t ~* 'demo|abatement' then 'demolition' end,
    case when t ~* 'fenc' then 'fencing' end,
    case when t ~* 'clean|janitor' then 'cleaning' end,
    case when t ~* 'pest|extermin' then 'pest' end,
    case when t ~* 'general|contractor|construction|remodel|renovat' then 'general' end
  ]::text[], null)
$$;

-- Match open bids to every contractor on a Bid Desk list. Same trade is required; same county scores highest, a
-- neighbouring county or a statewide bid next. Bids due in under 3 days are skipped (no time to bid).
create or replace function os.bid_match() returns integer language plpgsql security definer set search_path = os as $$
declare n integer;
begin
  with c as (
    select r.id as record_id, r.business_id, r.title, r.status,
      coalesce(nullif(p.trades, '{}'), os.bid_trades(r.data->>'trade')) as trades,
      coalesce(nullif(p.counties, '{}'), array_remove(array[r.data->>'county'], null)) as counties,
      p.min_job_usd, p.max_job_usd, p.dpmc_classified
    from os.records r join os.business_config bc on bc.business_id = r.business_id and bc.active and bc.config->>'bid_desk' = 'on'
    left join os.bid_profiles p on p.record_id = r.id and p.active
    where r.type = 'client' and r.status not in ('lost')
  ), s as (
    select c.*, b.id as bid_id, b.title as bid_title, b.county as bid_county, b.est_value_usd, b.due_at, b.source_id, b.trade_tags as bid_tags,
      case when b.county is null then 'statewide' when b.county = any(c.counties) then 'same'
           when exists (select 1 from os.nj_county_near nz where nz.county = b.county and nz.near && c.counties) then 'near' else 'far' end as place
    from c join os.bids b on b.status = 'open' and b.due_at > now() + interval '3 days' and b.trade_tags && c.trades
  )
  insert into os.bid_matches (business_id, record_id, bid_id, fit_score, reason, hard_stop)
  select business_id, record_id, bid_id,
    least(100, 55 + case place when 'same' then 35 when 'near' then 20 else 10 end
      + case when est_value_usd is not null and (min_job_usd is null or est_value_usd >= min_job_usd) and (max_job_usd is null or est_value_usd <= max_job_usd) then 5 else 0 end),
    initcap(replace(coalesce((select string_agg(t, ', ') from unnest(trades) t where t = any(bid_tags) and t <> 'general'), 'general'), '_', ' & '))
      || ' job' || case place when 'same' then ' in ' || bid_county || ' County, their county' when 'near' then ' in ' || bid_county || ' County, next to theirs' else ' (no county listed)' end
      || coalesce(', est. $' || to_char(est_value_usd, 'FM999,999,999'), '') || ', due ' || to_char(due_at at time zone 'America/New_York', 'Mon FMDD') || '.'
      || case when source_id = (select id from os.bid_sources where url like '%treasury/dpmc%') then ' State building job: bidders need DPMC classification and a PWCR number.' else '' end,
    case when max_job_usd is not null and est_value_usd > max_job_usd then 'Bigger than the jobs they take (max $' || to_char(max_job_usd, 'FM999,999,999') || ').'
         when source_id = (select id from os.bid_sources where url like '%treasury/dpmc%') and dpmc_classified = false then 'Not DPMC classified yet.' end
  from s where place in ('same', 'near', 'statewide')
  on conflict (record_id, bid_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function os.bid_match() from public;

-- Morning digest in each Bid Desk room (7am New York time): new bids that fit someone on the list, best first.
create or replace function os.bid_digest(force boolean default false) returns integer language plpgsql security definer set search_path = os as $$
declare lt timestamp := now() at time zone 'America/New_York'; b record; txt text; k integer := 0; n integer;
begin
  if not force and extract(hour from lt) <> 7 then return 0; end if;
  for b in select bc.business_id from os.business_config bc join os.businesses x on x.id = bc.business_id and x.status = 'live'
           where bc.active and bc.config->>'bid_desk' = 'on' loop
    if not force and exists (select 1 from os.messages where business_id = b.business_id and body like 'BID MATCHES%' and created_at > now() - interval '20 hours') then continue; end if;
    select count(*) into n from os.bid_matches m join os.bids d on d.id = m.bid_id
      where m.business_id = b.business_id and m.decision = 'pending' and d.status = 'open' and d.due_at > now() + interval '3 days';
    if n = 0 then continue; end if;
    select 'BID MATCHES · ' || to_char(lt::date, 'Dy Mon FMDD') || E'\n' || n || ' open public bids fit contractors on your list'
      || coalesce(' (' || nullif((select count(*) from os.bid_matches where business_id = b.business_id and created_at > now() - interval '24 hours'), 0) || ' new since yesterday)', '')
      || E'. Who to pitch first:\n' || string_agg(line, E'\n' order by fit_score desc, due_at)
      || E'\n\nPitch: "There''s a public ' || 'job your size coming up. We can check if you qualify, get the paperwork ready, and you just set the price." Never promise a win. Mark a contractor ''bid check requested'' when they want one.'
    into txt from (
      select m.fit_score, d.due_at, '• ' || r.title || ' (' || r.status || ') → ' || d.title || E'\n   ' || m.reason
        || coalesce(' ⚠ ' || m.hard_stop, '') || E'\n   ' || d.url as line
      from os.bid_matches m join os.bids d on d.id = m.bid_id join os.records r on r.id = m.record_id
      where m.business_id = b.business_id and m.decision = 'pending' and d.status = 'open' and d.due_at > now() + interval '3 days'
      order by m.fit_score desc, d.due_at limit 12) x;
    insert into os.messages (business_id, sender, body, status) values (b.business_id, 'system', txt, 'handled');
    k := k + 1;
  end loop;
  return k;
end $$;
revoke all on function os.bid_digest(boolean) from public;

-- Bid Desk is the first business with the bid desk on; counties for the 10 contractors on its call sheet.
update os.business_config set config = config || '{"bid_desk":"on"}'::jsonb
  where active and business_id = (select id from os.businesses where slug = 'bid-desk');
update os.records r set data = r.data || jsonb_build_object('county', v.county)
from (values ('Williamstown', 'Gloucester'), ('Sewell', 'Gloucester'), ('Marlton', 'Burlington'), ('Hainesport', 'Burlington'),
  ('Toms River', 'Ocean'), ('Princeton', 'Mercer'), ('Hamilton', 'Mercer'), ('Cherry Hill', 'Camden'), ('Morris', 'Morris')) v(area, county)
where r.business_id = (select id from os.businesses where slug = 'bid-desk') and r.data->>'area' = v.area and not (r.data ? 'county');

-- Sources checked Nov 10 2026: both are public pages with no login, no terms forbidding reading, and robots.txt allows them.
update os.bid_sources set terms_ok = true, active = true,
  notes = notes || ' Checked Nov 10 2026: public, no login, robots.txt allows; read once a day.'
  where url in ('https://www.njstart.gov/bso/', 'https://www.nj.gov/treasury/dpmc/project_construction_advertisements.shtml') and not terms_ok;

-- Bid Desk's numbers for Ezra and the HQ scoreboard.
create or replace function os.bid_numbers(p_bid uuid) returns text language sql stable security definer set search_path = os as $$
  select ' Open public bids being watched: ' || (select count(*) from os.bids where status = 'open' and due_at > now())
    || '. Bids that fit contractors on the list, not pitched yet: ' || (select count(*) from os.bid_matches m join os.bids d on d.id = m.bid_id
         where m.business_id = p_bid and m.decision = 'pending' and d.status = 'open' and d.due_at > now() + interval '3 days') || '.'
$$;
revoke all on function os.bid_numbers(uuid) from public;

-- Every day: read the sources at 5:30am New York time (10:30 UTC; 9:30 UTC in summer is close enough), digest at 7am.
select cron.unschedule('os-bids-collect') where exists (select 1 from cron.job where jobname = 'os-bids-collect');
select cron.schedule('os-bids-collect', '30 10 * * *', $c$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-bids',
    headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY'), 'content-type', 'application/json'),
    body := '{"action":"collect"}'::jsonb, timeout_milliseconds := 300000)
$c$);
select cron.unschedule('os-bid-digest') where exists (select 1 from cron.job where jobname = 'os-bid-digest');
select cron.schedule('os-bid-digest', '15 * * * *', 'select os.bid_digest()');

-- Ezra's numbers (os.ceo_numbers bid-desk branch) now include the bid matches.
do $d$ declare f text := pg_get_functiondef('os.ceo_numbers(uuid)'::regprocedure);
begin
  if f not like '%bid_numbers%' then
    execute replace(f, $r$and status = 'signed') || '.';$r$, $r$and status = 'signed') || '.' || os.bid_numbers(p_bid);$r$);
  end if;
end $d$;
