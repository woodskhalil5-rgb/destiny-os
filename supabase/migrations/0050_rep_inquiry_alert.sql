-- When someone writes in through a business's website form (e.g. the DMG Nigeria page), its sales reps (callers)
-- get an email from DeMarcus right away, from team@destinymarketinggroup.com, so they can reply on WhatsApp the same day.
-- DeMarcus and Kole still get the inquiry on the board as before.
create or replace function os.rep_inquiry_alert() returns trigger language plpgsql security definer set search_path = os as $$
declare b os.businesses; m record;
begin
  if new.type <> 'inquiry' or new.created_by <> 'form' then return new; end if;
  select * into b from os.businesses where id = new.business_id and status <> 'archived';
  if b.id is null then return new; end if;
  for m in select u.id uid, u.email from os.business_members bm join auth.users u on u.id = bm.user_id
           where bm.business_id = b.id and bm.role = 'caller' loop
    insert into os.person_mail (business_id, kind, to_addr, from_addr, reply_to, subject, body, dedupe_key)
    values (b.id, 'rep_inquiry', m.email, 'DeMarcus · ' || b.name || ' <team@destinymarketinggroup.com>', 'admin@destinymarketinggroup.com',
      'New enquiry from the website: ' || new.title,
      'Hi,' || E'\n\n' || 'Someone just wrote in through the ' || b.name || ' website:' || E'\n\n'
        || 'Name: ' || new.title || E'\n'
        || coalesce('WhatsApp/phone: ' || nullif(new.data->>'phone', '') || E'\n', '')
        || coalesce('Email: ' || nullif(new.data->>'email', '') || E'\n', '')
        || E'\n' || coalesce(new.data->>'message', '') || E'\n\n'
        || 'Please reach them on WhatsApp today, using the approved messages in your kit, and log the result on your call sheet: https://app.destinymarketinggroup.com/app'
        || E'\n\nDeMarcus\n' || b.name || ' team manager',
      'rep_inquiry:' || new.id || ':' || m.uid)
    on conflict (dedupe_key) do nothing;
  end loop;
  return new;
exception when others then
  return new; -- never lose the enquiry because of this email
end $$;
create or replace trigger rep_inquiry_alert after insert on os.records for each row execute function os.rep_inquiry_alert();
