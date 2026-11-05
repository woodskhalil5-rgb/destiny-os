-- Grayson can see the library: small JPEG previews (a photo's downsized copy, or 6 frames from a video, made in the
-- browser at upload) live next to the file, and a short description of what's actually visible is written once.
alter table os.media add column if not exists frames text[] not null default '{}';
alter table os.media add column if not exists ai_notes text;

update os.agents set default_tools = array_append(default_tools, 'view_media') where slot = 'media' and not ('view_media' = any(default_tools));
update os.business_agents set tools = array_append(tools, 'view_media') where slot = 'media' and tools is not null and not ('view_media' = any(tools));
alter table os.media add column if not exists describe_tries int not null default 0;
