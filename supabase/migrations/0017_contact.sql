-- "Talk to us" requests from the public front page. Each one emails the platform owner (via os.alert).
create table if not exists os.contact_requests (
  id bigserial primary key,
  name text not null,
  business text not null,
  email text not null,
  phone text,
  message text not null,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists contact_requests_ip on os.contact_requests (ip, created_at desc);
alter table os.contact_requests enable row level security;
