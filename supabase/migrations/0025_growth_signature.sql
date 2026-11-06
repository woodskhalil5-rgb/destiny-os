-- Sign follow-ups once: "Thanks, Alex / Summit Roofing", or just the business name when there's no sender name.
create or replace function os.growth_daily() returns int language plpgsql security definer set search_path = os as $$
declare q record; g record; n int := 0; days int; step int; first text; biz text; sender text; subj text; body text; amt text;
begin
  for q in
    select r.*, b.name as bname from os.records r join os.businesses b on b.id = r.business_id
    where r.type = 'quote' and r.status in ('sent', 'following up') and b.status in ('live', 'setup', 'paused') and b.status <> 'archived'
      and coalesce(r.data->>'email', '') <> ''
      and not exists (select 1 from os.optouts o where o.business_id = r.business_id and o.email = lower(r.data->>'email'))
  loop
    select * into g from os.growth_settings where business_id = q.business_id;
    continue when g is not null and not g.follow_ups;
    days := (current_date - coalesce((q.data->>'sent_on')::date, q.created_at::date));
    step := coalesce((q.data->>'follow_ups')::int, 0);
    if step >= 3 then
      if days >= 17 then update os.records set status = 'no answer', next_step = null, next_step_due = null, updated_at = now() where id = q.id; end if;
      continue;
    end if;
    continue when days < (array[2, 5, 10])[step + 1];
    -- Don't stack: skip if the last follow-up is still waiting for the owner.
    continue when exists (select 1 from os.approvals a where a.business_id = q.business_id and a.status = 'pending' and a.payload->>'ref_record' = q.id::text);
    first := split_part(coalesce(nullif(q.data->>'name', ''), q.title), ' ', 1);
    biz := q.bname; sender := coalesce(g.sender_name, (select config->'owner'->>'name' from os.business_config where business_id = q.business_id and active), biz);
    if sender = 'the boss' or sender = 'the owner' then sender := biz; end if;
    amt := case when coalesce(q.data->>'amount', '') <> '' then ' ($' || to_char((q.data->>'amount')::numeric, 'FM999,999,990') || ')' else '' end;
    if step = 0 then
      subj := 'Your estimate from ' || biz;
      body := 'Hi ' || first || E',\n\nJust checking that you got the estimate for ' || coalesce(nullif(q.data->>'job', ''), 'the work') || amt || E'. Happy to answer any questions or walk you through it.\n\nThanks,\n' || sender || case when sender <> biz then E'\n' || biz else '' end;
    elsif step = 1 then
      subj := 'Any questions about your estimate?';
      body := 'Hi ' || first || E',\n\nI wanted to follow up on the estimate for ' || coalesce(nullif(q.data->>'job', ''), 'the work') || E'. If anything is holding you back, like timing or budget, let me know and we''ll see what we can do.\n\nThanks,\n' || sender || case when sender <> biz then E'\n' || biz else '' end;
    else
      subj := 'Should I close out your estimate?';
      body := 'Hi ' || first || E',\n\nI haven''t heard back about the estimate for ' || coalesce(nullif(q.data->>'job', ''), 'the work') || E', so I''ll close it out for now. If you''d still like to go ahead, just reply and we''ll get you on the schedule.\n\nThanks,\n' || sender || case when sender <> biz then E'\n' || biz else '' end;
    end if;
    body := body || E'\n\n(Reply "stop" and we won''t follow up again.)';
    insert into os.approvals (business_id, kind, summary, payload, original_payload, requested_by)
    values (q.business_id, 'email', 'Follow-up ' || (step + 1) || ' of 3 on the estimate for ' || q.title,
      jsonb_build_object('to', q.data->>'email', 'subject', subj, 'body', body, 'ref_record', q.id::text),
      jsonb_build_object('to', q.data->>'email', 'subject', subj, 'body', body, 'ref_record', q.id::text), 'production');
    update os.records set status = 'following up', data = data || jsonb_build_object('follow_ups', step + 1),
      next_step = case when step + 1 < 3 then 'follow-up ' || (step + 2) || ' on day ' || (array[2, 5, 10])[step + 2] else 'close out if no answer' end,
      next_step_due = coalesce((q.data->>'sent_on')::date, q.created_at::date) + (array[2, 5, 10, 17])[step + 2], updated_at = now()
      where id = q.id;
    n := n + 1;
  end loop;

  -- Review requests: 2 days after a job is won, if the business has a review link.
  for q in
    select r.*, b.name as bname, gs.review_link, gs.sender_name from os.records r
    join os.businesses b on b.id = r.business_id join os.growth_settings gs on gs.business_id = r.business_id
    where r.type in ('quote', 'customer', 'lead') and r.status in ('won', 'booked') and b.status <> 'archived'
      and gs.review_asks and coalesce(gs.review_link, '') <> '' and coalesce(r.data->>'email', '') <> ''
      and r.data->>'review_asked' is null and coalesce((r.data->>'won_on')::date, r.updated_at::date) <= current_date - 2
      and not exists (select 1 from os.optouts o where o.business_id = r.business_id and o.email = lower(r.data->>'email'))
  loop
    first := split_part(coalesce(nullif(q.data->>'name', ''), q.title), ' ', 1);
    sender := coalesce(q.sender_name, q.bname);
    body := 'Hi ' || first || E',\n\nThank you for choosing ' || q.bname || E'. If you''re happy with the work, would you leave us a quick review? It takes a minute and really helps a local business like ours:\n\n' || q.review_link || E'\n\nIf anything wasn''t right, just reply to this email and we''ll make it right.\n\nThanks,\n' || sender;
    insert into os.approvals (business_id, kind, summary, payload, original_payload, requested_by)
    values (q.business_id, 'email', 'Review request to ' || q.title,
      jsonb_build_object('to', q.data->>'email', 'subject', 'Thank you from ' || q.bname, 'body', body, 'ref_record', q.id::text),
      jsonb_build_object('to', q.data->>'email', 'subject', 'Thank you from ' || q.bname, 'body', body, 'ref_record', q.id::text), 'production');
    update os.records set data = data || jsonb_build_object('review_asked', current_date::text), updated_at = now() where id = q.id;
    insert into os.wins (business_id, kind, record_id) values (q.business_id, 'review_ask', q.id);
    n := n + 1;
  end loop;
  return n;
end $$;
