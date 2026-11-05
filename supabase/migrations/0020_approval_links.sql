-- One-tap approvals: when the team asks for an OK (an email or a post), the business owner gets an email with a link
-- to a small page showing exactly what will go out, with Approve and Send back buttons. Each link works for that one
-- item only and expires after 3 days. Only a hash of each link's token is stored.
alter table os.alerts add column if not exists ref jsonb;

create table if not exists os.approval_links (
  token_hash text primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  item_kind text not null check (item_kind in ('approval', 'content')),
  item_id bigint not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists approval_links_item on os.approval_links (item_kind, item_id);
alter table os.approval_links enable row level security;

-- New items waiting for the owner queue an alert; os-jobs turns it into the email (and makes the link) when it sends.
-- A business can turn these emails off with config.approval_emails = false.
create or replace function os.on_needs_ok() returns trigger language plpgsql security definer set search_path = os as $$
declare biz record; kind text := case when tg_table_name = 'approvals' then 'approval' else 'content' end; subj text;
begin
  if new.status <> 'pending' or (tg_op = 'UPDATE' and old.status = 'pending') then return new; end if;
  select b.name, b.status, coalesce((c.config->>'approval_emails')::boolean, true) as on into biz
    from os.businesses b left join os.business_config c on c.business_id = b.id and c.active where b.id = new.business_id;
  if biz is null or biz.status = 'archived' or not biz.on then return new; end if;
  subj := case when kind = 'approval' then coalesce(new.summary, 'Something to approve')
               else coalesce(new.title, initcap(coalesce(new.kind, 'post')) || ' for ' || coalesce(new.channel, 'Facebook')) end;
  insert into os.alerts (business_id, audience, kind, subject, body, dedupe_key, ref)
  values (new.business_id, 'business', 'needs_ok', subj, '', 'ok:' || kind || ':' || new.id, jsonb_build_object('kind', kind, 'id', new.id))
  on conflict (dedupe_key) do nothing;
  return new;
end $$;

drop trigger if exists approvals_needs_ok on os.approvals;
create trigger approvals_needs_ok after insert or update of status on os.approvals for each row execute function os.on_needs_ok();
drop trigger if exists content_needs_ok on os.content;
create trigger content_needs_ok after insert or update of status on os.content for each row execute function os.on_needs_ok();
