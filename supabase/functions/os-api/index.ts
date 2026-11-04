// os-api: the dashboard's backend for every business. People sign in with Supabase Auth (email code);
// every action checks the person's role in that business before reading or writing anything.
import { audit, post, sql } from "../_core/core.ts";
import { execute } from "../_core/tools.ts";
import { ensureCustomer, stripe } from "../_core/stripe.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-os-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const RANK: Record<string, number> = { viewer: 1, operator: 2, admin: 3, owner: 4 };

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Sign-in: a 6-digit code emailed only to the platform owner or people who belong to a business. */
async function login(body: any) {
  const email = String(body.email ?? "").trim().toLowerCase();
  const [owner] = await sql`select lower(decrypted_secret) as e from vault.decrypted_secrets where name = 'OS_OWNER_EMAIL'`;
  const [known] = await sql`select u.id from auth.users u where lower(u.email) = ${email}
    and (exists (select 1 from os.business_members m where m.user_id = u.id) or exists (select 1 from os.platform_admins a where a.user_id = u.id))`;
  const allowed = !!email && (email === owner?.e || !!known);
  if (body.action === "request_code") {
    if (allowed) {
      const [{ n }] = await sql`select count(*)::int as n from os.login_codes where email = ${email} and created_at > now() - interval '1 hour'`;
      if (n >= 8) return json({ error: "Too many codes requested. Try again in an hour." }, 429);
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
      await sql`insert into os.login_codes (email, code_hash, expires_at) values (${email}, ${await sha256(code)}, now() + interval '15 minutes')`;
      const [mu] = await sql`select decrypted_secret as u from vault.decrypted_secrets where name = 'OS_MAIL_USER'`;
      const pass = Deno.env.get("GMAIL_APP_PASSWORD");
      if (!mu || !pass) return json({ error: "Sign-in email isn't set up yet." }, 503);
      const nodemailer = (await import("npm:nodemailer@6")).default;
      const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: mu.u, pass: pass.replace(/\s+/g, "") } });
      await t.sendMail({ from: `"Destiny OS" <${mu.u}>`, to: email, subject: `Destiny OS code: ${code}`, text: `Your Destiny OS sign-in code is ${code}\n\nIt works for 15 minutes. If you didn't ask for it, ignore this email.` });
    }
    return json({ ok: true }); // same answer either way
  }
  // verify_code
  if (!allowed) return json({ error: "That code didn't work." }, 401);
  const rows = await sql`select * from os.login_codes where email = ${email} and not used and expires_at > now() order by id desc limit 5`;
  if (!rows.length) return json({ error: "That code expired. Ask for a new one." }, 401);
  if (rows.reduce((a: number, r: any) => a + r.attempts, 0) >= 10) return json({ error: "Too many wrong tries. Ask for a new code in 15 minutes." }, 429);
  const h = await sha256(String(body.code ?? "").replace(/\D/g, ""));
  const hit = rows.find((r: any) => r.code_hash === h);
  if (!hit) { await sql`update os.login_codes set attempts = attempts + 1 where id = ${rows[0].id}`; return json({ error: "That code didn't work." }, 401); }
  await sql`update os.login_codes set used = true where id = ${hit.id}`;
  let uid = known?.id as string | undefined;
  if (!uid) {
    const [u] = await sql`select id from auth.users where lower(email) = ${email}`;
    uid = u?.id;
  }
  if (!uid) {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/admin/users`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! },
      body: JSON.stringify({ email, email_confirm: true }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: `Couldn't create your account: ${j.msg ?? r.status}` }, 500);
    uid = j.id;
  }
  if (email === owner?.e) await sql`insert into os.platform_admins (user_id) values (${uid!}) on conflict do nothing`;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((x) => x.toString(16).padStart(2, "0")).join("");
  await sql`insert into os.sessions (token_hash, user_id, expires_at) values (${await sha256(token)}, ${uid!}, now() + interval '90 days')`;
  await audit(null, "user", email, "sign-in", null);
  return json({ ok: true, token });
}

async function who(req: Request) {
  const session = req.headers.get("x-os-token")?.trim();
  if (session) {
    const [s] = await sql`select s.user_id, u.email from os.sessions s join auth.users u on u.id = s.user_id where s.token_hash = ${await sha256(session)} and s.expires_at > now()`;
    if (s) return { id: s.user_id as string, email: s.email as string };
  }
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
  const body = await req.json().catch(() => ({}));
  if (body.action === "request_code" || body.action === "verify_code") return await login(body);
  const user = await who(req);
  if (!user) return json({ error: "Please sign in." }, 401);
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
  const [isAdmin] = await sql`select 1 from os.platform_admins where user_id = ${user.id}`;
  const me = r === "owner" ? "owner" : `user:${user.id}`;

  if (action === "feed") {
    const since = Number(body.since_id ?? 0);
    const msgs = since
      ? await sql`select id, created_at, sender, sender_name, body from os.messages where business_id = ${bid} and id > ${since} order by id limit 200`
      : (await sql`select id, created_at, sender, sender_name, body from os.messages where business_id = ${bid} order by id desc limit 150`).reverse();
    const [b] = await sql`select id, slug, name, status, timezone, shift_start, shift_end, shift_days, monthly_budget_usd, plan, markup_pct, platform_fee_usd, billing_status from os.businesses where id = ${bid}`;
    if (!isAdmin) { delete (b as any).markup_pct; }
    const team = await sql`select a.slot, a.name, a.handle, ba.enabled from os.agents a join os.business_agents ba on ba.slot = a.slot and ba.business_id = ${bid} order by a.sort`;
    const approvals = await sql`select * from os.approvals where business_id = ${bid} order by id desc limit 60`;
    const content = await sql`select * from os.content where business_id = ${bid} order by id desc limit 60`;
    const records = await sql`select id, type, status, title, data, next_step, next_step_due, updated_at from os.records where business_id = ${bid} order by updated_at desc limit 200`;
    const tasks = await sql`select t.*, a.name as assignee from os.tasks t left join os.agents a on a.slot = t.assignee_slot where t.business_id = ${bid} and t.status in ('open','in_progress','blocked') order by t.id desc limit 60`;
    const [usage] = await sql`select coalesce(sum(billed_usd),0) as usd, count(*)::int as calls, coalesce(sum(input_tokens+output_tokens),0)::bigint as tokens from os.usage_events where business_id = ${bid} and at >= date_trunc('month', now())`;
    const working = await sql`select slot from os.agent_runs where business_id = ${bid} and status = 'running' and started_at > now() - interval '4 minutes'`;
    const bySlot = await sql`select slot, count(*)::int as calls, coalesce(sum(input_tokens+output_tokens),0)::bigint as tokens, coalesce(sum(billed_usd),0) as usd
      ${isAdmin ? sql`, coalesce(sum(cost_usd),0) as our_cost` : sql``}
      from os.usage_events where business_id = ${bid} and at >= date_trunc('month', now()) group by slot`;
    const activity = await sql`select at, actor_type, actor, action, target from os.activity_log where business_id = ${bid} order by id desc limit 40`;
    // This month's bill. Our own cost and margin are only shown to the platform owner.
    const bill = (await sql`select * from os.month_bill(${bid})`).map((l: any) => ({ line: l.line, kind: l.kind, amount_usd: Number(l.amount_usd), ...(isAdmin ? { our_cost_usd: l.our_cost_usd == null ? null : Number(l.our_cost_usd) } : {}) }));
    const charges = await sql`select id, kind, description, amount_usd, recurring, starts_on, ends_on from os.charges where business_id = ${bid} and (ends_on is null or ends_on >= current_date) order by id desc`;
    const invoices = await sql`select month, amount_usd, status, hosted_url from os.invoices where business_id = ${bid} and status <> 'draft' order by month desc limit 12`;
    return json({ admin: !!isAdmin, bill, charges, invoices, role: r, business: b, team, messages: msgs, approvals, content, records, tasks, usage, usage_by_agent: bySlot, activity, working: working.map((w: any) => w.slot) });
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
    if (!body.paused && !isAdmin) {
      const [bs] = await sql`select billing_status from os.businesses where id = ${bid}`;
      if (bs?.billing_status === "past_due") return json({ error: "A payment is overdue. Update the card on the Costs tab and the team resumes once it's paid." }, 402);
    }
    await sql`update os.businesses set status = ${body.paused ? "paused" : "live"} where id = ${bid}`;
    await post(bid, "system", body.paused ? "The team is paused." : "The team is back to work.", { status: "handled" });
    await audit(bid, "user", user.email, body.paused ? "pause" : "resume", bid);
    return json({ ok: true });
  }

  // ---- People: owners and admins add or remove people in their own business ----
  if (action === "members") {
    if (!need("admin")) return json({ error: "Only admins can see the people list." }, 403);
    const rows = await sql`select u.id, u.email, m.role, m.created_at from os.business_members m join auth.users u on u.id = m.user_id where m.business_id = ${bid} order by m.created_at`;
    return json({ members: rows });
  }
  if (action === "invite") {
    if (!need("admin")) return json({ error: "Only admins can add people." }, 403);
    const email = String(body.email ?? "").trim().toLowerCase();
    const newRole = String(body.role ?? "viewer");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That email doesn't look right." }, 400);
    if (!RANK[newRole]) return json({ error: "Pick a role." }, 400);
    if (RANK[newRole] > RANK[r]) return json({ error: "You can't give someone a higher role than your own." }, 403);
    let [u] = await sql`select id from auth.users where lower(email) = ${email}`;
    if (!u) {
      const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/admin/users`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! },
        body: JSON.stringify({ email, email_confirm: true }),
      });
      const j = await res.json();
      if (!res.ok) return json({ error: `Couldn't add them: ${j.msg ?? res.status}` }, 500);
      u = { id: j.id };
    }
    await sql`insert into os.business_members (business_id, user_id, role) values (${bid}, ${u.id}, ${newRole})
      on conflict (business_id, user_id) do update set role = excluded.role`;
    await audit(bid, "user", user.email, "invite", email, { role: newRole });
    // Let them know where to sign in.
    try {
      const [mu] = await sql`select decrypted_secret as u from vault.decrypted_secrets where name = 'OS_MAIL_USER'`;
      const [biz] = await sql`select name from os.businesses where id = ${bid}`;
      const [app] = await sql`select decrypted_secret as u from vault.decrypted_secrets where name = 'OS_APP_URL'`;
      const pass = Deno.env.get("GMAIL_APP_PASSWORD");
      if (mu && pass) {
        const nodemailer = (await import("npm:nodemailer@6")).default;
        const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: mu.u, pass: pass.replace(/\s+/g, "") } });
        await t.sendMail({ from: `"Destiny OS" <${mu.u}>`, to: email, subject: `You've been added to ${biz.name} on Destiny OS`,
          text: `You now have ${newRole} access to ${biz.name}'s team on Destiny OS.\n\nSign in with this email address at ${app?.u ?? "the Destiny OS dashboard"}. We'll email you a 6-digit code each time; no password needed.` });
      }
    } catch { /* the membership stands even if the email fails */ }
    return json({ ok: true });
  }
  if (action === "remove_member") {
    if (!need("admin")) return json({ error: "Only admins can remove people." }, 403);
    if (body.user_id === user.id) return json({ error: "You can't remove yourself." }, 400);
    const [m] = await sql`select role from os.business_members where business_id = ${bid} and user_id = ${body.user_id}`;
    if (!m) return json({ error: "Not found." }, 404);
    if (RANK[m.role] > RANK[r]) return json({ error: "You can't remove someone above your role." }, 403);
    await sql`delete from os.business_members where business_id = ${bid} and user_id = ${body.user_id}`;
    await sql`delete from os.sessions where user_id = ${body.user_id} and not exists (select 1 from os.business_members where user_id = ${body.user_id})`;
    await audit(bid, "user", user.email, "remove_member", String(body.user_id));
    return json({ ok: true });
  }

  // ---- Billing: owners and admins save a card through a Stripe-hosted page (card details never touch our servers) ----
  if (action === "billing_link") {
    if (!need("admin")) return json({ error: "Only admins can manage billing." }, 403);
    try {
      const [app] = await sql`select decrypted_secret as u from vault.decrypted_secrets where name = 'OS_APP_URL'`;
      const cfg = (await sql`select config from os.business_config where business_id = ${bid} and active`)[0]?.config ?? {};
      const customer = await ensureCustomer(bid, isAdmin && cfg.owner?.email ? cfg.owner.email : user.email);
      const s = await stripe("POST", "checkout/sessions", {
        mode: "setup", currency: "usd", customer, client_reference_id: bid, metadata: { business_id: bid },
        managed_payments: { enabled: false }, // saving a card for our own invoices; Managed Payments only covers one-off/subscription checkouts
        success_url: `${app?.u ?? ""}?billing=saved`, cancel_url: `${app?.u ?? ""}?billing=cancelled`,
      });
      await audit(bid, "user", user.email, "billing_link", customer);
      return json({ url: s.url });
    } catch (e) { return json({ error: (e as Error).message }, 502); }
  }

  // ---- Pricing (platform owner only): markup on AI usage, platform fee, budget, other charges ----
  if (action === "set_pricing") {
    if (!isAdmin) return json({ error: "Only the platform owner can change pricing." }, 403);
    const n = (v: unknown) => (v === "" || v == null ? null : Number(v));
    const markup = n(body.markup_pct), fee = n(body.platform_fee_usd), budget = n(body.monthly_budget_usd);
    if ([markup, fee, budget].some((v) => v != null && (!isFinite(v) || v < 0))) return json({ error: "Use numbers of 0 or more." }, 400);
    await sql`update os.businesses set markup_pct = coalesce(${markup}, markup_pct), platform_fee_usd = coalesce(${fee}, platform_fee_usd),
      monthly_budget_usd = ${budget} where id = ${bid}`;
    await audit(bid, "user", user.email, "set_pricing", bid, { markup_pct: markup, platform_fee_usd: fee, monthly_budget_usd: budget });
    return json({ ok: true });
  }
  if (action === "add_charge") {
    if (!isAdmin) return json({ error: "Only the platform owner can add charges." }, 403);
    const amount = Number(body.amount_usd);
    if (!body.description || !isFinite(amount) || amount < 0) return json({ error: "Add a description and an amount." }, 400);
    const kind = ["integration", "service", "setup", "other"].includes(body.kind) ? body.kind : "other";
    const [c] = await sql`insert into os.charges (business_id, kind, description, amount_usd, recurring, created_by)
      values (${bid}, ${kind}, ${String(body.description).slice(0, 200)}, ${amount}, ${!!body.recurring}, ${user.email}) returning id`;
    await audit(bid, "user", user.email, "add_charge", String(c.id), { kind, amount, recurring: !!body.recurring });
    return json({ ok: true });
  }
  if (action === "end_charge") {
    if (!isAdmin) return json({ error: "Only the platform owner can remove charges." }, 403);
    await sql`update os.charges set ends_on = current_date - 1 where id = ${body.id} and business_id = ${bid} and recurring`;
    await sql`delete from os.charges where id = ${body.id} and business_id = ${bid} and not recurring and starts_on >= date_trunc('month', now())`;
    await audit(bid, "user", user.email, "end_charge", String(body.id));
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
