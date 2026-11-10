// os-deals: the offer calculator on property records (house flippers, wholesalers, anyone who makes offers).
// Max offer = after-repair value × percent − repairs − fee. Saved onto the record so the team and the owner see the same numbers.
// POST (x-os-token) {business_id, record_id, arv, repairs, fee?, pct?, offer?}. Self-contained so it deploys on its own.
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20 });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-os-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const money = (v: unknown) => { const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };

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

  const arv = money(body.arv), repairs = money(body.repairs) ?? 0, fee = money(body.fee) ?? 0, offer = money(body.offer);
  const pct = Math.min(100, Math.max(1, Number(body.pct) || 70));
  if (!arv) return json({ error: "Enter the after-repair value." }, 400);
  const max = Math.max(0, Math.round(arv * pct / 100 - repairs - fee));
  const patch: Record<string, unknown> = { arv, repairs, fee, offer_pct: pct, max_offer: max };
  if (offer != null) patch.offer = offer;
  const [r] = await sql`update os.records set data = data || ${sql.json(patch as any)}, updated_at = now()
    where id = ${Number(body.record_id)} and business_id = ${bid} returning id, title`;
  if (!r) return json({ error: "Not found." }, 404);
  await sql`insert into os.activity_log (business_id, actor_type, actor, action, target, details)
    values (${bid}, 'user', ${user.email}, 'deal_numbers', ${String(r.id)}, ${sql.json(patch as any)})`;
  return json({ ok: true, ...patch });
});
