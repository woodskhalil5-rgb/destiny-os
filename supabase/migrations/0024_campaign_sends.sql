-- Seasonal emails to past customers go out in batches (os-jobs, every 5 minutes); this remembers who already got one,
-- so a batch that's cut short never emails anyone twice.
create table if not exists os.campaign_sends (
  approval_id bigint not null references os.approvals(id) on delete cascade,
  email text not null,
  at timestamptz not null default now(),
  error text,
  primary key (approval_id, email)
);
alter table os.campaign_sends enable row level security;
