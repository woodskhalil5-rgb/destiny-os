-- JHP: companies pre-listed on jerseyhomepros.com (unclaimed profiles) land in JHP's pipeline as contractor records,
-- so the team can pitch "claim your profile". Daily: ask the JHP site for its company list, then import any new
-- pre-listed ones a few minutes later (the request is asynchronous). Matching skips companies already in the pipeline.
-- (The first 47 were imported by hand on 2026-11-07 with the same matching; #4 and #6 were marked pre-listed.)
create or replace function os.jhp_sync_request() returns bigint language plpgsql security definer set search_path = os as $$
declare rid bigint;
begin
  select net.http_get(url := 'https://jerseyhomepros.com/api/team/companies',
    headers := jsonb_build_object('x-jhp-team-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jhp:JHP_LOOKUP_KEY')),
    timeout_milliseconds := 20000) into rid;
  insert into os.platform_state (key, value, updated_at) values ('jhp_sync_req', to_jsonb(rid), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return rid;
end $$;

create or replace function os.jhp_sync_import() returns int language plpgsql security definer set search_path = os as $$
declare rid bigint; bid uuid; n int := 0;
begin
  select (value #>> '{}')::bigint into rid from os.platform_state where key = 'jhp_sync_req';
  select id into bid from os.businesses where slug = 'jhp' and status <> 'archived';
  if rid is null or bid is null then return 0; end if;
  if not exists (select 1 from net._http_response where id = rid and status_code = 200) then return 0; end if;
  with src as (
    select x->>'company' company, x->>'city' city, x->>'trade' trade, nullif(x->>'website', '') website, x->>'profile_url' profile_url, x->>'hic_number' hic,
      lower(regexp_replace(x->>'company', '[^a-zA-Z0-9]', '', 'g')) nkey,
      lower(regexp_replace(regexp_replace(coalesce(x->>'website', ''), '^https?://(www\.)?', ''), '/.*$', '')) dom
    from net._http_response r, jsonb_array_elements(r.content::jsonb->'companies') x
    where r.id = rid and x->>'jhp_status' like 'pre-listed%'),
  existing as (
    select lower(regexp_replace(r.title, '[^a-zA-Z0-9]', '', 'g')) nkey,
      lower(regexp_replace(regexp_replace(coalesce(r.data->>'website', ''), '^https?://(www\.)?', ''), '/.*$', '')) dom
    from os.records r where r.business_id = bid and r.type = 'contractor'),
  ins as (
    insert into os.records (business_id, type, status, title, data, created_by, next_step)
    select bid, 'contractor', 'found', s.company,
      jsonb_strip_nulls(jsonb_build_object('company', s.company, 'city', s.city, 'trade', s.trade, 'website', s.website, 'profile_url', s.profile_url,
        'hic_number', s.hic, 'jhp_status', 'pre-listed', 'pitch', 'claim-profile', 'source', 'JHP pre-listed companies (jerseyhomepros.com)')),
      'system', 'find a business email on their own site, then a claim-your-profile email'
    from src s where not exists (select 1 from existing e where (e.dom <> '' and e.dom = s.dom) or e.nkey = s.nkey
      or (length(s.nkey) >= 8 and length(e.nkey) >= 8 and (e.nkey like s.nkey || '%' or s.nkey like e.nkey || '%')))
    returning id)
  select count(*) into n from ins;
  if n > 0 then
    insert into os.messages (business_id, sender, body, status) values (bid, 'system', '@demarcus ' || n || ' newly pre-listed compan' || case when n = 1 then 'y was' else 'ies were' end
      || ' added to the pipeline from jerseyhomepros.com (pitch: claim-profile). Fold them into the claim-your-profile work.', 'queued');
  end if;
  return n;
end $$;

select cron.schedule('jhp-sync-request', '3 13 * * *', 'select os.jhp_sync_request()') where not exists (select 1 from cron.job where jobname = 'jhp-sync-request');
select cron.schedule('jhp-sync-import', '8 13 * * *', 'select os.jhp_sync_import()') where not exists (select 1 from cron.job where jobname = 'jhp-sync-import');
