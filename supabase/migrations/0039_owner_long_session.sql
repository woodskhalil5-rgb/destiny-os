-- The platform owner stays signed in for a year on each device (everyone else keeps 90 days).
create or replace function os.owner_long_session() returns trigger language plpgsql security definer set search_path = os as $$
begin
  if exists (select 1 from os.platform_admins where user_id = new.user_id) then
    new.expires_at := greatest(new.expires_at, now() + interval '365 days');
  end if;
  return new;
end $$;
drop trigger if exists owner_long_session on os.sessions;
create trigger owner_long_session before insert on os.sessions for each row execute function os.owner_long_session();
-- Sessions the owner already has (phone, computer) get the year too.
update os.sessions s set expires_at = greatest(s.expires_at, s.created_at + interval '365 days')
  where s.expires_at > now() and exists (select 1 from os.platform_admins a where a.user_id = s.user_id);
