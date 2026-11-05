-- JHP: homeowners see hello@jerseyhomepros.com; contractors and partners keep team@ (the Resend connection's From).
do $$
declare jhp uuid := (select id from os.businesses where slug = 'jhp'); cur jsonb; v int;
begin
  select config into cur from os.business_config where business_id = jhp and active;
  if cur ? 'email_from' then return; end if;
  cur := cur
    || jsonb_build_object('email_from', jsonb_build_object('homeowner', 'Jersey Home Pros <hello@jerseyhomepros.com>'))
    || jsonb_build_object('record_types', (cur->'record_types') || jsonb_build_object('homeowner', jsonb_build_object(
         'stages', jsonb_build_array('new', 'contacted', 'matched', 'done'),
         'description', 'a homeowner who asked JHP for help; emails to homeowners go from hello@')));
  select coalesce(max(version), 0) + 1 into v from os.business_config where business_id = jhp;
  update os.business_config set active = false where business_id = jhp;
  insert into os.business_config (business_id, version, config, note, created_by, active)
    values (jhp, v, cur, 'homeowners get emails from hello@', 'claude', true);
end $$;
