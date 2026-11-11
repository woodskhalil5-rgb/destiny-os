-- 0059: Bid Desk tables (spec: "Bid Desk on Destiny OS — Build Spec", Nov 10 2026).
-- Public data (sources, bids) is shared; everything about a client (profile, matches, packets) is per business and
-- never shown to another business. Access goes through the server functions, like every other os table.

-- Where bids are posted (shared list).
create table if not exists os.bid_sources (
  id bigint generated always as identity primary key,
  name text not null,
  url text not null unique,
  kind text not null check (kind in ('state', 'county', 'town', 'school', 'authority', 'aggregator')),
  county text,
  check_every interval not null default interval '1 day',
  last_checked_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  terms_ok boolean not null default false,   -- someone checked the site's terms allow automated reading
  method text not null default 'page' check (method in ('page', 'rss', 'email_alert', 'manual')),
  active boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

-- Every notice found (shared, public data).
create table if not exists os.bids (
  id bigint generated always as identity primary key,
  source_id bigint references os.bid_sources(id) on delete set null,
  external_ref text,                        -- the agency's bid or solicitation number
  title text not null,
  agency text,
  county text,
  trade_tags text[] not null default '{}',
  commodity_codes text[] not null default '{}',
  due_at timestamptz,
  prebid_at timestamptz,
  prebid_mandatory boolean,
  prevailing_wage boolean,
  pwcr_required boolean,
  bid_bond_pct numeric,
  est_value_usd numeric,
  url text not null,                        -- link back to the notice (every fact must trace to it)
  documents_url text,
  addenda jsonb not null default '[]',      -- [{n, posted_at, url, summary}]
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled', 'awarded')),
  found_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_ref)
);
create index if not exists bids_due on os.bids (due_at) where status = 'open';

-- One per client: what they can bid on.
create table if not exists os.bid_profiles (
  business_id uuid primary key references os.businesses(id) on delete cascade,
  client_record_id bigint references os.records(id) on delete set null,
  trades text[] not null default '{}',
  commodity_codes text[] not null default '{}',
  counties text[] not null default '{}',
  min_job_usd numeric,
  max_job_usd numeric,
  pwcr_number text,
  pwcr_expires date,
  insurance_expires date,
  njstart_vendor_id text,
  brc_status text check (brc_status in ('have', 'missing', 'expired', 'unknown')) default 'unknown',
  bonding_limit_usd numeric,
  active boolean not null default true,
  notes text,
  updated_at timestamptz not null default now()
);

-- A bid matched to one client (private to that client's business).
create table if not exists os.bid_matches (
  id bigint generated always as identity primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  bid_id bigint not null references os.bids(id) on delete cascade,
  fit_score int not null check (fit_score between 0 and 100),
  reason text not null,
  hard_stop text,                            -- e.g. "needs PWCR, client's expired"
  decision text not null default 'pending' check (decision in ('pending', 'pursue', 'pass')),
  decided_at timestamptz,
  outcome text check (outcome in ('submitted', 'won', 'lost', 'not_awarded', 'withdrawn')),
  award_usd numeric,
  created_at timestamptz not null default now(),
  unique (business_id, bid_id)
);
create index if not exists bid_matches_biz on os.bid_matches (business_id, decision);

-- The paperwork for one pursued bid.
create table if not exists os.bid_packets (
  id bigint generated always as identity primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  match_id bigint not null unique references os.bid_matches(id) on delete cascade,
  checklist jsonb not null default '[]',     -- [{item, required, done, note}]
  drafts jsonb not null default '[]',        -- [{form, content, filled_from}]
  client_price_usd numeric,                  -- entered by the client only
  approval_id bigint references os.approvals(id) on delete set null,
  submitted_at timestamptz,
  submitted_by text,                         -- the person who submitted (never an agent)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table os.bid_sources enable row level security;
alter table os.bids enable row level security;
alter table os.bid_profiles enable row level security;
alter table os.bid_matches enable row level security;
alter table os.bid_packets enable row level security;
revoke all on os.bid_sources, os.bids, os.bid_profiles, os.bid_matches, os.bid_packets from anon, authenticated;

-- First sources to check (inactive until their terms are checked and a collector is built for them).
insert into os.bid_sources (name, url, kind, method, notes) values
  ('NJSTART open bids', 'https://www.njstart.gov/bso/', 'state', 'page', 'State Division of Purchase & Property. The NJSTART "Find a Bid" guide says the Open Bids list is public and no login is needed to view it. Check terms before automated reading.'),
  ('NJ DPMC contractor project advertisements', 'https://www.nj.gov/treasury/dpmc/project_construction_advertisements.shtml', 'state', 'page', 'State building projects (roofs, boilers, generators, renovations) with estimated cost and due date. Bidders need DPMC classification (DPMC-27).'),
  ('NJDOT current advertised projects', 'https://www.nj.gov/transportation/business/procurement/ConstrServ/curradvproj.shtm', 'state', 'page', 'Road and bridge construction; plans and addenda are on BidX. Larger jobs.')
on conflict (url) do nothing;
