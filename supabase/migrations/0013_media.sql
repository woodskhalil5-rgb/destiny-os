-- Media library: photos, videos and music a business uploads (e.g. contractors' before-and-after shots)
-- for the team to use in posts, reels and ads. Files live in the private "media" storage bucket under
-- "<business_id>/..."; only the server hands out short-lived links, so one business never sees another's files.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav'])
on conflict (id) do nothing;

create table if not exists os.media (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  kind text not null check (kind in ('photo', 'video', 'audio')),
  path text not null unique,
  mime text,
  bytes bigint,
  tag text not null default 'other' check (tag in ('before', 'after', 'job', 'reel', 'music', 'brand', 'other')),
  contractor text,          -- who did the work / whose photo it is
  trade text,               -- roofing, heating & cooling, ...
  job text,                 -- groups a before with its after, e.g. "Cherry Hill roof, Oct 2026"
  title text,
  notes text,               -- what's in it, for the team (they can't see the picture)
  permission boolean not null default false,  -- the owner confirmed the contractor allows public use
  status text not null default 'ready' check (status in ('ready', 'deleted')),
  uploaded_by text,
  created_at timestamptz not null default now()
);
create index if not exists media_biz on os.media (business_id, created_at desc) where status = 'ready';
alter table os.media enable row level security;  -- no policies: only the server reads it

-- Posts can carry photos or one video from the library.
alter table os.content add column if not exists media_ids bigint[] not null default '{}';

-- Grayson (media) can look through the library.
update os.agents set default_tools = array_append(default_tools, 'find_media') where slot = 'media' and not ('find_media' = any(default_tools));
update os.business_agents set tools = array_append(tools, 'find_media') where slot = 'media' and tools is not null and not ('find_media' = any(tools));

-- 'publishing' = claimed by the publisher while a photo or video uploads (so it can't go out twice).
alter table os.content drop constraint content_status_check;
alter table os.content add constraint content_status_check check (status = any (array['pending','approved','rejected','scheduled','publishing','published','needs_manual','failed']));
