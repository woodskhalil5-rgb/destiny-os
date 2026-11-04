// os-api: the dashboard's backend for every business. People sign in with Supabase Auth (email code);
// every action checks the person's role in that business before reading or writing anything.
import { audit, post, sql } from "../_core/core.ts";
import { execute } from "../_core/tools.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const RANK: Record<string, number> = { viewer: 1, operator: 2, admin: 3, owner: 4 };

async function who(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { authorization: `Bearer ${token}`, apikey: Deno.env.get("SUPABASE_ANON_KEY")! } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? { id: u.id as string, email: u.email as string } : null;
}

async function role(uid: string, bid: string) {
  const [a] = await sql`select 1 from os.platform_admins where user_id = ${uid}`;
  if (a) return "owner";
  const [m] = await sql`select role from os.business_members where user_id = ${uid} and business_id = ${bid}`;
  return (m?.role as string) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const user = await who(req);
  if (!user) return json({ error: "Please sign in." }, 401);
  const body = await req.json().catch(() => ({}));
  const { action, business_id: bid } = body;

  if (action === "me") {
    // The platform owner (email set in the vault as OS_OWNER_EMAIL) becomes the platform admin on first sign-in.
    const [ownerEmail] = await sql`select decrypted_secret as e from vault.decrypted_secrets where name = 'OS_OWNER_EMAIL'`;
    if (ownerEmail && String(ownerEmail.e).toLowerCase() === String(user.email).toLowerCase()) {
      await sql`insert into os.platform_admins (user_id) values (${user.id}) on conflict do nothing`;
    }
    const [admin] = await sql`select 1 from os.platform_admins where user_id = ${user.id}`;
    const biz = admin
      ? await sql`select id, slug, name, status, 'owner' as role from os.businesses where status <> 'archived' order by name`
      : await sql`select b.id, b.slug, b.name, b.status, m.role from os.businesses b join os.business_members m on m.business_id = b.id and m.user_id = ${user.id} where b.status <> 'archived' order by b.name`;
    return json({ user, admin: !!admin, businesses: biz });
  }

  const r = bid ? await role(user.id, bid) : null;
  if (!r) return json({ error: "You don't have access to that business." }, 403);
  const need = (min: string) => RANK[r] >= RANK[min];
  const me = r === "owner" ? "owner" : `user:${user.id}`;

  if (action === "feed") {
    const since = Number(body.since_id ?? 0);
    const msgs = since
      ? await sql`select id, created_at, sender, sender_name, body from os.messages where business_id = ${bid} and id > ${since} order by id limit 200`
      : (await sql`select id, created_at, sender, sender_name, body from os.messages where business_id = ${bid} order by id desc limit 150`).reverse();
    const [b] = await sql`select id, slug, name, status, timezone, shift_start, shift_end, shift_days, monthly_budget_usd, plan from os.businesses where id = ${bid}`;
    const team = await sql`select a.slot, a.name, a.handle, ba.enabled from os.agents a join os.business_agents ba on ba.slot = a.slot and ba.business_id = ${bid} order by a.sort`;
    const approvals = await sql`select * from os.approvals where business_id = ${bid} order by id desc limit 60`;
    const content = await sql`select * from os.content where business_id = ${bid} order by id desc limit 60`;
    const records = await sql`select id, type, status, title, data, next_step, next_step_due, updated_at from os.records where business_id = ${bid} order by updated_at desc limit 200`;
    const tasks = await sql`select t.*, a.name as assignee from os.tasks t left join os.agents a on a.slot = t.assignee_slot where t.business_id = ${bid} and t.status in ('open','in_progress','blocked') order by t.id desc limit 60`;
    const [usage] = await sql`select coalesce(sum(cost_usd),0) as usd, count(*)::int as calls, coalesce(sum(input_tokens+output_tokens),0)::bigint as tokens from os.usage_events where business_id = ${bid} and at >= date_trunc('month', now())`;
    const working = await sql`select slot from os.agent_runs where business_id = ${bid} and status = 'running' and started_at > now() - interval '4 minutes'`;
    return json({ role: r, business: b, team, messages: msgs, approvals, content, records, tasks, usage, working: working.map((w: any) => w.slot) });
  }

  if (action === "post") {
    if (!need("operator")) return json({ error: "Viewers can't post." }, 403);
    const text = String(body.body ?? "").trim().slice(0, 4000);
    if (!text) return json({ error: "Message is empty." }, 400);
    const id = await post(bid, me, text, { senderName: r === "owner" ? "Owner" : user.email });
    await audit(bid, "user", user.email, "post", String(id));
    return json({ ok: true, id });
  }

  if (action === "pause") {
    if (!need("admin")) return json({ error: "Only admins can pause the team." }, 403);
    await sql`update os.businesses set status = ${body.paused ? "paused" : "live"} where id = ${bid}`;
    await post(bid, "system", body.paused ? "The team is paused." : "The team is back to work.", { status: "handled" });
    await audit(bid, "user", user.email, body.paused ? "pause" : "resume", bid);
    return json({ ok: true });
  }

  if (action === "decide") {
    if (!need("operator")) return json({ error: "Viewers can't approve." }, 403);
    const [ap] = await sql`select * from os.approvals where id = ${body.id} and business_id = ${bid}`;
    if (!ap) return json({ error: "Not found." }, 404);
    if (!["pending", "failed"].includes(ap.status)) return json({ error: `Already ${ap.status}.` }, 409);
    const payload = body.payload ?? ap.payload;
    const note = body.note ? String(body.note).slice(0, 1000) : null;
    await audit(bid, "user", user.email, `approval:${body.decision}`, String(ap.id), { note });
    if (body.decision === "reject") {
      await sql`update os.approvals set status = 'rejected', decided_by = ${"user:" + user.id}, decided_at = now(), note = ${note} where id = ${ap.id}`;
      await post(bid, "system", `The owner rejected approval #${ap.id} (${ap.summary}).${note ? " Why: " + note : ""} @demarcus learn from it; @${(await sql`select handle from os.agents where slot = ${ap.requested_by}`)[0]?.handle ?? "demarcus"} redo it if it's worth saving.`);
      return json({ ok: true });
    }
    await sql`update os.approvals set status = 'approved', payload = ${sql.json(payload)}, decided_by = ${"user:" + user.id}, decided_at = now(), note = ${note} where id = ${ap.id}`;
    const [b] = await sql`select * from os.businesses where id = ${bid}`;
    try {
      const result = await execute(b as any, { ...ap, payload });
      const edited = JSON.stringify(payload) !== JSON.stringify(ap.original_payload);
      await post(bid, "system", `The owner approved #${ap.id}${edited ? " with edits" : ""}: ${result}.${edited || note ? " @demarcus compare what changed and update your guide." : ""}`, { status: edited || note ? "queued" : "handled" });
      return json({ ok: true, result });
    } catch (e) {
      await sql`update os.approvals set status = 'failed', note = ${(e as Error).message} where id = ${ap.id}`;
      return json({ error: `Approved, but it couldn't be carried out: ${(e as Error).message}` }, 502);
    }
  }

  if (action === "decide_content") {
    if (!need("operator")) return json({ error: "Viewers can't approve." }, 403);
    const [c] = await sql`select * from os.content where id = ${body.id} and business_id = ${bid}`;
    if (!c) return json({ error: "Not found." }, 404);
    const approve = body.decision === "approve";
    const text = body.body != null ? String(body.body) : c.body;
    const note = body.note ? String(body.note).slice(0, 1000) : null;
    await sql`update os.content set status = ${approve ? "approved" : "rejected"}, body = ${text}, note = ${note} where id = ${c.id}`;
    await audit(bid, "user", user.email, `content:${approve ? "approve" : "reject"}`, String(c.id), { note });
    await post(bid, "system", approve ? `The owner approved content #${c.id}${text !== c.body ? " with edits" : ""}.${note ? " " + note : ""} @grayson schedule it.`
      : `The owner rejected content #${c.id}.${note ? " Why: " + note : ""} @grayson redo it if it's worth saving.`);
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
});
