-- 0053: one-tap Facebook / Instagram / YouTube connections and automatic posting (os-social).
-- os.content_posts records each platform a post went to, so a post is never sent twice to the same place.
create table if not exists os.content_posts (
  id bigint generated always as identity primary key,
  content_id bigint not null references os.content(id) on delete cascade,
  business_id uuid not null references os.businesses(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'youtube')),
  status text not null default 'posting' check (status in ('posting', 'posted', 'failed', 'skipped')),
  external_id text,
  error text,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  unique (content_id, platform)
);
alter table os.content_posts enable row level security;
revoke all on os.content_posts from anon, authenticated;

-- Every minute: post due content to Instagram and YouTube (Facebook stays with os-jobs every 5 minutes).
select cron.unschedule('os-social') where exists (select 1 from cron.job where jobname = 'os-social');
select cron.schedule('os-social', '* * * * *', $c$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-social',
    headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY'), 'content-type', 'application/json'),
    body := '{"action":"publish"}'::jsonb, timeout_milliseconds := 300000)
  where exists (select 1 from os.content c join os.integrations i on i.business_id = c.business_id and i.status = 'connected' and i.provider in ('instagram', 'youtube')
    where c.scheduled_for <= now() + interval '1 minute' and c.scheduled_for > now() - interval '3 days'
      and c.status in ('scheduled', 'publishing', 'published', 'needs_manual', 'failed') and c.channel ~* '(instagram|youtube|\mig\M|\myt\M)')
$c$);

-- Grayson (media) on every business: how to set the channel so posts go to the right places.
update os.business_agents ba set role_instructions = ba.role_instructions || E'\n\n'
  || 'WHERE POSTS GO: set each post''s channel to the platforms it should go to, e.g. "facebook", "facebook, instagram" or "youtube". '
  || 'After the owner approves, it posts on its own at the scheduled time to every platform that is connected under Settings, Connections. '
  || 'Instagram needs a JPEG photo or a video attached (no text-only posts); YouTube needs a video. Facebook takes text, photos or video.'
where ba.slot = 'media' and ba.role_instructions not like '%WHERE POSTS GO:%';
