// os-deals: the deal calculator on property records. Two modes, picked per deal (the business sets its default):
//   cash            max offer = after-repair value × percent − repairs − fee
//   seller_finance  monthly payment on (price − down payment) at the seller's rate and term; cash flow against rent;
//                   cash you bring = earnest money + appraisal (+ anything the lender doesn't cover).
// POST (x-os-token) {business_id, record_id, mode, ...numbers}. Saved onto the record so the team and owner see the same numbers.
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20 });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-os-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const num = (v: unknown) => { const s = String(v ?? "").replace(/[$,%\s]/g, ""); if (!s) return null; const n = Number(s); return Number.isFinite(n) && n >= 0 ? n : null; };
const r0 = (n: number) => Math.round(n);

function payment(loan: number, ratePct: number, years: number) {
  const n = Math.round(years * 12);
  if (loan <= 0 || n <= 0) return 0;
  const r = ratePct / 100 / 12;
  return r === 0 ? loan / n : (loan * r) / (1 - Math.pow(1 + r, -n));
}

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const t = req.headers.get("x-os-token")?.trim();
  const [user] = t ? await sql`select s.user_id as id, u.email from os.sessions s join auth.users u on u.id = s.user_id
    where s.token_hash = ${await sha256(t)} and s.expires_at > now()` : [];
  if (!user) return json({ error: "Please sign in again." }, 401);
  const body = await req.json().catch(() => ({}));
  const bid = String(body.business_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(bid)) return json({ error: "Pick a business." }, 400);
  const [isAdmin] = await sql`select 1 from os.platform_admins where user_id = ${user.id}`;
  const [m] = await sql`select role from os.business_members where user_id = ${user.id} and business_id = ${bid}`;
  const role = isAdmin ? "owner" : m?.role;
  if (!role) return json({ error: "You don't have access to that business." }, 403);
  if (!["owner", "admin", "operator"].includes(role)) return json({ error: "Only owners, admins and operators can change deal numbers." }, 403);

  const mode = body.mode === "seller_finance" ? "seller_finance" : "cash";
  let patch: Record<string, unknown>;
  if (mode === "cash") {
    const arv = num(body.arv), repairs = num(body.repairs) ?? 0, fee = num(body.fee) ?? 0, offer = num(body.offer);
    const pct = Math.min(100, Math.max(1, num(body.pct) ?? 70));
    if (!arv) return json({ error: "Enter the after-repair value." }, 400);
    patch = { offer_mode: mode, arv: r0(arv), repairs: r0(repairs), fee: r0(fee), offer_pct: pct, max_offer: Math.max(0, r0(arv * pct / 100 - repairs - fee)) };
    if (offer != null) patch.offer = r0(offer);
  } else {
    const price = num(body.price), down = num(body.down) ?? 0, rate = num(body.rate) ?? 0, years = num(body.years) ?? 30;
    const rent = num(body.rent) ?? 0, costs = num(body.costs) ?? 0, emd = num(body.emd) ?? 0, appraisal = num(body.appraisal) ?? 0, other = num(body.other) ?? 0;
    // Optional loan (e.g. a DSCR loan) that funds the down payment; whatever is left after the down payment, lender fee and
    // closing costs is the take-home at closing (the residual).
    const loan = num(body.loan) ?? 0, loanRate = num(body.loan_rate) ?? 0, loanYears = num(body.loan_years) ?? 30, lenderFee = num(body.lender_fee) ?? 0, closing = num(body.closing) ?? 0;
    if (!price) return json({ error: "Enter the purchase price." }, 400);
    if (down > price) return json({ error: "The down payment can't be more than the price." }, 400);
    const pmt = payment(price - down, rate, years), mort = payment(loan, loanRate, loanYears);
    patch = { offer_mode: mode, price: r0(price), down: r0(down), rate, years, rent: r0(rent), costs: r0(costs), emd: r0(emd), appraisal: r0(appraisal), other: r0(other),
      loan: r0(loan), loan_rate: loanRate, loan_years: loanYears, lender_fee: r0(lenderFee), closing: r0(closing),
      seller_carry: r0(price - down), payment: r0(pmt), mortgage: r0(mort), cash_flow: r0(rent - pmt - mort - costs),
      residual: loan ? r0(loan - down - lenderFee - closing) : null, cash_to_close: r0(emd + appraisal + other), lender_covers: r0(loan || down) };
  }
  const [r] = await sql`update os.records set data = data || ${sql.json(patch as any)}, updated_at = now()
    where id = ${Number(body.record_id)} and business_id = ${bid} returning id`;
  if (!r) return json({ error: "Not found." }, 404);
  await sql`insert into os.activity_log (business_id, actor_type, actor, action, target, details)
    values (${bid}, 'user', ${user.email}, 'deal_numbers', ${String(r.id)}, ${sql.json(patch as any)})`;
  return json({ ok: true, ...patch });
});
