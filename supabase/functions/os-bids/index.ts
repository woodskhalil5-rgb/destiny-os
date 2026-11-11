// os-bids: Bid Desk's bid collector. Reads public open-bid lists (only sources marked terms_ok and active in
// os.bid_sources), saves each notice in os.bids with a link back to it, tags trades and county, then runs
// os.bid_match() so every contractor on Bid Desk's list gets the bids that fit them.
// Called by cron with the OS_INVOKE_KEY. Actions: collect (all due sources, or one with source_id), probe (debug:
// returns the start of a source's page so a parser can be written). Never logs in, never submits anything.
// Self-contained on purpose (no shared imports), so it can be deployed on its own.
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20 });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const UA = "DestinyOS-BidDesk/1.0 (+https://app.destinymarketinggroup.com/bids)";

async function secret(name: string): Promise<string | null> {
  const [s] = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name}`;
  return (s?.decrypted_secret as string) ?? Deno.env.get(name)?.trim() ?? null;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
const text = (h: string) => h.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? (e.startsWith("#") ? String.fromCharCode(Number(e.slice(1))) : m)).replace(/\s+/g, " ").trim();
const abs = (href: string, base: string) => { try { return new URL(href.replace(/&amp;/g, "&"), base).toString(); } catch { return base; } };

// Trades a notice is about, from its title. Contractors' trades are mapped to the same words in SQL (os.bid_trades).
const TRADES: [string, RegExp][] = [
  ["roofing", /\broof/i],
  ["hvac", /hvac|boiler|chiller|heating|air[- ]condition|cooling tower|rooftop unit|\brtu\b|ventilat|mechanical|heat pump|steam/i],
  ["plumbing", /plumb|domestic water|sewer|water heater|sanitary|piping/i],
  ["electrical", /electric|generator|lighting|switchgear|fire alarm|\bups\b|transformer/i],
  ["paving", /paving|asphalt|resurfac|parking (lot|area)|milling|roadway/i],
  ["masonry", /masonry|brick|concrete|sidewalk|curb|stucco|repoint|retaining wall|facade/i],
  ["hardscaping", /patio|paver|retaining wall|walkway|sidewalk|plaza/i],
  ["landscaping", /landscap|mowing|lawn|grounds maint|tree (removal|trimming|service)|planting/i],
  ["painting", /\bpaint/i],
  ["windows_doors", /window|\bdoors?\b|glazing|curtain wall|storefront/i],
  ["flooring", /floor|carpet|\btile\b/i],
  ["demolition", /demoli|abatement|asbestos/i],
  ["fencing", /\bfenc/i],
  ["cleaning", /janitorial|cleaning|custodial/i],
  ["pest", /pest|extermin/i],
  ["general", /renovat|new .*building|addition|alteration|interior|framing|repairs?\b|rehabilitat|upgrade|replacement|construction/i],
];
const tagTrades = (t: string) => TRADES.filter(([, re]) => re.test(t)).map(([n]) => n);
const COUNTIES = ["Atlantic", "Bergen", "Burlington", "Camden", "Cape May", "Cumberland", "Essex", "Gloucester", "Hudson", "Hunterdon", "Mercer",
  "Middlesex", "Monmouth", "Morris", "Ocean", "Passaic", "Salem", "Somerset", "Sussex", "Union", "Warren"];
const county = (t: string) => COUNTIES.find((c) => new RegExp(`\\b${c}\\s+(County|Co\\.)`, "i").test(t)) ?? null;
const money = (t: string) => { const m = t.match(/\$\s*([\d,]+(?:\.\d+)?)/); return m ? Number(m[1].replace(/,/g, "")) : null; };
// US date (MM/DD/YYYY, optional time) as New Jersey time.
function njDate(s: string): string | null {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (!m) return null;
  let h = m[4] ? Number(m[4]) : 14; const min = m[5] ? Number(m[5]) : 0;
  if (m[6]?.toUpperCase() === "PM" && h < 12) h += 12; if (m[6]?.toUpperCase() === "AM" && h === 12) h = 0;
  const month = Number(m[1]);
  const off = month >= 4 && month <= 10 ? "-04:00" : "-05:00"; // close enough for a due date shown to people (DST edges are a day off at most)
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00${off}`;
}
const rows = (html: string) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1]));

type Bid = { ref: string; title: string; agency: string | null; county: string | null; trades: string[]; due_at: string | null;
  est: number | null; url: string; docs: string | null; status: "open" | "closed" | "cancelled" | "awarded"; prevailing: boolean | null; pwcr: boolean | null };

// NJ Division of Property Management & Construction: one table, columns project #, description/location, estimate, due date(s), status.
function parseDpmc(html: string, base: string): Bid[] {
  const out: Bid[] = [];
  for (const c of rows(html)) {
    if (c.length < 4) continue;
    const ref = text(c[0]); if (!/^[A-Z]\d{3,5}-\d{2}/.test(ref)) continue;
    const title = text(c[1]); const dueTxt = text(c[3]); const statusTxt = text(c[4] ?? "");
    const dates = [...dueTxt.matchAll(/\d{1,2}\/\d{1,2}\/\d{4}/g)].map((d) => d[0]);
    const due = njDate(dates[dates.length - 1] ?? "");
    const href = c[0].match(/href="([^"]+)"/i)?.[1];
    const past = due ? new Date(due).getTime() < Date.now() : false;
    const status = /cancel/i.test(statusTxt) ? "cancelled" : /award|ntp/i.test(statusTxt) ? "awarded" : past || /result|no bids/i.test(statusTxt) ? "closed" : "open";
    out.push({ ref: ref.split(" ")[0], title, agency: "NJ Treasury, Div. of Property Management & Construction", county: county(title), trades: tagTrades(title),
      due_at: due, est: money(text(c[2])), url: href ? abs(href, base) : base, docs: href ? abs(href, base) : null, status, prevailing: true, pwcr: true });
  }
  return out;
}

// NJSTART public bid search (no login): bid #, organization, contract #, buyer, description, opening date, awarded vendor, status.
function parseNjstart(html: string, base: string): Bid[] {
  const out: Bid[] = [];
  for (const c of rows(html)) {
    const cells = c.map(text);
    const i = cells.findIndex((x) => /^\d{2}[A-Z]{3}\d{5}$/.test(x)); if (i < 0) continue;
    const ref = cells[i];
    const href = c[i].match(/href="([^"]+)"/i)?.[1] ?? c.join(" ").match(/href="([^"]*bidDetail[^"]*)"/i)?.[1];
    const dateCell = cells.find((x) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(x)) ?? "";
    const title = cells.filter((x, j) => j > i && x.length > 12 && !/\d{1,2}\/\d{1,2}\/\d{4}/.test(x) && !/^Division|^Department/i.test(x))
      .sort((a, b) => b.length - a.length)[0] ?? ref;
    const agency = cells.find((x) => /^(Division|Department|Office|Commission|Authority|NJ |New Jersey)/i.test(x)) ?? "State of New Jersey (NJSTART)";
    const due = njDate(dateCell);
    out.push({ ref, title, agency, county: county(title), trades: tagTrades(title), due_at: due, est: null,
      url: href ? abs(href, base) : base, docs: null, status: due && new Date(due).getTime() < Date.now() ? "closed" : "open", prevailing: null, pwcr: null });
  }
  return out;
}

function parserFor(url: string) {
  if (url.includes("nj.gov/treasury/dpmc")) return parseDpmc;
  if (url.includes("njstart.gov")) return parseNjstart;
  return null;
}
function fetchUrl(url: string) {
  return url.includes("njstart.gov") && !url.includes("advancedSearchBid") ? "https://www.njstart.gov/bso/view/search/external/advancedSearchBid.xhtml?openBids=true" : url;
}

async function collect(sourceId?: number) {
  const sources = await sql`select * from os.bid_sources where active and terms_ok
    and (${sourceId ?? null}::bigint is null and (last_checked_at is null or last_checked_at < now() - check_every + interval '10 minutes') or id = ${sourceId ?? null}::bigint)`;
  const report: Record<string, unknown>[] = [];
  for (const s of sources) {
    const parse = parserFor(s.url);
    if (!parse) { report.push({ source: s.name, skipped: "no collector for this site yet" }); continue; }
    try {
      const res = await fetch(fetchUrl(s.url), { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`site answered ${res.status}`);
      const bids = parse(await res.text(), fetchUrl(s.url));
      if (!bids.length) throw new Error("no bids found on the page (layout may have changed)");
      let added = 0;
      for (const b of bids) {
        const [r] = await sql`insert into os.bids (source_id, external_ref, title, agency, county, trade_tags, due_at, est_value_usd, url, documents_url, status, prevailing_wage, pwcr_required)
          values (${s.id}, ${b.ref}, ${b.title.slice(0, 500)}, ${b.agency}, ${b.county}, ${b.trades}, ${b.due_at}, ${b.est}, ${b.url}, ${b.docs}, ${b.status}, ${b.prevailing}, ${b.pwcr})
          on conflict (source_id, external_ref) do update set title = excluded.title, county = excluded.county, trade_tags = excluded.trade_tags,
            due_at = excluded.due_at, est_value_usd = coalesce(excluded.est_value_usd, os.bids.est_value_usd), url = excluded.url,
            documents_url = coalesce(excluded.documents_url, os.bids.documents_url), status = excluded.status,
            updated_at = case when (os.bids.due_at, os.bids.status, os.bids.title) is distinct from (excluded.due_at, excluded.status, excluded.title) then now() else os.bids.updated_at end
          returning (xmax = 0) as inserted`;
        if (r?.inserted) added++;
      }
      await sql`update os.bid_sources set last_checked_at = now(), last_ok_at = now(), last_error = null where id = ${s.id}`;
      report.push({ source: s.name, seen: bids.length, new: added, open: bids.filter((b) => b.status === "open").length });
    } catch (e) {
      await sql`update os.bid_sources set last_checked_at = now(), last_error = ${(e as Error).message.slice(0, 300)} where id = ${s.id}`;
      report.push({ source: s.name, error: (e as Error).message });
    }
  }
  const [m] = await sql`select os.bid_match() as n`;
  return { sources: report, new_matches: m?.n ?? 0 };
}

Deno.serve(async (req) => {
  const key = await secret("OS_INVOKE_KEY");
  if (!key || req.headers.get("authorization") !== `Bearer ${key}`) return json({ error: "forbidden" }, 403);
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === "collect") return json(await collect(body.source_id ? Number(body.source_id) : undefined));
    if (body.action === "probe") {
      const [s] = await sql`select url from os.bid_sources where id = ${Number(body.source_id)}`;
      if (!s) return json({ error: "no such source" }, 404);
      const res = await fetch(fetchUrl(s.url), { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(45000) });
      const html = await res.text(); const parse = parserFor(s.url);
      const at = Math.max(0, html.search(new RegExp(body.find ?? "<table", "i")));
      return json({ status: res.status, length: html.length, sample: html.slice(at, at + Number(body.n ?? 3000)), parsed: parse ? parse(html, fetchUrl(s.url)).slice(0, 5) : null });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
