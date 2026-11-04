-- Email-code sign-in for the dashboard (codes and sessions are stored hashed).
create table os.login_codes (id bigserial primary key, email text not null, code_hash text not null, attempts int not null default 0, used boolean not null default false, expires_at timestamptz not null, created_at timestamptz not null default now());
create table os.sessions (token_hash text primary key, user_id uuid not null references auth.users(id) on delete cascade, expires_at timestamptz not null, created_at timestamptz not null default now());
alter table os.login_codes enable row level security;
alter table os.sessions enable row level security;
grant all on os.login_codes, os.sessions to service_role;
grant all on all sequences in schema os to service_role;
-- Vault: OS_OWNER_EMAIL (platform owner) and OS_MAIL_USER (Gmail that sends sign-in codes) are set per deployment.
