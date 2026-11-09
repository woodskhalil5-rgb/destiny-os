-- DeMarcus watches every business's incoming inquiries (web form, website-form emails, lead services, phone),
-- so none are missed. Each hour on shift, any inquiry still unanswered an hour after it arrived goes to DeMarcus:
-- he gets Kole to draft a reply if there's no draft yet, or reminds the owner if a draft is waiting for their OK.
-- At most once a day per inquiry, and no more than 3 times, so a quiet inquiry can't run up AI costs.
create or replace function os.inquiry_watch() returns integer language plpgsql security definer set search_path = os as $$
declare b os.businesses; r record; lines text; ids bigint[]; n int := 0;
begin
  for b in select * from os.businesses where status = 'live' loop
    continue when not os.on_shift(b);
    lines := null; ids := '{}';
    for r in
      select i.id, i.title, i.data, i.created_at,
        exists (select 1 from os.approvals a where a.business_id = b.id and a.status = 'pending'
                and (a.record_id = i.id or a.payload->>'ref_record' = i.id::text)) as drafted
      from os.records i
      where i.business_id = b.id and i.type = 'inquiry' and i.status = 'new'
        and i.created_at < now() - interval '1 hour' and i.created_at > now() - interval '14 days'
        and coalesce((i.data->>'watch_count')::int, 0) < 3
        and (i.data->>'watched_at' is null or (i.data->>'watched_at')::timestamptz < now() - interval '1 day')
      order by i.created_at limit 10
    loop
      lines := coalesce(lines || E'\n', '') || '#' || r.id || ' ' || r.title
        || coalesce(' (' || nullif(concat_ws(' · ', r.data->>'email', r.data->>'phone'), '') || ')', '')
        || ', via ' || coalesce(r.data->>'source', 'website') || ', '
        || case when r.drafted then 'reply drafted, waiting for the owner''s OK'
                when coalesce(r.data->>'email', '') <> '' then 'no reply drafted yet'
                else 'phone only, owner needs to call' end;
      ids := ids || r.id;
    end loop;
    continue when lines is null;
    insert into os.messages (business_id, sender, body) values (b.id, 'system',
      E'@demarcus These inquiries are still unanswered:\n' || lines || E'\n'
      || 'For each one: if no reply is drafted, ask @kole to draft it now (request_approval, kind email, with the record id). '
      || 'If a reply is waiting for the owner''s OK or it''s phone only, remind the owner in one short line. Don''t contact anyone yourself.');
    update os.records set data = data || jsonb_build_object('watched_at', now(), 'watch_count', coalesce((data->>'watch_count')::int, 0) + 1)
      where id = any(ids);
    n := n + 1;
  end loop;
  return n;
end $$;

select cron.unschedule('os-inquiry-watch') where exists (select 1 from cron.job where jobname = 'os-inquiry-watch');
select cron.schedule('os-inquiry-watch', '31 * * * *', 'select os.inquiry_watch()');
