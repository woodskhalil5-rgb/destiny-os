-- Market alerts for the platform owner (the Markets screen): a watchlist of coins and stocks, price rules that
-- send a phone and email alert when they hit, and a morning brief. Prices only: nothing here trades or holds keys.

create table if not exists os.market_watch (
  id bigserial primary key,
  kind text not null check (kind in ('crypto', 'stock')),
  symbol text not null,            -- what the owner typed, upper case (BTC, AAPL)
  source_id text not null,         -- CoinGecko id for crypto, Yahoo symbol for stocks
  name text,
  last_price numeric,
  change_pct numeric,              -- crypto: last 24 hours; stocks: since the previous close
  price_at timestamptz,
  created_at timestamptz not null default now(),
  unique (kind, symbol)
);

create table if not exists os.market_rules (
  id bigserial primary key,
  watch_id bigint not null references os.market_watch(id) on delete cascade,
  kind text not null check (kind in ('above', 'below', 'up_pct', 'down_pct')),
  value numeric not null check (value > 0),
  enabled boolean not null default true,
  last_fired_on date,              -- one alert per rule per day (New York time)
  created_at timestamptz not null default now()
);

create table if not exists os.market_prefs (
  id int primary key default 1 check (id = 1),
  brief boolean not null default true
);
insert into os.market_prefs (id) values (1) on conflict do nothing;

alter table os.market_watch enable row level security;
alter table os.market_rules enable row level security;
alter table os.market_prefs enable row level security;

-- Prices every 15 minutes; the morning brief at 7:30 AM New York time (the function checks the local hour).
select cron.schedule('os-markets', '*/15 * * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'OS_FUNCTIONS_URL') || '/os-markets',
    headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'OS_INVOKE_KEY'), 'content-type', 'application/json'),
    body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 60000)
  where exists (select 1 from os.market_watch)
$cron$) where not exists (select 1 from cron.job where jobname = 'os-markets');
