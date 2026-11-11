-- 0064 (Nov 11 2026): sign-ups who haven't paid their first month used to get one email (about 20 hours in) and then
-- nothing. Now they also get a reminder on day 3 and a last one on day 7, and on day 7 the platform owner gets an alert
-- to call them. Wording fits the business: acquisitions accounts hear about deals, everyone else about leads.
-- Jared (Moore Holding LLC) and Jason (JTM Holding LLC) got the day-3 reminder early, on Nov 11, at Khalil's request
-- (sent with the same nudge2 key, so it doesn't repeat on day 3).
create or replace function os.trial_nudges() returns integer language plpgsql security definer set search_path = os as $function$
declare b record; n int := 0; app text; todo text; mail boolean; fb boolean; cust int; rl text; quotes int; started timestamptz; unpaid boolean;
  acq boolean; first text; what text; fee numeric;
begin
  app := coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'OS_APP_URL'), '');
  for b in select * from os.businesses where status <> 'archived' and (
      (trial_ends_at > now() and not trial_converted)
      or (pay_to_start and trial_ends_at is null and created_at > now() - interval '10 days')) loop
    started := coalesce(b.trial_ends_at - interval '14 days', b.created_at);
    unpaid := b.pay_to_start and b.fee_paid_until is null;
    if b.status = 'setup' and now() between started + interval '20 hours' and started + interval '3 days' then
      perform os.alert(b.id, 'business', 'start_nudge', 'Your team is ready to start',
        'Your Destiny OS team for ' || b.name || E' is set up and waiting. Nothing runs until you say so.\n\n'
        || case when unpaid then E'Open your dashboard, pay your first month on the Money tab, then tap Start team. They begin on their next work hour, and nothing goes out without your OK.\n\n'
                else E'Open your dashboard and tap Start team. They begin on their next work hour, and nothing goes out without your OK.\n\n' end
        || app || '/app', 'nudge1:' || b.id);
      n := n + 1;
    end if;
    -- Still not paid: a reminder on day 3 and a last one on day 7 (plus a call alert for the platform owner).
    if unpaid and b.status = 'setup' and now() >= started + interval '3 days' and now() < started + interval '9 days' then
      select coalesce(c.config->>'kind', '') = 'acquisitions', split_part(coalesce(c.config->'owner'->>'name', ''), ' ', 1)
        into acq, first from os.business_config c where c.business_id = b.id and c.active;
      fee := coalesce(b.platform_fee_usd, 0);
      what := case when acq then 'find listings that fit your buying strategy, run your numbers on each one and draft offers to listing agents for your OK'
                   else 'answer your inquiries, follow up your quotes and get you more leads, with everything waiting for your OK' end;
      if now() < started + interval '7 days' then
        perform os.alert(b.id, 'business', 'start_nudge', 'Your team is still waiting on one step',
          case when coalesce(first, '') <> '' then 'Hi ' || first || E',\n\n' else '' end
          || 'Your Destiny OS team for ' || b.name || ' is set up and ready to ' || what || E'. They start as soon as your first month is paid.\n\n'
          || E'1. Sign in: ' || app || E'/app\n2. Open the Money tab and pay your first month' || case when fee > 0 then ' ($' || to_char(fee, 'FM999,990') || ')' else '' end
          || E'.\n3. Tap Start team.\n\nThey begin on their next work hour. Questions? Email admin@destinymarketinggroup.com.',
          'nudge2:' || b.id);
      else
        perform os.alert(b.id, 'business', 'start_nudge', 'Last reminder: your team hasn''t started',
          case when coalesce(first, '') <> '' then 'Hi ' || first || E',\n\n' else '' end
          || 'Your Destiny OS team for ' || b.name || ' has been ready for a week but can''t start until your first month is paid. Once it is, they '
          || what || E'.\n\nPay and start here: ' || app || E'/app (Money tab, then Start team).\n\nIf now isn''t the right time, just reply and let us know. Questions? Email admin@destinymarketinggroup.com.',
          'nudge4:' || b.id);
        perform os.alert(b.id, 'platform', 'unpaid_signup', 'Still unpaid after a week: ' || b.name,
          b.name || ' signed up ' || to_char(started at time zone 'America/New_York', 'Mon FMDD') || ' and hasn''t paid the first month. They got reminders on day 1, 3 and 7. Worth a personal call.',
          'unpaid7:' || b.id);
      end if;
      n := n + 1;
    end if;
    if not unpaid and now() between started + interval '3 days' and started + interval '5 days' then
      select exists (select 1 from os.integrations where business_id = b.id and provider in ('gmail', 'resend') and status = 'connected') into mail;
      select exists (select 1 from os.integrations where business_id = b.id and provider = 'facebook' and status = 'connected') into fb;
      select count(*)::int into cust from os.records where business_id = b.id and type = 'customer';
      select count(*)::int into quotes from os.records where business_id = b.id and type = 'quote';
      select review_link into rl from os.growth_settings where business_id = b.id;
      todo := concat_ws(E'\n',
        case when b.status = 'setup' then '• Start your team (Home, Start team). Nothing happens until you do.' end,
        case when not mail then '• Connect your email (Connections). Without it, the team can draft emails but can''t send them.' end,
        case when not fb then '• Connect your Facebook Page (Connections), so approved posts publish on their own.' end,
        case when cust = 0 then '• Add your past customers (Customers). They''re your cheapest work, and the team can send them seasonal reminders.' end,
        case when quotes = 0 then '• Log a quote you sent (Customers). The team follows up on day 2, 5 and 10 so it doesn''t go quiet.' end,
        case when coalesce(rl, '') = '' then '• Add your Google review link (Customers), so happy customers get asked for a review.' end,
        '• Put your inquiry form link on your website and Facebook (Customers). New inquiries reach you right away.');
      perform os.alert(b.id, 'business', 'start_nudge', 'A few steps to get more from your team',
        'You''re a few days in with Destiny OS at ' || b.name || E'. These steps make the biggest difference:\n\n' || todo
        || E'\n\nEach takes a couple of minutes: ' || app || '/app', 'nudge3:' || b.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $function$;
