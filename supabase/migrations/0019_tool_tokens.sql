-- Short-lived tokens for internal tools (e.g. making audio for videos). Only hashes are stored.
create table if not exists os.tool_tokens (
  token_hash text primary key,
  purpose text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table os.tool_tokens enable row level security;
