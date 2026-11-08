// os-signup: self sign-up. There is no free trial: a business signs up on /trial (email code), its team is set up
// from its answers, and it pays its first month (the platform fee, Stripe Checkout, card saved) before the team can start.
//  - signup_request / signup_verify (public): create the business after confirming the email.
//  - trial_status (signed in): what the dashboard banner shows (first payment due; old trials' days left).
//  - pay_start (owner/admin): the Stripe Checkout link for the first month. os-billing's webhook records the payment.
//  - admin_trial (platform owner): still puts a business on a 14-day trial by hand, for special cases.
import { audit, business, claude, post, secret, sql } from "../_core/core.ts";
import { appUrl, platformMail } from "../_core/mail.ts";
import { ensureCustomer, stripe, stripeAccount } from "../_core/stripe.ts";

const TRIAL_DAYS = 14, TRIAL_CAP = 40, PUBLIC_PER_DAY = 10, START_BUDGET = 200;
const FORBIDDEN_ACCOUNTS = ["acct_1UWNu2ISquyuV0hE"]; // JHP / Destiny Marketing Group's own Stripe: never used here
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-os-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const clip = (v: unknown, n: number) => (v == null ? "" : String(v)).trim().slice(0, n);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const slugify = (s: string) => { const x = s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/, ""); return x.length >= 2 ? x : `${x || "biz"}-co`; };

async function who(req: Request) {
  const t = req.headers.get("x-os-token")?.trim();
  if (!t) return null;
  const [s] = await sql`select s.user_id, u.email from os.sessions s join auth.users u on u.id = s.user_id where s.token_hash = ${await sha256(t)} and s.expires_at > now()`;
  return s ? { id: s.user_id as string, email: s.email as string } : null;
}

async function authUser(email: string) {
  const [u] = await sql`select id from auth.users where lower(email) = ${email}`;
  if (u) return u.id as string;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/admin/users`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, apikey: key },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Couldn't create your login: ${j.msg ?? r.status}`);
  return j.id as string;
}

const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

/** What the owner told us at sign-up, as the team's first brief. */
function briefOf(d: Record<string, string>) {
  return [
    `Business: ${d.business}`, d.industry && `Type of business: ${d.industry}`, `What they do: ${d.about}`,
    d.area && `Where they work: ${d.area}`, d.customers && `Best customers: ${d.customers}`,
    d.goal && `What they want more of: ${d.goal}`, d.offer && `Services and prices: ${d.offer}`, d.website && `Website: ${d.website}`,
  ].filter(Boolean).join("\n");
}

/** Writes the business's first setup (mission, facts, rules, record types and each teammate's job) from the sign-up answers. */
async function setupTeam(bid: string) {
  const b = await business(bid);
  if (!b) return;
  const [s] = await sql`select details from os.trial_signups where business_id = ${bid} order by id desc limit 1`;
  const d = s?.details ?? {};
  const agents = await sql`select slot, name, handle, core_role from os.agents where not retired order by sort`;
  const prompt = `You are setting up a new business's AI team on Destiny OS. The team has six coworkers; each has a fixed core job:
${agents.map((a: any) => `- ${a.slot} (${a.name}): ${a.core_role}`).join("\n")}

Their tools: web research, a shared notebook and research notes, records (a pipeline of leads, customers or projects with stages), tasks, emails that go out only after the owner approves them, posts and other content that publish only after approval (Facebook Page posting when connected), and a media library of the owner's photos and videos.
Platform rules that always apply: never invent facts, numbers, prices, reviews or results; nothing is sent or published without approval; never contact private consumers from bought, scraped or collected lists, and never text anyone; only contact businesses and professionals through their published contacts, or people who asked to hear from the business.

The owner signed up with:
${briefOf(d)}

Write this business's setup as JSON, and nothing else:
{
  "mission": "2 to 4 sentences: what the business does and what the team should achieve for it",
  "facts": "short bullet lines using ONLY what the owner said (services, area, customers, prices if given). Then one line listing what the owner should add (e.g. prices, offers, phone number) if it's missing.",
  "rules": "4 to 8 short bullet lines suited to this kind of business: what never to claim or promise, tone, who may and may not be contacted, anything the law or the industry requires (licensing, guarantees, health or financial claims)",
  "record_types": { "<snake_case_type>": { "stages": ["5 to 7 stages in order"], "description": "what one record is" } },
  "agents": { ${agents.map((a: any) => `"${a.slot}": "..."`).join(", ")} }
}
record_types: 1 to 3 types that fit how this business finds and wins work (for example "lead" for customers it wants, "partner" for referral sources).
agents: for each slot, 2 to 4 sentences of concrete instructions for THIS business: exactly what to look for or make, where, how many per run (5 to 8), and who to hand it to by @handle (${agents.map((a: any) => "@" + a.handle).join(", ")}). Keep every instruction within the platform rules.`;
  const res = await claude(b, "coordination", { model: b.model, max_tokens: 3000, messages: [{ role: "user", content: prompt }] }, 90_000);
  const text = (res.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const types: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(j.record_types ?? {}).slice(0, 3) as [string, any][]) {
    const key = k.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 30);
    const stages = (Array.isArray(v?.stages) ? v.stages : []).map((x: unknown) => str(x, 30).toLowerCase()).filter(Boolean).slice(0, 8);
    if (key && stages.length >= 2) types[key] = { stages, description: str(v?.description, 200) };
  }
  const [cur] = await sql`select config from os.business_config where business_id = ${bid} and active`;
  const config = { ...(cur?.config ?? {}),
    mission: str(j.mission, 3000) || cur?.config?.mission, facts: str(j.facts, 12000), rules: str(j.rules, 12000),
    ...(Object.keys(types).length ? { record_types: types } : {}) };
  await sql.begin(async (tx: any) => {
    const [{ v }] = await tx`select coalesce(max(version), 0) + 1 as v from os.business_config where business_id = ${bid}`;
    await tx`update os.business_config set active = false where business_id = ${bid}`;
    await tx`insert into os.business_config (business_id, version, config, note, created_by, active) values (${bid}, ${v}, ${tx.json(config)}, 'set up from the sign-up answers', 'claude', true)`;
    for (const a of agents) {
      const ins = str(j.agents?.[a.slot], 4000);
      if (ins) await tx`update os.business_agents set role_instructions = ${ins} where business_id = ${bid} and slot = ${a.slot}`;
    }
  });
  await post(bid, "system", `Your team is set up for your business from what you told us: each teammate has their job, and the team knows your services, area and rules. Check Settings to add anything (prices, offers, phone number).${(b as any).pay_to_start ? " When you're ready, pay your first month on the Money tab and click Start team." : " Then click Start team."}`, { status: "handled" });
  await audit(bid, "system", "setup", "team_setup", bid, { record_types: Object.keys(types) });
}

/** A new business owned by this person. Starts "not started": nothing runs until the first month is paid and they click Start team. */
async function createTrialBusiness(d: Record<string, string>, uid: string) {
  let slug = slugify(d.business);
  for (let i = 2; (await sql`select 1 from os.businesses where slug = ${slug}`).length; i++) slug = `${slugify(d.business)}-${i}`;
  const tz = d.timezone && validTz(d.timezone) ? d.timezone : "America/New_York";
  const config = {
    mission: briefOf(d),
    facts: "", rules: "",
    owner: { name: d.name || "the owner", email: d.email },
    record_types: { lead: { stages: ["found", "qualified", "contacted", "replied", "won", "lost"], description: "a potential customer or partner" } },
    approvals: { email: { agent_can_approve_after: 5, daily_limit: 15 }, publish: {} },
    tool_packs: [],
  };
  const bid = await sql.begin(async (tx: any) => {
    const [nb] = await tx`insert into os.businesses (slug, name, status, timezone, platform_fee_usd, markup_pct, monthly_budget_usd, plan, pay_to_start, billing_status)
      values (${slug}, ${d.business}, 'setup', ${tz}, 650, 30, ${START_BUDGET}, 'customer', true, 'card_needed') returning id`;
    await tx`insert into os.business_config (business_id, version, config, note, created_by, active) values (${nb.id}, 1, ${tx.json(config)}, 'free trial sign-up', ${d.email}, true)`;
    await tx`insert into os.business_agents (business_id, slot, enabled, role_instructions) select ${nb.id}, slot, true, '' from os.agents`;
    await tx`insert into os.business_members (business_id, user_id, role) values (${nb.id}, ${uid}, 'owner') on conflict (business_id, user_id) do update set role = 'owner'`;
    return nb.id as string;
  });
  await post(bid, "system", "Welcome to Destiny OS. Your team is being set up from what you told us; this takes about a minute.", { status: "handled" });
  await audit(bid, "user", d.email, "trial_signup", slug, { phone: d.phone || undefined });
  const heads = [`${d.name} signed up ${d.business} (first month not paid yet).${d.phone ? ` Give them a call today: ${d.phone}.` : ""}`, "",
    `Name: ${d.name}`, `Email: ${d.email}`, d.phone ? `Phone: ${d.phone}` : null, "", briefOf(d)].filter((x) => x !== null).join("\n");
  await sql`select os.alert(${bid}, 'platform', 'trial_signup', ${"New sign-up: " + d.business + (d.industry ? ` (${d.industry})` : "")}, ${heads}, ${"trial:" + bid})`;
  return bid;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "signup_request") {
    if (body.company_url) return json({ ok: true }); // honeypot: bots fill every field
    const d = { business: clip(body.business, 80), name: clip(body.name, 80), email: clip(body.email, 200).toLowerCase(),
      phone: clip(body.phone, 40), website: clip(body.website, 200), about: clip(body.about, 2000),
      industry: clip(body.industry, 80), area: clip(body.area, 200), customers: clip(body.customers, 600),
      goal: clip(body.goal, 600), offer: clip(body.offer, 2000), timezone: clip(body.timezone, 60) };
    if (d.business.length < 2) return json({ error: "Add your business name." }, 400);
    if (d.name.length < 2) return json({ error: "Add your name." }, 400);
    if (!EMAIL.test(d.email)) return json({ error: "That email doesn't look right." }, 400);
    if (d.industry.length < 2) return json({ error: "Pick or type your type of business." }, 400);
    if (d.about.length < 20) return json({ error: "Tell us a little more about what your business does (a sentence or two)." }, 400);
    if (d.area.length < 2) return json({ error: "Add where you work (city, county or area)." }, 400);
    if (d.customers.length < 5) return json({ error: "Tell us who your best customers are." }, 400);
    if (d.goal.length < 5) return json({ error: "Tell us what you want more of." }, 400);
    const [owned] = await sql`select 1 from auth.users u join os.business_members m on m.user_id = u.id and m.role = 'owner'
      join os.businesses b on b.id = m.business_id and b.status <> 'archived' where lower(u.email) = ${d.email}`;
    if (owned) return json({ error: "That email already has a Destiny OS account. Sign in instead." }, 409);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    const [lim] = await sql`select
      (select count(*)::int from os.trial_signups where lower(email) = ${d.email} and created_at > now() - interval '1 hour') as by_email,
      (select count(*)::int from os.trial_signups where ip = ${ip} and created_at > now() - interval '1 day') as by_ip,
      (select count(*)::int from os.trial_signups where used and created_at > now() - interval '1 day') as today`;
    if (lim.by_email >= 3 || (ip && lim.by_ip >= 6)) return json({ error: "Too many tries. Please wait an hour and try again." }, 429);
    if (lim.today >= PUBLIC_PER_DAY) return json({ error: "We've set up all the new businesses we can today. Please try again tomorrow." }, 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    await sql`insert into os.trial_signups (email, ip, details, code_hash, expires_at) values (${d.email}, ${ip}, ${sql.json(d)}, ${await sha256(code)}, now() + interval '15 minutes')`;
    try {
      await platformMail(d.email, `Destiny OS code: ${code}`, `Your code to set up Destiny OS for ${d.business} is ${code}\n\nIt works for 15 minutes. If you didn't ask for it, ignore this email.`);
    } catch { return json({ error: "We couldn't send the email. Try again in a minute." }, 503); }
    return json({ ok: true });
  }

  if (action === "contact") {
    // "Talk to us" on the front page: emails the platform owner, with Reply going straight to the person.
    if (body.website) return json({ ok: true }); // honeypot
    const c = { name: clip(body.name, 80), business: clip(body.business, 120), email: clip(body.email, 200).toLowerCase(), phone: clip(body.phone, 40), message: clip(body.message, 3000) };
    if (c.name.length < 2) return json({ error: "Add your name." }, 400);
    if (c.business.length < 2) return json({ error: "Add your business name." }, 400);
    if (!EMAIL.test(c.email)) return json({ error: "That email doesn't look right." }, 400);
    if (c.message.length < 5) return json({ error: "Tell us what you'd like to know." }, 400);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    const [lim] = await sql`select
      (select count(*)::int from os.contact_requests where ip = ${ip} and created_at > now() - interval '1 day') as by_ip,
      (select count(*)::int from os.contact_requests where created_at > now() - interval '1 day') as today`;
    if ((ip && lim.by_ip >= 5) || lim.today >= 60) return json({ error: "We've had a lot of messages today. Please email us instead." }, 429);
    const [row] = await sql`insert into os.contact_requests (name, business, email, phone, message, ip) values (${c.name}, ${c.business}, ${c.email}, ${c.phone || null}, ${c.message}, ${ip}) returning id`;
    const subject = `Destiny OS question from ${c.name} (${c.business})`;
    const text = `${c.name} from ${c.business} wants to talk.${c.phone ? ` Phone: ${c.phone}.` : ""}\n\nEmail: ${c.email}\n\n${c.message}\n\nReply to this email to answer them.`;
    const owner = await secret("OS_OWNER_EMAIL");
    try {
      if (!owner) throw new Error("no owner email");
      await platformMail(owner, subject, text, c.email);
    } catch {
      await sql`select os.alert(null, 'platform', 'contact', ${subject}, ${text}, ${"contact:" + row.id})`;
    }
    return json({ ok: true });
  }

  if (action === "signup_verify") {
    const email = clip(body.email, 200).toLowerCase();
    const [s] = await sql`select * from os.trial_signups where lower(email) = ${email} and not used and expires_at > now() order by id desc limit 1`;
    if (!s) return json({ error: "That code expired. Start again." }, 401);
    if (s.attempts >= 5) return json({ error: "Too many wrong tries. Start again." }, 429);
    if (s.code_hash !== await sha256(String(body.code ?? "").replace(/\D/g, ""))) {
      await sql`update os.trial_signups set attempts = attempts + 1 where id = ${s.id}`;
      return json({ error: "That code didn't work." }, 401);
    }
    const [claimed] = await sql`update os.trial_signups set used = true where id = ${s.id} and not used returning id`;
    if (!claimed) return json({ error: "That code was already used. Sign in instead." }, 409);
    try {
      const uid = await authUser(email);
      const bid = await createTrialBusiness({ ...s.details, email }, uid);
      await sql`update os.trial_signups set business_id = ${bid} where id = ${s.id}`;
      // Their team gets its jobs written from the sign-up answers in the background (about a minute).
      // @ts-ignore EdgeRuntime is provided by Supabase
      EdgeRuntime.waitUntil(setupTeam(bid).catch(async (e) => {
        console.error("setupTeam", (e as Error).message);
        await post(bid, "system", "Setting up your team is taking a little longer than usual. It finishes on its own shortly (you'll see a note here), and you don't need to do anything.", { status: "handled" });
        await sql`select os.alert(${bid}, 'platform', 'setup_failed', ${"Trial team setup failed: " + String(s.details.business)}, ${(e as Error).message.slice(0, 500)}, ${"setup:" + bid})`;
      }));
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((x) => x.toString(16).padStart(2, "0")).join("");
      await sql`insert into os.sessions (token_hash, user_id, expires_at) values (${await sha256(token)}, ${uid}, now() + interval '90 days')`;
      try {
        await platformMail(email, "Welcome to Destiny OS", `Welcome to Destiny OS. Your team for ${s.details.business} is being set up now.\n\nSign in any time at ${await appUrl()}/login with this email; we'll send you a code, no password needed.\n\nNext steps: check what your team knows in Settings, pay your first month on the Money tab ($650 for your first 30 days; AI usage is billed on the 1st of each month), then click Start team. Cancel any time.\n\nTerms: ${await appUrl()}/terms\nPrivacy: ${await appUrl()}/privacy`);
      } catch { /* the trial stands even if the welcome email fails */ }
      return json({ ok: true, token, business_id: bid });
    } catch (e) {
      await sql`update os.trial_signups set used = false where id = ${s.id}`;
      return json({ error: (e as Error).message }, 500);
    }
  }

  // A sign-up whose setup failed (usually the AI was down): os.retry_trial_setups() calls this once the AI is back.
  if (action === "retry_setup") {
    const key = await secret("OS_INVOKE_KEY");
    if (!key || req.headers.get("authorization") !== `Bearer ${key}`) return json({ error: "forbidden" }, 403);
    const id = String(body.business_id ?? "");
    const [c] = await sql`select note from os.business_config where business_id = ${id} and active`;
    if (c?.note !== "free trial sign-up") return json({ ok: true, skipped: "already set up" });
    try { await setupTeam(id); return json({ ok: true }); }
    catch (e) { return json({ error: (e as Error).message.slice(0, 300) }, 502); }
  }

  const user = await who(req);
  if (!user) return json({ error: "Please sign in." }, 401);
  const [isAdmin] = await sql`select 1 from os.platform_admins where user_id = ${user.id}`;
  const bid = String(body.business_id ?? "");

  if (action === "trial_status") {
    const [m] = isAdmin ? [{ ok: 1 }] : await sql`select 1 as ok from os.business_members where user_id = ${user.id} and business_id = ${bid}`;
    if (!m) return json({ error: "You don't have access to that business." }, 403);
    const [b] = await sql`select trial_ends_at, trial_converted, billing_status, pay_to_start, fee_paid_until, platform_fee_usd from os.businesses where id = ${bid}`;
    const [{ down }] = await sql`select os.ai_down() as down`;
    const pay = b?.pay_to_start && !b.fee_paid_until ? { amount_usd: Number(b.platform_fee_usd) } : null;
    if (!b?.trial_ends_at || b.trial_converted) return json({ trial: null, pay, ai_down: down });
    const ms = new Date(b.trial_ends_at).getTime() - Date.now();
    return json({ trial: { ends_at: b.trial_ends_at, days_left: Math.max(0, Math.ceil(ms / 86400000)), ended: ms <= 0, card_on_file: b.billing_status === "active", cap_usd: TRIAL_CAP }, ai_down: down });
  }

  // The first month, paid up front through Stripe Checkout (the card is saved for the monthly invoices).
  if (action === "pay_start") {
    const [m] = await sql`select role from os.business_members where user_id = ${user.id} and business_id = ${bid}`;
    if (!isAdmin && !["owner", "admin"].includes(m?.role)) return json({ error: "Only owners and admins can pay." }, 403);
    const [b] = await sql`select id, name, pay_to_start, fee_paid_until, billing_status, platform_fee_usd from os.businesses where id = ${bid}`;
    if (!b) return json({ error: "Not found." }, 404);
    if (!b.pay_to_start || b.fee_paid_until) return json({ error: "Your first month is already paid." }, 400);
    try {
      const acct = await stripeAccount();
      if (FORBIDDEN_ACCOUNTS.includes(acct.id) || /destiny marketing group/i.test(acct.name)) return json({ error: "Payments aren't available right now. Please contact us." }, 503);
      const cfg = (await sql`select config from os.business_config where business_id = ${bid} and active`)[0]?.config ?? {};
      const customer = await ensureCustomer(bid, isAdmin && cfg.owner?.email ? cfg.owner.email : user.email);
      const app = await appUrl();
      const s = await stripe("POST", "checkout/sessions", {
        mode: "payment", customer, client_reference_id: bid, metadata: { business_id: bid, kind: "first_month" },
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(Number(b.platform_fee_usd) * 100),
          product_data: { name: "Destiny OS: your first 30 days", description: "The platform fee for your team's first 30 days. AI usage is billed with your monthly invoice on the 1st." } } }],
        payment_intent_data: { setup_future_usage: "off_session", metadata: { business_id: bid, kind: "first_month" } },
        managed_payments: { enabled: false },
        success_url: `${app}/app?billing=paid`, cancel_url: `${app}/app?billing=cancelled`,
      });
      await audit(bid, "user", user.email, "pay_start_link", customer);
      return json({ url: s.url });
    } catch (e) { return json({ error: `Couldn't open the payment page: ${(e as Error).message}` }, 502); }
  }

  if (action === "admin_trial") {
    if (!isAdmin) return json({ error: "Only the platform owner can start trials." }, 403);
    const [b] = await sql`update os.businesses set trial_ends_at = now() + make_interval(days => ${TRIAL_DAYS}), trial_converted = false, monthly_budget_usd = ${TRIAL_CAP}
      where id = ${bid} and status <> 'archived' returning name, trial_ends_at`;
    if (!b) return json({ error: "Not found." }, 404);
    await post(bid, "system", `A ${TRIAL_DAYS}-day free trial has started: no platform fee, and AI usage is covered up to $${TRIAL_CAP}. Add a card on the Money tab any time to keep the team after the trial.`, { status: "handled" });
    await audit(bid, "user", user.email, "admin_trial", bid, { days: TRIAL_DAYS, cap: TRIAL_CAP });
    return json({ ok: true, ends_at: b.trial_ends_at });
  }

  return json({ error: "Unknown action." }, 400);
});
