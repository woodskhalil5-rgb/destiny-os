// os-callsheet: the "call from your own phone" call sheet for businesses that turn it on (config.call_sheet = 'own_phone'),
// e.g. Jersey Home Pros. Same as the WhatsApp call sheet African businesses use (os-growth wa_sheet / wa_log), but each
// row has a tap-to-call link for the rep's own phone instead of WhatsApp. No texting, no autodialing: the rep dials.
// Self-contained on purpose (no shared imports), so it can be deployed on its own.
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20 });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-os-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const clip = (v: unknown, n: number) => (v == null ? "" : String(v)).trim().slice(0, n);

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// A dialable number with country code, from whatever was saved (US default: +1).
function tel(raw: unknown, cc: string) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  else if (cc === "1" && d.length === 10) d = "1" + d;
  else if (d.startsWith("0") && cc) d = cc + d.slice(1);
  return d.length >= 10 ? "+" + d : "";
}

const OUT: Record<string, [string, string | null, boolean]> = {
  no_answer: ["No answer", "called", false], callback: ["Call back", "called", true], not_interested: ["Not interested", "lost", false],
  meeting: ["Meeting booked", "meeting", true], signed: ["Signed up", "signed", true], wrong_number: ["Wrong number", "lost", false],
};

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
  const [c] = await sql`select config->>'call_sheet' as mode, coalesce(config->>'call_sheet_country', '1') as cc from os.business_config where business_id = ${bid} and active`;
  if (c?.mode !== "own_phone") return json({ enabled: false });

  if (body.action === "sheet") {
    const rows = await sql`select id, title, status, data from os.records where business_id = ${bid}
      and status in ('call planned', 'called', 'meeting') and (data ? 'call_plan' or status <> 'call planned')
      order by case status when 'call planned' then 0 when 'called' then 1 when 'meeting' then 2 else 3 end,
        case upper(coalesce(data->>'priority', '')) when 'A' then 0 when 'B' then 1 else 2 end, os.num(data->>'score') desc nulls last, id limit 80`;
    const [done] = await sql`select count(*) filter (where started_at > now() - interval '1 day')::int as today,
      count(*) filter (where started_at > now() - interval '7 days')::int as week from os.calls where business_id = ${bid} and status = 'manual'`;
    return json({ enabled: true, rows: rows.map((r: any) => {
      const d = r.data ?? {};
      return { id: r.id, title: r.title, status: r.status, area: d.area ?? d.county ?? d.city ?? null, priority: d.priority ?? null, score: d.score ?? null,
        tel: tel(d.phone, c.cc), phone: d.phone ?? null, gaps: d.gaps ?? d.trade ?? null, call_plan: d.call_plan ?? null,
        last: Array.isArray(d.calls) ? d.calls[d.calls.length - 1] : null };
    }), done });
  }

  if (body.action === "log") {
    if (role === "viewer") return json({ error: "Viewers can't log calls." }, 403);
    const o = OUT[String(body.outcome)];
    if (!o) return json({ error: "Pick what happened." }, 400);
    const note = clip(body.note, 1000), when = /^\d{4}-\d{2}-\d{2}$/.test(String(body.when ?? "")) ? String(body.when) : null;
    const entry = { at: new Date().toISOString(), by: user.email, outcome: body.outcome, ...(note ? { note } : {}), ...(when ? { when } : {}) };
    const [r] = await sql`update os.records set status = ${o[1]}, updated_at = now(),
        next_step = ${body.outcome === "callback" ? `call back${when ? " on " + when : ""}` : body.outcome === "no_answer" ? "try again" : body.outcome === "meeting" ? `meeting${when ? " on " + when : ""}` : null},
        next_step_due = ${when ?? (body.outcome === "no_answer" ? new Date(Date.now() + 86400000).toISOString().slice(0, 10) : null)},
        data = jsonb_set(data, '{calls}', coalesce(data->'calls', '[]'::jsonb) || ${sql.json([entry])})
      where id = ${Number(body.id)} and business_id = ${bid} returning id, title, data->>'phone' as phone`;
    if (!r) return json({ error: "Not found." }, 404);
    await sql`insert into os.calls (business_id, direction, to_number, record_id, user_id, status, outcome, note, ended_at, duration_sec, minutes, cost_usd, billed_usd)
      values (${bid}, 'outbound', ${tel(r.phone, c.cc) || null}, ${r.id}, ${user.id}, 'manual', ${String(body.outcome)}, ${note || null}, now(), 0, 0, 0, 0)`;
    if (body.outcome === "signed") await sql`insert into os.wins (business_id, kind, record_id, created_by) values (${bid}, 'job', ${r.id}, ${user.email})`;
    await sql`insert into os.messages (business_id, sender, body, status, record_id) values (${bid}, 'system',
      ${`${o[2] ? "@demarcus " : ""}Call logged: #${r.id} ${r.title}: ${o[0]}${when ? ` (${when})` : ""}.${note ? ` Notes: ${note}` : ""}`},
      ${o[2] ? "queued" : "handled"}, ${r.id})`;
    await sql`insert into os.activity_log (business_id, actor_type, actor, action, target, details)
      values (${bid}, 'user', ${user.email}, 'manual_call', ${String(r.id)}, ${sql.json({ outcome: body.outcome })})`;
    return json({ ok: true });
  }
  return json({ error: "Unknown action." }, 400);
});
