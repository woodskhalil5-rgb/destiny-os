-- Phone notifications (web push): each device a person turns them on for. Endpoints that stop working are removed.
create table if not exists os.push_subs (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok timestamptz,
  fails int not null default 0
);
create index if not exists push_subs_user on os.push_subs (user_id);
alter table os.push_subs enable row level security;
