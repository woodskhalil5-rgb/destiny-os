-- Fix: read the row as JSON so the same trigger works on approvals (summary) and content (title, kind, channel),
-- and never let an alert stop the team from saving its work.
create or replace function os.on_needs_ok() returns trigger language plpgsql security definer set search_path = os as $$
declare biz record; kind text := case when tg_table_name = 'approvals' then 'approval' else 'content' end; subj text; r jsonb := to_jsonb(new);
begin
  if new.status <> 'pending' or (tg_op = 'UPDATE' and old.status = 'pending') then return new; end if;
  select b.name, b.status, coalesce((c.config->>'approval_emails')::boolean, true) as on into biz
    from os.businesses b left join os.business_config c on c.business_id = b.id and c.active where b.id = new.business_id;
  if biz is null or biz.status = 'archived' or not biz.on then return new; end if;
  subj := case when kind = 'approval' then coalesce(r->>'summary', 'Something to approve')
               else coalesce(r->>'title', initcap(coalesce(r->>'kind', 'post')) || ' for ' || coalesce(r->>'channel', 'Facebook')) end;
  insert into os.alerts (business_id, audience, kind, subject, body, dedupe_key, ref)
  values (new.business_id, 'business', 'needs_ok', subj, '', 'ok:' || kind || ':' || new.id, jsonb_build_object('kind', kind, 'id', new.id))
  on conflict (dedupe_key) do nothing;
  return new;
exception when others then
  -- An alert must never stop the team from saving its work.
  raise warning 'on_needs_ok: %', sqlerrm;
  return new;
end $$;
