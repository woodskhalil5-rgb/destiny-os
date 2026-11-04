-- Content that couldn't be posted automatically, or failed, is flagged for a person.
alter table os.content drop constraint if exists content_status_check;
alter table os.content add constraint content_status_check
  check (status in ('pending','approved','rejected','scheduled','published','needs_manual','failed'));
create index if not exists content_due on os.content (status, scheduled_for);
