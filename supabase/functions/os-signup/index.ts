// os-signup: free trials.
//  - signup_request / signup_verify (public): a business starts a 14-day trial on /trial after confirming its email.
//  - trial_status (signed in): days left, for the dashboard banner.
//  - admin_trial (platform owner): put a business on a 14-day trial.
// During a trial the platform fee is waived and DMG covers AI usage up to TRIAL_CAP (the monthly limit); os.trial_sweep()
// moves it to the full plan (card on file) or pauses it (no card) when it ends.
import { audit, post, sql } from "../_core/core.ts";
import { appUrl, platformMail } from "../_core/mail.ts";

const TRIAL_DAYS = 14, TRIAL_CAP = 40, PUBLIC_PER_DAY = 10;
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

/** A new business on a trial, owned by this person. Starts "not started": nothing runs until they click Start team. */
async function createTrialBusiness(d: Record<string, string>, uid: string) {
  let slug = slugify(d.business);
  for (let i = 2; (await sql`select 1 from os.businesses where slug = ${slug}`).length; i++) slug = `${slugify(d.business)}-${i}`;
  const config = {
    mission: `${d.about}${d.website ? `\n\nWebsite: ${d.website}` : ""}`,
    facts: "", rules: "",
    owner: { name: d.name || "the owner", email: d.email },
    record_types: { lead: { stages: ["found", "qualified", "contacted", "replied", "won", "lost"], description: "a potential customer or partner" } },
    approvals: { email: { agent_can_approve_after: 5, daily_limit: 15 }, publish: {} },
    tool_packs: [],
  };
  const bid = await sql.begin(async (tx: any) => {
    const [nb] = await tx`insert into os.businesses (slug, name, status, timezone, platform_fee_usd, markup_pct, monthly_budget_usd, plan, trial_ends_at)
      values (${slug}, ${d.business}, 'setup', 'America/New_York', 650, 30, ${TRIAL_CAP}, 'customer', now() + make_interval(days => ${TRIAL_DAYS})) returning id`;
    await tx`insert into os.business_config (business_id, version, config, note, created_by, active) values (${nb.id}, 1, ${tx.json(config)}, 'free trial sign-up', ${d.email}, true)`;
    await tx`insert into os.business_agents (business_id, slot, enabled, role_instructions) select ${nb.id}, slot, true, '' from os.agents`;
    await tx`insert into os.business_members (business_id, user_id, role) values (${nb.id}, ${uid}, 'owner') on conflict (business_id, user_id) do update set role = 'owner'`;
    return nb.id as string;
  });
  await post(bid, "system", `Welcome to Destiny OS. Your ${TRIAL_DAYS}-day free trial has started. Tell the team about your business in Settings, then click Start team.`, { status: "handled" });
  await audit(bid, "user", d.email, "trial_signup", slug, { phone: d.phone || undefined });
  await sql`select os.alert(${bid}, 'platform', 'trial_signup', ${"New free trial: " + d.business}, ${`${d.name} <${d.email}>${d.phone ? `, ${d.phone}` : ""} started a ${TRIAL_DAYS}-day trial for ${d.business}.\n\nWhat they do: ${d.about}${d.website ? `\nWebsite: ${d.website}` : ""}`}, ${"trial:" + bid})`;
  return bid;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "signup_request") {
    if (body.company_url) return json({ ok: true }); // honeypot: bots fill every field
    const d = { business: clip(body.business, 80), name: clip(body.name, 80), email: clip(body.email, 200).toLowerCase(),
      phone: clip(body.phone, 40), website: clip(body.website, 200), about: clip(body.about, 2000) };
    if (d.business.length < 2) return json({ error: "Add your business name." }, 400);
    if (d.name.length < 2) return json({ error: "Add your name." }, 400);
    if (!EMAIL.test(d.email)) return json({ error: "That email doesn't look right." }, 400);
    if (d.about.length < 20) return json({ error: "Tell us a little more about what your business does (a sentence or two)." }, 400);
    const [owned] = await sql`select 1 from auth.users u join os.business_members m on m.user_id = u.id and m.role = 'owner' where lower(u.email) = ${d.email}`;
    if (owned) return json({ error: "That email already has a Destiny OS account. Sign in instead." }, 409);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    const [lim] = await sql`select
      (select count(*)::int from os.trial_signups where lower(email) = ${d.email} and created_at > now() - interval '1 hour') as by_email,
      (select count(*)::int from os.trial_signups where ip = ${ip} and created_at > now() - interval '1 day') as by_ip,
      (select count(*)::int from os.trial_signups where used and created_at > now() - interval '1 day') as today`;
    if (lim.by_email >= 3 || (ip && lim.by_ip >= 6)) return json({ error: "Too many tries. Please wait an hour and try again." }, 429);
    if (lim.today >= PUBLIC_PER_DAY) return json({ error: "We've started all the trials we can today. Please try again tomorrow." }, 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    await sql`insert into os.trial_signups (email, ip, details, code_hash, expires_at) values (${d.email}, ${ip}, ${sql.json(d)}, ${await sha256(code)}, now() + interval '15 minutes')`;
    try {
      await platformMail(d.email, `Destiny OS code: ${code}`, `Your code to start the Destiny OS free trial for ${d.business} is ${code}\n\nIt works for 15 minutes. If you didn't ask for it, ignore this email.`);
    } catch { return json({ error: "We couldn't send the email. Try again in a minute." }, 503); }
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
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((x) => x.toString(16).padStart(2, "0")).join("");
      await sql`insert into os.sessions (token_hash, user_id, expires_at) values (${await sha256(token)}, ${uid}, now() + interval '90 days')`;
      try {
        await platformMail(email, "Your Destiny OS free trial has started", `Welcome to Destiny OS. Your ${TRIAL_DAYS}-day free trial for ${s.details.business} has started.\n\nSign in any time at ${await appUrl()} with this email; we'll send you a code, no password needed.\n\nFirst steps: tell the team about your business in Settings, then click Start team.\n\nTerms: ${await appUrl()}/terms\nPrivacy: ${await appUrl()}/privacy`);
      } catch { /* the trial stands even if the welcome email fails */ }
      return json({ ok: true, token, business_id: bid });
    } catch (e) {
      await sql`update os.trial_signups set used = false where id = ${s.id}`;
      return json({ error: (e as Error).message }, 500);
    }
  }

  const user = await who(req);
  if (!user) return json({ error: "Please sign in." }, 401);
  const [isAdmin] = await sql`select 1 from os.platform_admins where user_id = ${user.id}`;
  const bid = String(body.business_id ?? "");

  if (action === "trial_status") {
    const [m] = isAdmin ? [{ ok: 1 }] : await sql`select 1 as ok from os.business_members where user_id = ${user.id} and business_id = ${bid}`;
    if (!m) return json({ error: "You don't have access to that business." }, 403);
    const [b] = await sql`select trial_ends_at, trial_converted, billing_status from os.businesses where id = ${bid}`;
    if (!b?.trial_ends_at || b.trial_converted) return json({ trial: null });
    const ms = new Date(b.trial_ends_at).getTime() - Date.now();
    return json({ trial: { ends_at: b.trial_ends_at, days_left: Math.max(0, Math.ceil(ms / 86400000)), ended: ms <= 0, card_on_file: b.billing_status === "active", cap_usd: TRIAL_CAP } });
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
