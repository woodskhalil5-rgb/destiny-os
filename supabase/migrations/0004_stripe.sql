-- Stripe billing. Each customer business pays a $650 platform fee plus its usage and other charges,
-- invoiced on the 1st of the month for the month before. Card details live only at Stripe.

alter table os.businesses alter column platform_fee_usd set default 650;
alter table os.businesses
  add column if not exists stripe_customer_id text unique,
  add column if not exists billing_status text not null default 'none'
    check (billing_status in ('none','card_needed','active','past_due'));

-- One row per business per billed month.
create table if not exists os.invoices (
  id bigserial primary key,
  business_id uuid not null references os.businesses(id) on delete cascade,
  month date not null,
  stripe_invoice_id text unique,
  amount_usd numeric not null default 0,
  status text not null default 'draft',
  hosted_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, month)
);
alter table os.invoices enable row level security;
grant select on os.invoices to authenticated;
create policy member_read on os.invoices for select to authenticated using (os.member_role(business_id) is not null);
grant all on os.invoices to service_role;

-- Stripe event ids already handled, so a retried webhook is never applied twice.
create table if not exists os.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
alter table os.stripe_events enable row level security;
grant all on os.stripe_events to service_role;
grant all on all sequences in schema os to service_role;

-- 1st of every month, 9 AM New York (14:00 UTC): invoice last month.
create or replace function os.monthly_billing() returns void language plpgsql security definer set search_path = os, public as $$
begin
  perform net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-billing',
    headers := jsonb_build_object('content-type','application/json','authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY')),
    body := jsonb_build_object('action','run_month'),
    timeout_milliseconds := 5000);
end $$;
revoke all on function os.monthly_billing() from public;
select cron.schedule('os-monthly-billing', '0 14 1 * *', 'select os.monthly_billing()');

-- A business with an overdue payment is on hold: nothing wakes its agents until it's paid.
create or replace function os.wake_router() returns trigger language plpgsql security definer set search_path = os, public as $$
begin
  if new.status = 'queued' then
    if exists (select 1 from os.businesses where id = new.business_id and billing_status = 'past_due') then
      update os.messages set status = 'handled' where id = new.id;
      if new.sender = 'owner' or new.sender like 'user:%' then
        insert into os.messages (business_id, sender, body, status) values (new.business_id, 'system',
          'The team is on hold: a payment is overdue. Update the card on the Costs tab and they''ll pick right back up.', 'handled');
      end if;
      return new;
    end if;
    perform net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-brain',
      headers := jsonb_build_object('content-type','application/json','authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY')),
      body := jsonb_build_object('message_id', new.id),
      timeout_milliseconds := 5000);
  end if;
  return new;
end $$;
