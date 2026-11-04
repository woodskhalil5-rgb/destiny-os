-- Bring the original JHP team's history into Destiny OS (copy only; the old public.team_* tables are left as they were).

-- Emails already seen by an inbox watcher, per business (so replies are never posted twice).
create table if not exists os.mail_seen (
  business_id uuid not null references os.businesses(id) on delete cascade,
  message_id text not null,
  seen_at timestamptz not null default now(),
  primary key (business_id, message_id)
);
alter table os.mail_seen enable row level security;
grant all on os.mail_seen to service_role;

do $$
declare jhp uuid := (select id from os.businesses where slug = 'jhp');
begin
  if jhp is null or exists (select 1 from os.records where business_id = jhp and data ? 'legacy_lead_id') then return; end if;

  -- Contractors
  insert into os.records (business_id, type, status, title, data, owner_slot, next_step, next_step_due, created_by, created_at, updated_at)
  select jhp, 'contractor',
    case l.status when 'audited' then 'verified' when 'emailed' then 'contacted' else l.status end,
    l.business,
    jsonb_strip_nulls(jsonb_build_object('legacy_lead_id', l.id, 'trade', l.trade, 'city', l.city, 'phone', l.phone, 'email', l.email,
      'website', l.website, 'findings', l.findings, 'audit', l.audit, 'jhp_status', l.jhp_status, 'jhp_profile_url', l.jhp_profile_url)),
    'research', l.next_step, l.next_step_due, 'research', l.created_at, coalesce(l.updated_at, l.created_at)
  from public.team_leads l
  where not exists (select 1 from os.records r where r.business_id = jhp and r.type = 'contractor' and lower(r.title) = lower(l.business));

  -- Outreach emails and the owner's decisions (these count toward DeMarcus being allowed to approve)
  insert into os.approvals (business_id, kind, record_id, summary, payload, original_payload, status, requested_by, decided_by, decided_at, note, created_at)
  select jhp, 'email', r.id, 'Email to ' || coalesce(r.title, a.to_email),
    jsonb_build_object('to', a.to_email, 'subject', a.subject, 'body', a.body),
    jsonb_build_object('to', a.to_email, 'subject', coalesce(a.original_subject, a.subject), 'body', coalesce(a.original_body, a.body)),
    case a.status when 'sent' then 'done' else a.status end,
    'production',
    case a.decided_by when 'owner' then 'user:migrated-owner' when 'demarcus' then 'coordination' else a.decided_by end,
    a.decided_at, a.note, a.created_at
  from public.team_approvals a
  left join os.records r on r.business_id = jhp and (r.data->>'legacy_lead_id')::bigint = a.lead_id
  where a.status in ('sent', 'rejected');

  -- What DeMarcus learned about the owner's email taste
  insert into os.agent_guides (business_id, slot, kind, body)
  select jhp, 'coordination', 'email', s.email_guide from public.team_settings s where coalesce(s.email_guide, '') <> ''
  on conflict (business_id, slot, kind) do update set body = excluded.body;

  -- Inbox emails the old team already handled
  insert into os.mail_seen (business_id, message_id) select jhp, message_id from public.team_mail_seen on conflict do nothing;

  insert into os.activity_log (business_id, actor_type, actor, action, target, details)
  values (jhp, 'system', 'migration', 'import_jhp_team', 'jhp',
    jsonb_build_object('records', (select count(*) from os.records where business_id = jhp), 'approvals', (select count(*) from os.approvals where business_id = jhp)));
end $$;
