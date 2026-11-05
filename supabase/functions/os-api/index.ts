// os-api: the dashboard's backend for every business. People sign in with Supabase Auth (email code);
// every action checks the person's role in that business before reading or writing anything.
import { audit, post, sql } from "../_core/core.ts";
import { execute } from "../_core/tools.ts";
import { ensureCustomer, stripe } from "../_core/stripe.ts";
import { appUrl, platformMail } from "../_core/mail.ts";
import { sendEmail } from "../_core/integrations.ts";

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
      try {
        await platformMail(email, `Destiny OS code: ${code}`, `Your Destiny OS sign-in code is ${code}\n\nIt works for 15 minutes. If you didn't ask for it, ignore this email.`);
      } catch { return json({ error: "Sign-in email isn't set up yet." }, 503); }
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

/** Add someone to a business (creating their login if needed) and email them where to sign in. */
async function addMember(bid: string, rawEmail: string, newRole: string, inviterRole: string, inviterEmail: string): Promise<{ error?: string; status?: number }> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "That email doesn't look right." };
  if (!RANK[newRole]) return { error: "Pick a role." };
  if (RANK[newRole] > RANK[inviterRole]) return { error: "You can't give someone a higher role than your own.", status: 403 };
  let [u] = await sql`select id from auth.users where lower(email) = ${email}`;
  if (!u) {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/admin/users`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! },
      body: JSON.stringify({ email, email_confirm: true }),
    });
    const j = await res.json();
    if (!res.ok) return { error: `Couldn't add them: ${j.msg ?? res.status}`, status: 500 };
    u = { id: j.id };
  }
  await sql`insert into os.business_members (business_id, user_id, role) values (${bid}, ${u.id}, ${newRole})
    on conflict (business_id, user_id) do update set role = excluded.role`;
  await audit(bid, "user", inviterEmail, "invite", email, { role: newRole });
  try {
    const [biz] = await sql`select name from os.businesses where id = ${bid}`;
    await platformMail(email, `You've been added to ${biz.name} on Destiny OS`,
      `You now have ${newRole} access to ${biz.name}'s AI team on Destiny OS.\n\nSign in with this email address at ${await appUrl()}. We'll email you a 6-digit code each time; no password needed.\n\nTerms: ${await appUrl()}/terms\nPrivacy: ${await appUrl()}/privacy`);
  } catch { /* the membership stands even if the email fails */ }
  return {};
}

// Integrations a business can connect itself. Secrets go to the vault as "<slug>:<NAME>" and are never sent back.
const PROVIDERS: Record<string, { label: string; settings: string[]; secrets: string[] }> = {
  gmail: { label: "Gmail", settings: ["user", "from_name", "check_inbox"], secrets: ["GMAIL_APP_PASSWORD"] },
  resend: { label: "Resend (email from your own domain)", settings: ["from", "reply_to"], secrets: ["RESEND_API_KEY"] },
  facebook: { label: "Facebook Page", settings: ["page_id"], secrets: ["FACEBOOK_PAGE_TOKEN"] },
};

async function putSecret(name: string, value: string, note: string) {
  const [have] = await sql`select id from vault.secrets where name = ${name}`;
  if (have) await sql`select vault.update_secret(${have.id}, ${value})`;
  else await sql`select vault.create_secret(${value}, ${name}, ${note})`;
}

/** Checks a connection works: sends a test email, or reads the Facebook Page's name. */
async function testIntegration(b: any, provider: string, to: string): Promise<{ ok: boolean; detail: string; settings?: Record<string, unknown> }> {
  try {
    if (provider === "facebook") {
      const [i] = await sql`select settings from os.integrations where business_id = ${b.id} and provider = 'facebook'`;
      const [t] = await sql`select decrypted_secret as v from vault.decrypted_secrets where name = ${b.slug + ":FACEBOOK_PAGE_TOKEN"}`;
      if (!i?.settings?.page_id || !t) return { ok: false, detail: "Page ID or token missing." };
      const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(i.settings.page_id)}?fields=name&access_token=${encodeURIComponent(t.v)}`, { signal: AbortSignal.timeout(15_000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, detail: `Facebook said: ${j.error?.message ?? r.status}` };
      return { ok: true, detail: `Connected to the Page "${j.name}".`, settings: { page_name: j.name } };
    }
    // Email: send through exactly this provider by marking it connected for the test.
    const saved = await sql`select provider, status from os.integrations where business_id = ${b.id} and provider in ('gmail','resend')`;
    await sql`update os.integrations set status = case when provider = ${provider} then 'connected' else 'not_connected' end where business_id = ${b.id} and provider in ('gmail','resend')`;
    try {
      await sendEmail(b, { to, subject: "Destiny OS: test email", text: `This is a test from your Destiny OS team's ${PROVIDERS[provider].label} connection. If you can read this, it works.` });
    } finally {
      for (const s of saved) await sql`update os.integrations set status = ${s.status} where business_id = ${b.id} and provider = ${s.provider}`;
    }
    return { ok: true, detail: `Test email sent to ${to}.` };
  } catch (e) { return { ok: false, detail: (e as Error).message }; }
}

const slugify = (s: string) => { const x = s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/, ""); return x.length >= 2 ? x : `${x || "biz"}-co`; };
const clip = (v: unknown, n: number) => (v == null ? "" : String(v)).slice(0, n);
function validTz(tz: string) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }

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
    const results = await sql`select * from os.agent_results(${bid})`;
    const [cache] = await sql`select coalesce(sum(cache_read_tokens),0)::bigint as read, coalesce(sum(input_tokens),0)::bigint as input from os.usage_events where business_id = ${bid} and at >= date_trunc('month', now())`;
    return json({ admin: !!isAdmin, bill, charges, invoices, results, cache, role: r, business: b, team, messages: msgs, approvals, content, records, tasks, usage, usage_by_agent: bySlot, activity, working: working.map((w: any) => w.slot) });
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
    const res = await addMember(bid, String(body.email ?? ""), String(body.role ?? "viewer"), r, user.email);
    return res.error ? json({ error: res.error }, res.status ?? 400) : json({ ok: true });
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

  // ---- New business (platform owner only) ----
  if (action === "create_business") {
    if (!isAdmin) return json({ error: "Only the platform owner can add businesses." }, 403);
    const name = clip(body.name, 80).trim();
    const ownerEmail = clip(body.owner_email, 200).trim().toLowerCase();
    if (!name) return json({ error: "Give the business a name." }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) return json({ error: "Add the owner's email." }, 400);
    const tz = clip(body.timezone || "America/New_York", 60);
    if (!validTz(tz)) return json({ error: "That time zone isn't recognized." }, 400);
    const num = (v: unknown, d: number | null) => (v === "" || v == null ? d : Number(v));
    const fee = num(body.platform_fee_usd, 650), markup = num(body.markup_pct, 30), budget = num(body.monthly_budget_usd, 200);
    if ([fee, markup, budget].some((v) => v != null && (!isFinite(v) || v < 0))) return json({ error: "Prices must be numbers of 0 or more." }, 400);
    let slug = slugify(name);
    for (let i = 2; (await sql`select 1 from os.businesses where slug = ${slug}`).length; i++) slug = `${slugify(name)}-${i}`;
    const config = {
      mission: clip(body.mission, 3000), facts: clip(body.facts, 12000), rules: clip(body.rules, 12000),
      owner: { name: clip(body.owner_name, 120) || "the owner", email: ownerEmail },
      record_types: { lead: { stages: ["found", "qualified", "contacted", "replied", "won", "lost"], description: "a potential customer or partner" } },
      approvals: { email: { agent_can_approve_after: 5, daily_limit: 15 }, publish: {} },
      tool_packs: [],
    };
    const bid2 = await sql.begin(async (tx: any) => {
      const [nb] = await tx`insert into os.businesses (slug, name, status, timezone, platform_fee_usd, markup_pct, monthly_budget_usd, plan)
        values (${slug}, ${name}, 'setup', ${tz}, ${fee}, ${markup}, ${budget}, 'customer') returning id`;
      await tx`insert into os.business_config (business_id, version, config, note, created_by, active) values (${nb.id}, 1, ${tx.json(config)}, 'created from the dashboard', ${user.email}, true)`;
      await tx`insert into os.business_agents (business_id, slot, enabled, role_instructions) select ${nb.id}, slot, true, '' from os.agents`;
      return nb.id as string;
    });
    await audit(bid2, "user", user.email, "create_business", slug, { owner: ownerEmail, fee, markup, budget });
    await post(bid2, "system", `${name} is set up. The team starts working when the owner clicks Start team.`, { status: "handled" });
    const inv = await addMember(bid2, ownerEmail, "owner", "owner", user.email);
    return json({ ok: true, business_id: bid2, slug, invite: inv.error ?? "sent" });
  }

  // ---- Settings: what the team knows and how it works ----
  if (action === "settings_get") {
    const [b] = await sql`select name, slug, status, timezone, shift_start, shift_end, shift_days from os.businesses where id = ${bid}`;
    const [c] = await sql`select config, version from os.business_config where business_id = ${bid} and active`;
    const agents = await sql`select a.slot, a.name, a.handle, split_part(a.core_role, ':', 1) as role, ba.enabled, ba.role_instructions
      from os.agents a join os.business_agents ba on ba.slot = a.slot and ba.business_id = ${bid} order by a.sort`;
    const versions = await sql`select version, created_at, created_by, note, active from os.business_config where business_id = ${bid} order by version desc limit 15`;
    return json({ business: b, config: c?.config ?? {}, version: c?.version ?? 0, agents, versions, can_edit: need("admin"), advanced: !!isAdmin });
  }
  if (action === "settings_save") {
    if (!need("admin")) return json({ error: "Only admins can change settings." }, 403);
    const tz = clip(body.timezone, 60);
    if (tz && !validTz(tz)) return json({ error: "That time zone isn't recognized." }, 400);
    const start = Number(body.shift_start), end = Number(body.shift_end);
    if (!(start >= 0 && end <= 24 && start < end)) return json({ error: "Work hours must start before they end (0 to 24)." }, 400);
    const days = (Array.isArray(body.shift_days) ? body.shift_days : []).map(Number).filter((d: number) => d >= 1 && d <= 7);
    if (!days.length) return json({ error: "Pick at least one work day." }, 400);
    const [cur] = await sql`select config from os.business_config where business_id = ${bid} and active`;
    let config: Record<string, any> = { ...(cur?.config ?? {}) };
    if (isAdmin && body.raw_config) {
      try { config = JSON.parse(body.raw_config); } catch { return json({ error: "Advanced settings must be valid JSON." }, 400); }
    }
    config.mission = clip(body.mission, 3000); config.facts = clip(body.facts, 12000); config.rules = clip(body.rules, 12000);
    config.owner = { ...(config.owner ?? {}), name: clip(body.owner_name, 120) || config.owner?.name, email: clip(body.owner_email, 200).trim().toLowerCase() || config.owner?.email };
    const agents = Array.isArray(body.agents) ? body.agents : [];
    await sql.begin(async (tx: any) => {
      const [{ v }] = await tx`select coalesce(max(version), 0) + 1 as v from os.business_config where business_id = ${bid}`;
      await tx`update os.business_config set active = false where business_id = ${bid}`;
      await tx`insert into os.business_config (business_id, version, config, note, created_by, active) values (${bid}, ${v}, ${tx.json(config)}, ${clip(body.note, 200) || "edited in Settings"}, ${user.email}, true)`;
      await tx`update os.businesses set name = coalesce(nullif(${clip(body.name, 80).trim()}, ''), name), timezone = coalesce(nullif(${tz}, ''), timezone),
        shift_start = ${start}, shift_end = ${end}, shift_days = ${days} where id = ${bid}`;
      for (const a of agents) {
        await tx`update os.business_agents set enabled = ${!!a.enabled}, role_instructions = ${clip(a.role_instructions, 20000)} where business_id = ${bid} and slot = ${String(a.slot)}`;
      }
    });
    await audit(bid, "user", user.email, "settings_save", bid, { agents: agents.length });
    await post(bid, "system", "The owner updated the team's settings. Everyone: the new mission, facts and rules apply from now on.", { status: "handled" });
    return json({ ok: true });
  }
  if (action === "settings_restore") {
    if (!need("admin")) return json({ error: "Only admins can change settings." }, 403);
    const [old] = await sql`select config from os.business_config where business_id = ${bid} and version = ${Number(body.version)}`;
    if (!old) return json({ error: "That version doesn't exist." }, 404);
    await sql.begin(async (tx: any) => {
      const [{ v }] = await tx`select coalesce(max(version), 0) + 1 as v from os.business_config where business_id = ${bid}`;
      await tx`update os.business_config set active = false where business_id = ${bid}`;
      await tx`insert into os.business_config (business_id, version, config, note, created_by, active) values (${bid}, ${v}, ${tx.json(old.config)}, ${"restored version " + Number(body.version)}, ${user.email}, true)`;
    });
    await audit(bid, "user", user.email, "settings_restore", String(body.version));
    return json({ ok: true });
  }

  // ---- Connections: email and Facebook ----
  if (action === "integrations") {
    const rows = await sql`select provider, status, settings, secret_names, updated_at from os.integrations where business_id = ${bid}`;
    const have = new Map(rows.map((r: any) => [r.provider, r]));
    const list = Object.entries(PROVIDERS).map(([p, d]) => {
      const r: any = have.get(p);
      return { provider: p, label: d.label, fields: d.settings, secrets: d.secrets, status: r?.status ?? "not_connected", settings: r?.settings ?? {}, updated_at: r?.updated_at ?? null };
    });
    const other = rows.filter((r: any) => !PROVIDERS[r.provider]).map((r: any) => ({ provider: r.provider, label: r.provider.toUpperCase() + " (set up by Destiny OS)", status: r.status, readonly: true }));
    return json({ integrations: [...list, ...other], can_edit: need("admin") });
  }
  if (action === "connect") {
    if (!need("admin")) return json({ error: "Only admins can connect accounts." }, 403);
    const p = PROVIDERS[String(body.provider)];
    if (!p) return json({ error: "Unknown connection." }, 400);
    const [b] = await sql`select * from os.businesses where id = ${bid}`;
    const settings: Record<string, string> = {};
    for (const f of p.settings) settings[f] = clip(body.settings?.[f], 300).trim();
    if (body.provider === "gmail" && !/^[^@\s]+@[^@\s]+$/.test(settings.user)) return json({ error: "Enter the Gmail address." }, 400);
    if (body.provider === "gmail") settings.check_inbox = settings.check_inbox === "true" ? "true" : "false";
    if (body.provider === "resend" && !/@/.test(settings.from)) return json({ error: "Enter the From address, like Your Company <hello@yourdomain.com>." }, 400);
    if (body.provider === "facebook" && !/^\d{5,}$/.test(settings.page_id)) return json({ error: "Enter the Page ID (numbers only)." }, 400);
    const [existing] = await sql`select settings from os.integrations where business_id = ${bid} and provider = ${String(body.provider)}`;
    if (settings.check_inbox === "true" && existing?.settings?.check_inbox !== "true") (settings as any).mail_since = new Date().toISOString();
    for (const sname of p.secrets) {
      const v = clip(body.secrets?.[sname], 2000).trim();
      if (v) await putSecret(`${b.slug}:${sname}`, v, `Destiny OS ${body.provider} for ${b.name}`);
      else if (!existing) return json({ error: "Paste the key or password." }, 400);
    }
    await sql`insert into os.integrations (business_id, provider, status, secret_names, settings, updated_at)
      values (${bid}, ${String(body.provider)}, 'testing', ${p.secrets}, ${sql.json(settings)}, now())
      on conflict (business_id, provider) do update set settings = os.integrations.settings || excluded.settings, secret_names = excluded.secret_names, status = 'testing', updated_at = now()`;
    const t = await testIntegration(b, String(body.provider), user.email);
    await sql`update os.integrations set status = ${t.ok ? "connected" : "error"}, settings = settings || ${sql.json(t.settings ?? {})}, updated_at = now() where business_id = ${bid} and provider = ${String(body.provider)}`;
    await audit(bid, "user", user.email, `connect:${body.provider}`, null, { ok: t.ok });
    return json({ ok: t.ok, detail: t.detail });
  }
  if (action === "disconnect") {
    if (!need("admin")) return json({ error: "Only admins can disconnect accounts." }, 403);
    const p = PROVIDERS[String(body.provider)];
    if (!p) return json({ error: "Unknown connection." }, 400);
    const [b] = await sql`select slug from os.businesses where id = ${bid}`;
    await sql`update os.integrations set status = 'not_connected', updated_at = now() where business_id = ${bid} and provider = ${String(body.provider)}`;
    for (const sname of p.secrets) await sql`delete from vault.secrets where name = ${b.slug + ":" + sname}`;
    await audit(bid, "user", user.email, `disconnect:${body.provider}`, null);
    return json({ ok: true });
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

  if (action === "content_done") {
    if (!need("operator")) return json({ error: "Viewers can't change content." }, 403);
    const [c] = await sql`update os.content set status = 'published', published_at = now(), note = coalesce(note, '') || ' (posted by hand)'
      where id = ${body.id} and business_id = ${bid} and status in ('needs_manual','failed','approved','scheduled') returning id`;
    if (!c) return json({ error: "Not found." }, 404);
    await audit(bid, "user", user.email, "content:done", String(c.id));
    return json({ ok: true });
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
