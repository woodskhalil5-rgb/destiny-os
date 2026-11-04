-- Destiny OS core schema. Every business-owned table carries business_id and is locked by row-level security.
create schema if not exists os;
grant usage on schema os to authenticated, service_role;

-- ---------- Platform ----------
create table os.platform_admins (user_id uuid primary key references auth.users(id) on delete cascade, created_at timestamptz not null default now());

create table os.businesses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name text not null,
  status text not null default 'setup' check (status in ('setup','live','paused','archived')),
  timezone text not null default 'America/New_York',
  shift_start int not null default 9 check (shift_start between 0 and 23),
  shift_end int not null default 18 check (shift_end between 1 and 24),
  shift_days int[] not null default array[1,2,3,4,5],
  model text not null default 'claude-sonnet-5-5',
  monthly_budget_usd numeric,              -- null = no limit
  plan text not null default 'internal',   -- SaaS plan name; billing attaches here
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

create table os.business_members (
  business_id uuid not null references os.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','operator','viewer')),
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

create table os.business_config (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  version int not null,
  config jsonb not null,                   -- mission, facts, rules, record_types, reports
  note text,
  created_by text not null default 'owner',
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (business_id, version)
);
create unique index business_config_one_active on os.business_config (business_id) where active;

-- ---------- Agents ----------
create table os.agents (                  -- global: the six agents, defined once
  slot text primary key check (slot in ('research','analysis','production','coordination','media','distribution')),
  name text not null,
  handle text not null unique,
  personality text not null,
  core_role text not null,
  default_tools text[] not null,
  sort int not null
);

create table os.business_agents (
  business_id uuid not null references os.businesses(id) on delete cascade,
  slot text not null references os.agents(slot),
  enabled boolean not null default true,
  role_instructions text not null default '',
  tools text[],                            -- null = the agent's default tools
  model text,                              -- null = the business model
  primary key (business_id, slot)
);

create table os.agent_guides (
  business_id uuid not null references os.businesses(id) on delete cascade,
  slot text not null references os.agents(slot),
  kind text not null,
  body text not null default '',
  version int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (business_id, slot, kind)
);

-- ---------- Work ----------
create table os.messages (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  sender text not null,                    -- agent slot, 'owner', 'user:<uuid>', or 'system'
  sender_name text,
  body text not null,
  depth int not null default 0,
  status text not null default 'queued',
  task_id bigint,
  record_id bigint
);
create index on os.messages (business_id, id desc);

create table os.tasks (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  title text not null,
  detail text,
  assignee_slot text references os.agents(slot),
  created_by text not null,
  status text not null default 'open' check (status in ('open','in_progress','blocked','done','cancelled')),
  due_at timestamptz,
  parent_id bigint references os.tasks(id),
  record_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on os.tasks (business_id, status);

create table os.agent_runs (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  slot text not null,
  message_id bigint,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'running',
  error text
);
create index on os.agent_runs (business_id, slot, status);

-- ---------- Records ----------
create table os.records (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  type text not null,                      -- defined per business in config.record_types
  status text not null,
  title text not null,
  data jsonb not null default '{}',
  owner_slot text,
  next_step text,
  next_step_due date,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on os.records (business_id, type, status);

create table os.content (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  created_by text not null,
  kind text not null,
  channel text,
  audience text,
  title text,
  body text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','scheduled','published')),
  scheduled_for timestamptz,
  published_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);

-- ---------- Governance ----------
create table os.approvals (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  kind text not null,                      -- email | content | offer | spend | publish | other
  record_id bigint,
  content_id bigint,
  summary text not null,
  payload jsonb not null,
  original_payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','failed','done')),
  requested_by text not null,
  decided_by text,
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index on os.approvals (business_id, status);

create table os.integrations (
  business_id uuid not null references os.businesses(id) on delete cascade,
  provider text not null,                  -- gmail | resend | jhp | facebook | ...
  status text not null default 'not_connected',
  secret_names text[] not null default '{}', -- names in Supabase Vault; values never stored here
  settings jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (business_id, provider)
);

create table os.activity_log (
  id bigserial primary key,
  business_id uuid references os.businesses(id) on delete cascade,
  at timestamptz not null default now(),
  actor_type text not null,                -- agent | user | system
  actor text not null,
  action text not null,
  target text,
  details jsonb not null default '{}'
);
create index on os.activity_log (business_id, at desc);

-- ---------- Usage ----------
create table os.model_prices (model text primary key, input_per_mtok numeric, output_per_mtok numeric, web_search_per_k numeric);

create table os.usage_events (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  at timestamptz not null default now(),
  slot text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  web_searches int not null default 0,
  cost_usd numeric
);
create index on os.usage_events (business_id, at);

create view os.usage_daily with (security_invoker = true) as
  select business_id, (at at time zone 'UTC')::date as day, slot, count(*) as calls,
         sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(web_searches) as web_searches, sum(cost_usd) as cost_usd
  from os.usage_events group by 1, 2, 3;

-- ---------- Security ----------
create or replace function os.is_admin() returns boolean language sql stable security definer set search_path = os as
$$ select exists (select 1 from os.platform_admins where user_id = auth.uid()) $$;

create or replace function os.member_role(bid uuid) returns text language sql stable security definer set search_path = os as
$$ select case when os.is_admin() then 'owner' else (select role from os.business_members where business_id = bid and user_id = auth.uid()) end $$;

-- Append-only audit log: no updates or deletes, even for the service role.
create or replace function os.no_change() returns trigger language plpgsql as $$ begin raise exception 'activity_log is append-only'; end $$;
create trigger activity_log_append_only before update or delete on os.activity_log for each row execute function os.no_change();

do $$
declare t text;
begin
  foreach t in array array['businesses','business_members','business_config','business_agents','agent_guides','messages','tasks','agent_runs','records','content','approvals','integrations','activity_log','usage_events']
  loop
    execute format('alter table os.%I enable row level security', t);
    execute format('grant select on os.%I to authenticated', t);
    if t = 'businesses' then
      execute 'create policy member_read on os.businesses for select to authenticated using (os.member_role(id) is not null)';
    else
      execute format('create policy member_read on os.%I for select to authenticated using (os.member_role(business_id) is not null)', t);
    end if;
  end loop;
end $$;
alter table os.agents enable row level security;
alter table os.platform_admins enable row level security;
alter table os.model_prices enable row level security;
grant select on os.agents, os.usage_daily to authenticated;
create policy everyone_read on os.agents for select to authenticated using (true);
create policy self_read on os.platform_admins for select to authenticated using (user_id = auth.uid());
-- All writes go through the server functions (service role), which check membership and log to activity_log.
grant all on all tables in schema os to service_role;
grant all on all sequences in schema os to service_role;

-- ---------- The six agents ----------
insert into os.agents (slot, name, handle, personality, core_role, default_tools, sort) values
('research','James','james',
 'Very professional, a great worker who goes above and beyond for the work and the team. Polished and confident; takes pride in clean, well-sourced work and flags useful things for teammates even when nobody asked.',
 'Research and sourcing: business and market research, prospect identification, lead sourcing, opportunity discovery, data gathering. You find things and save them as records with where you found them.',
 array['web_search','save_record','find_records','get_record','create_task','update_task'], 1),
('analysis','Emily','emily',
 'A sweetheart: soft-spoken, kind, and very dedicated to getting better at her job. Does every task to perfection, double-checks before handing anything off, honest when unsure, thanks teammates for good handoffs.',
 'Analysis and intelligence: verify and evaluate what James finds, financial analysis, market intelligence, opportunity evaluation, research analysis, performance insights. You mark what you verified versus what you are guessing.',
 array['web_search','save_record','find_records','get_record','create_task','update_task'], 2),
('production','Kole','kole',
 'Conservative and chill, very experienced and loves the work. Brief and dry, lets good work speak for itself, tolerates the team''s chatter with good humor, and highly respects DeMarcus and the owner.',
 'Documentation and production: documents, proposals, offers, business documentation, and the business''s direct written outreach. Everything that leaves the company goes through request_approval first.',
 array['save_record','find_records','get_record','request_approval','create_task','update_task'], 3),
('coordination','DeMarcus','demarcus',
 'The manager. The owner is like family to him and he has their back, but he respects them as the boss: warm, loyal and personal with the owner, still professional. A steady, fair manager with the team: clear assignments, credit when earned, direct when something needs fixing.',
 'Communications and coordination: assigns the work, keeps tasks and records moving, chases follow-ups, handles approvals he is cleared for, and is the one who reports to the owner. Steps in when teammates go back and forth without progress.',
 array['find_records','get_record','save_record','create_task','update_task','list_tasks','review_approval','update_guide','report_to_owner'], 4),
('media','Grayson','grayson',
 'Creative, upbeat and quick, with a good eye. Takes feedback from the owner and DeMarcus well and fixes things fast.',
 'Media production: advertising concepts, graphic briefs, video scripts, social posts, promotional content and marketing assets. Saves each piece for approval, then schedules and publishes approved content through connected integrations.',
 array['web_search','save_content','schedule_content','find_records','get_record','create_task','update_task'], 5),
('distribution','Benjamin','benjamin',
 'Friendly, patient, a natural people person who loves building community connections.',
 'Distribution and outreach: finds where the business''s customers are and brings them in through partners, communities and channels; supports prospect outreach; tracks engagement and campaign activity. Never contacts individuals from bought or scraped lists.',
 array['web_search','save_record','find_records','get_record','save_content','request_approval','create_task','update_task'], 6);

-- ---------- Wake the router on new messages ----------
create or replace function os.wake_router() returns trigger language plpgsql security definer set search_path = os, public as $$
begin
  if new.status = 'queued' then
    perform net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-brain',
      headers := jsonb_build_object('content-type','application/json','authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY')),
      body := jsonb_build_object('message_id', new.id),
      timeout_milliseconds := 5000);
  end if;
  return new;
end $$;
create trigger messages_wake after insert on os.messages for each row execute function os.wake_router();

-- ---------- Shifts ----------
create or replace function os.on_shift(b os.businesses) returns boolean language sql stable as $$
  select extract(isodow from now() at time zone b.timezone)::int = any(b.shift_days)
     and extract(hour from now() at time zone b.timezone)::int >= b.shift_start
     and extract(hour from now() at time zone b.timezone)::int <  b.shift_end
$$;

create or replace function os.hourly() returns void language plpgsql security definer set search_path = os as $$
declare b os.businesses; h int; others text;
begin
  for b in select * from os.businesses where status = 'live' loop
    continue when not os.on_shift(b);
    h := extract(hour from now() at time zone b.timezone)::int;
    select string_agg('@' || a.handle, ' ' order by a.sort) into others
      from os.business_agents ba join os.agents a using (slot)
      where ba.business_id = b.id and ba.enabled and a.slot <> 'coordination';
    insert into os.messages (business_id, sender, body) values (b.id, 'system',
      case when h = b.shift_start then 'Shift started. @demarcus review the tasks and records and give out today''s assignments. ' || coalesce(others, '') || ' pick up where you left off.'
           when h = b.shift_end - 1 then 'Last hour of the shift. ' || coalesce(others, '') || ' wrap up and tell @demarcus where you stand. @demarcus then send the owner today''s report.'
           else 'Hourly check-in. ' || coalesce(others, '') || ' do the next piece of your work, then post a one-line update. Check tasks and records first so nothing is redone.' end);
  end loop;
end $$;

-- A run stuck longer than 4 minutes is closed so the agent can work again.
create or replace function os.watchdog() returns void language sql security definer set search_path = os as $$
  update os.agent_runs set status = 'timed_out', ended_at = now() where status = 'running' and started_at < now() - interval '4 minutes';
$$;
