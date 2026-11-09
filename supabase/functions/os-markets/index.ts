// os-markets: the platform owner's Markets screen. A watchlist of coins and stocks, price rules that send a phone and
// email alert when they hit (once a day each), and a 7:30 AM brief. Prices only: it never trades and holds no
// exchange keys. Prices: CoinGecko (crypto) and Yahoo Finance (stocks), both public; they can lag a few minutes.
import { audit, secret, sql } from "../_core/core.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-os-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const TZ = "America/New_York";
const RULES: Record<string, string> = { above: "goes above", below: "drops below", up_pct: "is up", down_pct: "is down" };

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function who(req: Request) {
  const t = req.headers.get("x-os-token")?.trim();
  if (!t) return null;
  const [s] = await sql`select s.user_id, u.email from os.sessions s join auth.users u on u.id = s.user_id where s.token_hash = ${await sha256(t)} and s.expires_at > now()`;
  return s ? { id: s.user_id as string, email: s.email as string } : null;
}

async function getJson(url: string) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Destiny OS price check)", accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`price source answered ${r.status}`);
  return await r.json();
}

/** Finds a coin by its ticker (BTC) or CoinGecko id (bitcoin): the biggest coin with that ticker. */
async function findCoin(q: string) {
  const j = await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`);
  const coins: any[] = j.coins ?? [];
  const exact = coins.filter((c) => String(c.symbol).toUpperCase() === q.toUpperCase() || String(c.id) === q.toLowerCase())
    .sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
  return exact[0] ? { id: String(exact[0].id), name: String(exact[0].name), symbol: String(exact[0].symbol).toUpperCase() } : null;
}

async function stockQuote(sym: string) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`);
  const m = j.chart?.result?.[0]?.meta;
  if (!m?.regularMarketPrice) return null;
  const prev = Number(m.chartPreviousClose ?? m.previousClose ?? 0);
  const change = m.regularMarketChangePercent != null ? Number(m.regularMarketChangePercent) : prev ? (Number(m.regularMarketPrice) / prev - 1) * 100 : null;
  return { price: Number(m.regularMarketPrice), change, name: String(m.longName ?? m.shortName ?? sym) };
}

const money = (n: number) => "$" + (n >= 100 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const pct = (n: number | null) => n == null ? "" : `${n >= 0 ? "up" : "down"} ${Math.abs(n).toFixed(1)}%`;

/** Refreshes every price, fires the rules that hit (once a day each), and sends the morning brief. */
async function tick() {
  const watch = await sql`select * from os.market_watch order by id`;
  const coins = watch.filter((w: any) => w.kind === "crypto"), stocks = watch.filter((w: any) => w.kind === "stock");
  const errors: string[] = [];
  if (coins.length) {
    try {
      const j = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${coins.map((c: any) => encodeURIComponent(c.source_id)).join(",")}&vs_currencies=usd&include_24hr_change=true`);
      for (const c of coins) {
        const p = j[c.source_id];
        if (p?.usd != null) await sql`update os.market_watch set last_price = ${p.usd}, change_pct = ${p.usd_24h_change ?? null}, price_at = now() where id = ${c.id}`;
      }
    } catch (e) { errors.push(`crypto: ${(e as Error).message}`); }
  }
  for (const s of stocks) {
    try {
      const q = await stockQuote(s.source_id);
      if (q) await sql`update os.market_watch set last_price = ${q.price}, change_pct = ${q.change}, price_at = now() where id = ${s.id}`;
    } catch (e) { errors.push(`${s.symbol}: ${(e as Error).message}`); }
  }
  const [{ day, hour, minute }] = await sql`select (now() at time zone ${TZ})::date::text as day, extract(hour from now() at time zone ${TZ})::int as hour, extract(minute from now() at time zone ${TZ})::int as minute`;
  // Rules: only on a fresh price, and at most once a day each.
  const hits = await sql`update os.market_rules r set last_fired_on = ${day}::date
    from os.market_watch w where w.id = r.watch_id and r.enabled and w.price_at > now() - interval '30 minutes'
      and r.last_fired_on is distinct from ${day}::date
      and ((r.kind = 'above' and w.last_price >= r.value) or (r.kind = 'below' and w.last_price <= r.value)
        or (r.kind = 'up_pct' and w.change_pct >= r.value) or (r.kind = 'down_pct' and w.change_pct <= -r.value))
    returning r.id, r.kind, r.value, w.symbol, w.kind as asset, w.last_price, w.change_pct`;
  for (const h of hits) {
    const price = Number(h.last_price), ch = h.change_pct == null ? null : Number(h.change_pct);
    const span = h.asset === "crypto" ? "in 24 hours" : "today";
    const subject = h.kind === "above" || h.kind === "below"
      ? `${h.symbol} ${RULES[h.kind]} ${money(Number(h.value))}: now ${money(price)}`
      : `${h.symbol} ${pct(ch)} ${span}: now ${money(price)}`;
    const rule = h.kind === "above" || h.kind === "below" ? `${h.symbol} ${RULES[h.kind]} ${money(Number(h.value))}` : `${h.symbol} ${RULES[h.kind]} ${Number(h.value)}% ${span}`;
    await sql`select os.alert(null, 'platform', 'market', ${subject},
      ${`Your rule hit: ${rule}.\n\n${h.symbol} is at ${money(price)}${ch == null ? "" : ` (${pct(ch)} ${span})`}.\n\nThis rule won't alert again until tomorrow. Prices can lag a few minutes. Destiny OS only watches prices; what you do next is your call.`},
      ${"mkt:" + h.id + ":" + day})`;
  }
  // The morning brief, once, between 7:30 and 7:44 AM New York time.
  let brief = false;
  const [pref] = await sql`select brief from os.market_prefs where id = 1`;
  if (pref?.brief !== false && hour === 7 && minute >= 30 && watch.length) {
    const rows = await sql`select symbol, kind, last_price, change_pct from os.market_watch where last_price is not null order by kind, symbol`;
    const rules = await sql`select r.kind, r.value, w.symbol, w.kind as asset from os.market_rules r join os.market_watch w on w.id = r.watch_id where r.enabled order by w.symbol`;
    const line = (r: any) => `• ${r.symbol}: ${money(Number(r.last_price))}${r.change_pct == null ? "" : `, ${pct(Number(r.change_pct))} ${r.kind === "crypto" ? "in 24 hours" : "since the last close"}`}`;
    const body = [rows.filter((r: any) => r.kind === "crypto").length ? "Crypto\n" + rows.filter((r: any) => r.kind === "crypto").map(line).join("\n") : "",
      rows.filter((r: any) => r.kind === "stock").length ? "Stocks\n" + rows.filter((r: any) => r.kind === "stock").map(line).join("\n") : "",
      rules.length ? "Your alerts\n" + rules.map((r: any) => `• ${r.symbol} ${RULES[r.kind]} ${r.kind.endsWith("pct") ? Number(r.value) + "%" : money(Number(r.value))}`).join("\n") : "No alerts set yet: add them on the Markets screen."]
      .filter(Boolean).join("\n\n") + "\n\nPrices only, for your information. Turn this off on the Markets screen.";
    await sql`select os.alert(null, 'platform', 'market_brief', ${"Markets this morning"}, ${body}, ${"mktbrief:" + day})`;
    brief = true;
  }
  return { prices: watch.length, hits: hits.length, brief, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "tick") {
    const key = await secret("OS_INVOKE_KEY");
    if (!key || req.headers.get("authorization") !== `Bearer ${key}`) return json({ error: "forbidden" }, 403);
    return json(await tick());
  }

  const user = await who(req);
  if (!user) return json({ error: "Please sign in." }, 401);
  const [adm] = await sql`select 1 from os.platform_admins where user_id = ${user.id}`;
  if (!adm) return json({ error: "Only the platform owner has Markets." }, 403);

  if (action === "add_symbol") {
    const kind = body.kind === "stock" ? "stock" : "crypto";
    const q = String(body.symbol ?? "").trim().replace(/^\$/, "").slice(0, 20);
    if (!/^[A-Za-z0-9.\-^=]{1,20}$/.test(q)) return json({ error: "Type a ticker, like BTC or AAPL." }, 400);
    try {
      if (kind === "crypto") {
        const c = await findCoin(q);
        if (!c) return json({ error: `Couldn't find a coin called ${q.toUpperCase()}.` }, 404);
        await sql`insert into os.market_watch (kind, symbol, source_id, name) values ('crypto', ${c.symbol}, ${c.id}, ${c.name}) on conflict (kind, symbol) do nothing`;
      } else {
        const s = await stockQuote(q.toUpperCase());
        if (!s) return json({ error: `Couldn't find a stock called ${q.toUpperCase()}.` }, 404);
        await sql`insert into os.market_watch (kind, symbol, source_id, name, last_price, change_pct, price_at) values ('stock', ${q.toUpperCase()}, ${q.toUpperCase()}, ${s.name}, ${s.price}, ${s.change}, now())
          on conflict (kind, symbol) do nothing`;
      }
    } catch (e) { return json({ error: `The price source didn't answer (${(e as Error).message}). Try again in a minute.` }, 502); }
    await audit(null, "user", user.email, "market_add", q.toUpperCase(), { kind });
    await tick().catch(() => null); // show a price right away
  } else if (action === "remove_symbol") {
    await sql`delete from os.market_watch where id = ${Number(body.id)}`;
  } else if (action === "add_rule") {
    const kind = String(body.kind ?? ""), value = Number(String(body.value ?? "").replace(/[$,%\s]/g, ""));
    if (!RULES[kind]) return json({ error: "Pick what to watch for." }, 400);
    if (!(value > 0)) return json({ error: kind.endsWith("pct") ? "Add the percent, like 5." : "Add the price, like 70000." }, 400);
    if (kind.endsWith("pct") && value > 100) return json({ error: "Use a percent under 100." }, 400);
    const [w] = await sql`select id from os.market_watch where id = ${Number(body.watch_id)}`;
    if (!w) return json({ error: "Not found." }, 404);
    await sql`insert into os.market_rules (watch_id, kind, value) values (${w.id}, ${kind}, ${value})`;
  } else if (action === "remove_rule") {
    await sql`delete from os.market_rules where id = ${Number(body.id)}`;
  } else if (action === "set_brief") {
    await sql`update os.market_prefs set brief = ${body.on === true} where id = 1`;
  } else if (action !== "list") return json({ error: "Unknown action." }, 400);

  const watch = await sql`select id, kind, symbol, name, last_price, change_pct, price_at from os.market_watch order by kind, symbol`;
  const rules = await sql`select id, watch_id, kind, value, enabled, last_fired_on from os.market_rules order by id`;
  const [pref] = await sql`select brief from os.market_prefs where id = 1`;
  return json({ watch, rules, brief: pref?.brief !== false });
});
