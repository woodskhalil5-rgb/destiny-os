-- Agent efficiency: prompt-cache metering, quieter hourly check-ins, a shared daily notebook,
-- research memory, and a results-per-dollar view.

-- 1. Meter cached tokens separately (cache writes cost 1.25x input, cache reads 0.1x).
alter table os.usage_events
  add column if not exists cache_write_tokens integer not null default 0,
  add column if not exists cache_read_tokens integer not null default 0;

-- 2. The team notebook: one short entry per business per day, written by DeMarcus at the end of the shift.
create table if not exists os.notebook (
  business_id uuid not null references os.businesses(id) on delete cascade,
  day date not null,
  body text not null,
  created_by text not null default 'coordination',
  updated_at timestamptz not null default now(),
  primary key (business_id, day)
);
alter table os.notebook enable row level security;
grant select on os.notebook to authenticated;
create policy member_read on os.notebook for select to authenticated using (os.member_role(business_id) is not null);
grant all on os.notebook to service_role;

-- 3. Research memory: what the team already learned, so nobody pays to look it up twice.
create table if not exists os.research_notes (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  subject text not null,
  note text not null,
  sources text[] not null default '{}',
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists research_notes_biz on os.research_notes (business_id, created_at desc);
alter table os.research_notes enable row level security;
grant select on os.research_notes to authenticated;
create policy member_read on os.research_notes for select to authenticated using (os.member_role(business_id) is not null);
grant all on os.research_notes to service_role;
grant all on all sequences in schema os to service_role;

-- New tools for everyone (recall, save_note); DeMarcus also writes the notebook.
update os.agents set default_tools = default_tools || array['recall', 'save_note']
  where not ('recall' = any(default_tools));
update os.agents set default_tools = default_tools || array['write_notebook']
  where slot = 'coordination' and not ('write_notebook' = any(default_tools));

-- 4. Hourly check-ins only wake teammates who have work. Start and end of shift still include everyone.
create or replace function os.hourly() returns void language plpgsql security definer set search_path = os as $$
declare b os.businesses; h int; others text; busy text; today date;
begin
  for b in select * from os.businesses where status = 'live' loop
    continue when not os.on_shift(b);
    h := extract(hour from now() at time zone b.timezone)::int;
    today := (now() at time zone b.timezone)::date;
    if h = b.shift_start or h = b.shift_end - 1 then
      select string_agg('@' || a.handle, ' ' order by a.sort) into others
        from os.business_agents ba join os.agents a using (slot)
        where ba.business_id = b.id and ba.enabled and a.slot <> 'coordination';
      insert into os.messages (business_id, sender, body) values (b.id, 'system',
        case when h = b.shift_start
          then 'Shift started. @demarcus read the notebook, review tasks and records, and give out today''s assignments as tasks. ' || coalesce(others, '') || ' pick up where you left off; work in batches.'
          else 'Last hour of the shift. ' || coalesce(others, '') || ' wrap up and tell @demarcus where you stand. @demarcus then send the owner today''s report and write today''s notebook entry (write_notebook).' end);
    else
      select string_agg('@' || a.handle, ' ' order by a.sort) into busy
        from os.business_agents ba join os.agents a using (slot)
        where ba.business_id = b.id and ba.enabled and a.slot <> 'coordination' and (
          exists (select 1 from os.tasks t where t.business_id = b.id and t.assignee_slot = a.slot and t.status in ('open', 'in_progress'))
          or exists (select 1 from os.records r where r.business_id = b.id and r.owner_slot = a.slot and r.next_step_due <= today));
      if busy is not null then
        insert into os.messages (business_id, sender, body) values (b.id, 'system',
          'Hourly check-in. ' || busy || ' do the next batch of your open work, then post a one-line update.');
      elsif (h - b.shift_start) % 3 = 0 then
        insert into os.messages (business_id, sender, body) values (b.id, 'system',
          '@demarcus nobody has open work right now. Check the records and give out the next assignments as tasks, or note that the team is caught up.');
      end if;
    end if;
  end loop;
end $$;

-- 5. What each agent produced this month, for the results-per-dollar view.
create or replace function os.agent_results(bid uuid, month date default date_trunc('month', now())::date)
returns table (slot text, records_created int, records_updated int, drafts int, sent int, content int, published int, reviews int, cost_usd numeric, billed_usd numeric)
language sql stable security definer set search_path = os as $$
  select a.slot,
    (select count(*)::int from os.records r where r.business_id = bid and r.created_by = a.slot and r.created_at >= month and r.created_at < month + interval '1 month'),
    (select count(*)::int from os.activity_log l where l.business_id = bid and l.actor = a.slot and l.action = 'tool:save_record' and l.target is not null and l.at >= month and l.at < month + interval '1 month'),
    (select count(*)::int from os.approvals p where p.business_id = bid and p.requested_by = a.slot and p.created_at >= month and p.created_at < month + interval '1 month'),
    (select count(*)::int from os.approvals p where p.business_id = bid and p.requested_by = a.slot and p.status = 'done' and p.decided_at >= month and p.decided_at < month + interval '1 month'),
    (select count(*)::int from os.content c where c.business_id = bid and c.created_by = a.slot and c.created_at >= month and c.created_at < month + interval '1 month'),
    (select count(*)::int from os.content c where c.business_id = bid and c.created_by = a.slot and c.status = 'published' and c.published_at >= month and c.published_at < month + interval '1 month'),
    (select count(*)::int from os.approvals p where p.business_id = bid and p.decided_by = a.slot and p.decided_at >= month and p.decided_at < month + interval '1 month'),
    (select coalesce(sum(u.cost_usd), 0) from os.usage_events u where u.business_id = bid and u.slot = a.slot and u.at >= month and u.at < month + interval '1 month'),
    (select coalesce(sum(u.billed_usd), 0) from os.usage_events u where u.business_id = bid and u.slot = a.slot and u.at >= month and u.at < month + interval '1 month')
  from os.agents a join os.business_agents ba on ba.slot = a.slot and ba.business_id = bid
  order by a.sort;
$$;
revoke all on function os.agent_results(uuid, date) from public;
grant execute on function os.agent_results(uuid, date) to service_role;

-- 6. Bigger batches for JHP's researcher.
update os.business_agents ba set role_instructions = replace(role_instructions, 'Save 2 or 3 per turn', 'Save 5 to 8 per run')
  from os.businesses b where b.id = ba.business_id and b.slug = 'jhp' and ba.slot = 'research';
