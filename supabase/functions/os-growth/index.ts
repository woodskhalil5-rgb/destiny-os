// os-growth: the Customers screen. Quotes the owner logs (followed up at 2, 5 and 10 days), wins, past customers,
// seasonal emails to them, review-request settings, and the public unsubscribe link.
// Signed-in calls use the dashboard's session token (x-os-token); 'unsub' is public and checks a signed link.
import { audit, business, claude, post, secret, sql } from "../_core/core.ts";
import { unsubToken } from "../_core/unsub.ts";
import { pushTo, vapidPublic } from "../_core/push.ts";
import { stripe, stripeAccount } from "../_core/stripe.ts";
import { platformMail } from "../_core/mail.ts";

// Never touch these Stripe accounts from here (same list as os-billing).
const FORBIDDEN_ACCOUNTS = ["acct_1UWNu2ISquyuV0hE"];

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-os-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });
const clip = (v: unknown, n: number) => (v == null ? "" : String(v)).trim().slice(0, n);
const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

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

async function recipients(bid: string) {
  const [r] = await sql`select count(distinct lower(r.data->>'email'))::int as n from os.records r
    where r.business_id = ${bid} and r.type = 'customer' and coalesce(r.data->>'email', '') <> ''
      and not exists (select 1 from os.optouts o where o.business_id = r.business_id and o.email = lower(r.data->>'email'))`;
  return r.n as number;
}

// The monthly "how to make Destiny OS better" report: last month's numbers in, plain recommendations out.
// Nothing changes on its own: build changes go to Claude in a session, pricing and business calls stay the owner's.
async function monthlyReport(current: boolean) {
  const [d] = current ? await sql`select date_trunc('month', now())::date::text as m` : await sql`select (date_trunc('month', now()) - interval '1 month')::date::text as m`;
  const m = d.m as string;
  if (!current) { const [have] = await sql`select 1 from os.platform_reports where month = ${m}`; if (have) return { ok: true, skipped: "already written" }; }
  const [x] = await sql`select os.platform_metrics(${m}::date) as j`;
  const [prev] = await sql`select left(body, 3000) as body from os.platform_reports where month < ${m} order by month desc limit 1`;
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("No Anthropic key.");
  const model = "claude-opus-5-5";
  const system = `You write the monthly improvement report for Destiny OS, for its owner. Destiny OS is a SaaS that gives a small local business (mostly home services) an AI marketing team of six: James (research), Emily (analysis), Kole (writing), DeMarcus (coordination), Grayson (social media), Nora (money: invoices, jobs won, cost per job). It answers inquiries, follows up quotes on day 2, 5 and 10, asks for reviews, emails past customers seasonal offers, posts to Facebook, has a phone dialer with a virtual assistant, a weekly recap email, and phone notifications. Everything that goes out waits for the business owner's OK.
How it earns: a monthly platform fee (standard $650), AI usage billed at cost plus a markup (standard 30%), calls at cost plus a per-minute fee, a monthly fee per phone number, and one-off charges. 14-day free trial. Billed on the 1st. "internal" businesses belong to the owner (they cost money but don't pay).

Write a plain-text email (no markdown symbols like # or **), short and direct, in this order:
1. The month in numbers: 5 to 8 lines (revenue, our cost, margin, paying businesses, trials started and converted, AI cost and which teammate costs most, anything unusual).
2. What's working (2 to 4 lines).
3. What isn't (2 to 4 lines).
4. Recommended changes: up to 6, ranked by impact. For each: the change; why (the number behind it); the expected effect; and who does it, either "Tell Claude: <one-line instruction>" for changes to the product, its prompts, models or workflow, or "Your call" for prices, offers and business decisions.
5. Watch next month: 2 or 3 things.
Rules: reason only from the numbers given. If there's too little data to judge something, say so and say what to measure instead. Don't present outside benchmarks as fact. Never recommend anything that drops the owner-approval step, mixes businesses' data, calls or texts people without consent, or emails without an unsubscribe link. If last month's report is included, say briefly which of its recommendations the numbers show were acted on.`;
  const user = `Numbers for ${String(m).slice(0, 7)}${current ? " (month so far)" : ""}:\n${JSON.stringify(x.j)}${prev ? `\n\nLast month's report:\n${prev.body}` : ""}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(110_000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 3000, system, messages: [{ role: "user", content: user }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const body = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  const [p] = await sql`select * from os.model_prices where model = ${model}`;
  const cost = p ? ((j.usage?.input_tokens ?? 0) * Number(p.input_per_mtok) + (j.usage?.output_tokens ?? 0) * Number(p.output_per_mtok)) / 1e6 : null;
  await sql`insert into os.platform_reports (month, body, metrics, cost_usd) values (${m}, ${body}, ${sql.json(x.j)}, ${cost})
    on conflict (month) do update set body = excluded.body, metrics = excluded.metrics, cost_usd = excluded.cost_usd, created_at = now()`;
  const to = await secret("OS_OWNER_EMAIL");
  const label = new Date(String(m).slice(0, 10) + "T12:00:00Z").toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  if (to) await platformMail(to, `Destiny OS: how to improve, ${label}${current ? " (so far)" : ""}`, body + `\n\nAll reports are under All businesses in your dashboard.\n\n— Destiny OS`);
  return { ok: true, month: m, cost_usd: cost };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "unsub") {
    const bid = clip(body.b, 40), email = clip(body.e, 200).toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(bid) || !EMAIL.test(email) || clip(body.t, 64) !== await unsubToken(bid, email)) return json({ error: "This unsubscribe link isn't valid." }, 400);
    const [b] = await sql`select name from os.businesses where id = ${bid}`;
    if (!b) return json({ error: "This unsubscribe link isn't valid." }, 400);
    await sql`insert into os.optouts (business_id, email) values (${bid}, ${email}) on conflict do nothing`;
    await audit(bid, "user", email, "unsubscribe", null, {});
    return json({ ok: true, business: b.name });
  }

  // Public inquiry form (/ask/<slug>): a customer asks for help; the owner hears right away and the team drafts a reply.
  if (action === "form_info" || action === "inquiry") {
    const slug = clip(body.slug, 60).toLowerCase();
    const [b] = await sql`select b.id, b.name, b.status, c.config->'owner'->>'email' as owner from os.businesses b
      left join os.business_config c on c.business_id = b.id and c.active where b.slug = ${slug} and b.status <> 'archived'`;
    if (!b) return json({ error: "This form isn't available." }, 404);
    if (action === "form_info") return json({ business: b.name });
    if (body.website) return json({ ok: true }); // honeypot
    const d = { name: clip(body.name, 100), email: clip(body.email, 200).toLowerCase(), phone: clip(body.phone, 40), message: clip(body.message, 3000),
      consent_calls: body.consent_calls === true, consent_text: body.consent_calls === true ? "Agreed on the inquiry form that the business may call or text about this request, including with an automated assistant." : undefined };
    if (d.name.length < 2) return json({ error: "Add your name." }, 400);
    if (!d.email && d.phone.replace(/\D/g, "").length < 7) return json({ error: "Add an email or a phone number so they can get back to you." }, 400);
    if (d.email && !EMAIL.test(d.email)) return json({ error: "That email doesn't look right." }, 400);
    if (d.message.length < 5) return json({ error: "Tell them what you need." }, 400);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const [lim] = await sql`select
      (select count(*)::int from os.records where business_id = ${b.id} and type = 'inquiry' and data->>'ip' = ${ip} and created_at > now() - interval '1 hour') as by_ip,
      (select count(*)::int from os.records where business_id = ${b.id} and type = 'inquiry' and created_at > now() - interval '1 day') as today`;
    if (lim.by_ip >= 5 || lim.today >= 200) return json({ error: "Too many messages right now. Please try again later." }, 429);
    const [r] = await sql`insert into os.records (business_id, type, status, title, data, created_by, next_step, next_step_due)
      values (${b.id}, 'inquiry', 'new', ${d.name}, ${sql.json({ ...d, ip, source: "inquiry form", received_at: new Date().toISOString() })}, 'form',
        'answer today', current_date) returning id`;
    const contact = [d.email, d.phone].filter(Boolean).join(" · ");
    await sql`select os.alert(${b.id}, 'business', 'inquiry', ${"New inquiry: " + d.name}, ${`${d.name} (${contact}) wrote:\n\n${d.message}\n\n${d.email ? "Kole is drafting a reply for your OK. " : ""}${d.phone ? `Fastest: call them now at ${d.phone}. ` : ""}The first business to answer usually wins the job.`}, ${"inq:" + r.id})`;
    await post(b.id, "system", d.email
      ? `@kole New inquiry #${r.id} from ${d.name} (${contact}): "${d.message.slice(0, 1500)}" Draft a short, friendly reply to ${d.email} now and queue it with request_approval (kind email, record_id ${r.id}). Answer only from our facts, and offer the next step (a quick call or an estimate visit). @demarcus make sure it's answered today.`
      : `@demarcus New inquiry #${r.id} from ${d.name}, phone only (${d.phone}): "${d.message.slice(0, 1500)}" Remind the owner to call them back today.`);
    return json({ ok: true, business: b.name });
  }

  // On the 1st (pg_cron, with the invoke key): write last month's improvement report.
  if (action === "monthly_report") {
    const key = await secret("OS_INVOKE_KEY");
    if (!key || req.headers.get("authorization") !== `Bearer ${key}`) return json({ error: "forbidden" }, 403);
    try { return json(await monthlyReport(false)); } catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  const user = await who(req);
  if (!user) return json({ error: "Please sign in." }, 401);

  // The platform owner's view across every business (counts and money only, never their messages or records).
  if (action === "platform_overview" || action === "report_now") {
    const [adm] = await sql`select 1 from os.platform_admins where user_id = ${user.id}`;
    if (!adm) return json({ error: "Only the platform owner sees this." }, 403);
    if (action === "report_now") { try { return json(await monthlyReport(true)); } catch (e) { return json({ error: (e as Error).message }, 502); } }
    const [o] = await sql`select os.platform_overview() as b`;
    const reports = await sql`select id, month, body, created_at from os.platform_reports order by month desc limit 6`;
    return json({ businesses: o.b, reports });
  }
  const bid = String(body.business_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(bid)) return json({ error: "Pick a business." }, 400);
  const [isAdmin] = await sql`select 1 from os.platform_admins where user_id = ${user.id}`;
  const [m] = await sql`select role from os.business_members where user_id = ${user.id} and business_id = ${bid}`;
  const role = isAdmin ? "owner" : m?.role;
  if (!role) return json({ error: "You don't have access to that business." }, 403);
  const canEdit = role !== "viewer";
  if (action !== "summary" && !canEdit) return json({ error: "Viewers can't change this." }, 403);

  // Phone notifications for this person (not tied to one business, but asked from the dashboard).
  if (action === "push_key") return json({ key: await vapidPublic() });
  if (action === "push_subscribe") {
    const sub = body.sub ?? {};
    const endpoint = clip(sub.endpoint, 1000), p256dh = clip(sub.keys?.p256dh, 200), auth = clip(sub.keys?.auth, 100);
    if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return json({ error: "Your browser didn't give a usable notification address." }, 400);
    await sql`insert into os.push_subs (user_id, endpoint, keys, user_agent) values (${user.id}, ${endpoint}, ${sql.json({ p256dh, auth })}, ${clip(req.headers.get("user-agent"), 300)})
      on conflict (endpoint) do update set user_id = excluded.user_id, keys = excluded.keys, fails = 0`;
    const sent = await pushTo([user.id], { title: "Notifications are on", body: "You'll get a note here when something needs you.", url: "/app" });
    return json({ ok: true, sent });
  }
  // Self-serve billing: Stripe's own page for invoices (past and paid), the card on file and the billing email.
  if (action === "billing_portal") {
    if (!isAdmin && !["owner", "admin"].includes(role)) return json({ error: "Only owners and admins can manage billing." }, 403);
    const [b] = await sql`select stripe_customer_id from os.businesses where id = ${bid}`;
    if (!b?.stripe_customer_id) return json({ error: "Add a card first. After that, your invoices and card show up here." }, 400);
    try {
      const acct = await stripeAccount();
      if (FORBIDDEN_ACCOUNTS.includes(acct.id) || /destiny marketing group/i.test(acct.name)) return json({ error: "Billing isn't available right now. Please contact us." }, 503);
      // One portal setup for Destiny OS, created the first time and found again by its tag.
      const list = await stripe("GET", "billing_portal/configurations", { active: true, limit: 100 });
      let cfg = (list.data ?? []).find((c: any) => c.metadata?.destiny_os === "1")?.id;
      if (!cfg) cfg = (await stripe("POST", "billing_portal/configurations", {
        business_profile: { headline: "Destiny OS: your invoices and card on file" },
        features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true }, customer_update: { enabled: true, allowed_updates: ["email", "name", "address"] } },
        metadata: { destiny_os: "1" },
      }, `portal-cfg-${acct.id}-${acct.mode}`)).id;
      const [app] = await sql`select decrypted_secret as u from vault.decrypted_secrets where name = 'OS_APP_URL'`;
      const s = await stripe("POST", "billing_portal/sessions", { customer: b.stripe_customer_id, configuration: cfg, return_url: `${app?.u ?? ""}/app` });
      await audit(bid, "user", user.email, "billing_portal", null, {});
      return json({ url: s.url });
    } catch (e) { return json({ error: `Couldn't open billing: ${(e as Error).message}` }, 502); }
  }
  // The virtual assistant that answers the business line when nobody picks up (owners and admins turn it on or off).
  if (action === "phone_ai_get" || action === "phone_ai_set") {
    const [ph] = await sql`select settings from os.integrations where business_id = ${bid} and provider = 'phone' and status = 'connected'`;
    if (!ph) return json({ has_phone: false, on: false });
    if (action === "phone_ai_set") {
      if (!isAdmin && !["owner", "admin"].includes(role)) return json({ error: "Only owners and admins can change this." }, 403);
      const on = body.on === true;
      await sql`update os.integrations set settings = settings || ${sql.json({ ai_answer: on ? "true" : "false" })}, updated_at = now() where business_id = ${bid} and provider = 'phone'`;
      await audit(bid, "user", user.email, "phone_ai", null, { on });
      return json({ has_phone: true, on });
    }
    return json({ has_phone: true, on: ph.settings?.ai_answer === "true" });
  }
  // WhatsApp call sheet (African businesses): the rep's list of roofers to call, each with its call plan,
  // a one-tap WhatsApp link, and a quick way to log what happened.
  if (action === "wa_sheet" || action === "wa_log") {
    const [b] = await sql`select timezone from os.businesses where id = ${bid}`;
    const cc = ({ "Africa/Lagos": "234", "Africa/Nairobi": "254", "Africa/Accra": "233", "Africa/Johannesburg": "27", "Africa/Kampala": "256", "Africa/Dar_es_Salaam": "255" } as Record<string, string>)[b?.timezone] ?? "";
    if (!String(b?.timezone ?? "").startsWith("Africa/")) return json({ error: "The WhatsApp call sheet is for African businesses." }, 400);
    const wa = (raw: unknown) => {
      let d = String(raw ?? "").replace(/\D/g, "");
      if (!d) return "";
      if (d.startsWith("00")) d = d.slice(2);
      else if (d.startsWith("0") && cc) d = cc + d.slice(1);
      else if (d.length <= 10 && cc && !d.startsWith(cc)) d = cc + d;
      return d.length >= 10 ? d : "";
    };
    if (action === "wa_sheet") {
      const rows = await sql`select id, title, status, data, updated_at from os.records where business_id = ${bid}
        and status in ('call planned', 'called', 'meeting', 'trial') and (data ? 'call_plan' or status <> 'call planned')
        order by case status when 'call planned' then 0 when 'called' then 1 when 'meeting' then 2 else 3 end,
          case upper(coalesce(data->>'priority', '')) when 'A' then 0 when 'B' then 1 else 2 end, (data->>'score') desc nulls last, id limit 80`;
      const done = await sql`select count(*) filter (where started_at > now() - interval '1 day')::int as today, count(*) filter (where started_at > now() - interval '7 days')::int as week
        from os.calls where business_id = ${bid} and status = 'whatsapp'`;
      return json({ rows: rows.map((r: any) => {
        const d = r.data ?? {};
        return { id: r.id, title: r.title, status: r.status, area: d.area ?? null, priority: d.priority ?? null, score: d.score ?? null,
          wa: wa(d.whatsapp) || wa(d.phone), phone: d.phone ?? null, gaps: d.gaps ?? null, call_plan: d.call_plan ?? null,
          follow_up: d.follow_up ?? (typeof d.call_plan === "object" ? d.call_plan?.whatsapp ?? d.call_plan?.follow_up ?? null : null),
          last: Array.isArray(d.calls) ? d.calls[d.calls.length - 1] : null };
      }), done: done[0] });
    }
    const OUT: Record<string, [string, string | null, boolean]> = {
      no_answer: ["No answer", "called", false], callback: ["Call back", "called", true], not_interested: ["Not interested", "lost", false],
      meeting: ["Meeting booked", "meeting", true], trial: ["Started a free trial", "trial", true], signed: ["Signed up", "signed", true], wrong_number: ["Wrong number", "lost", false],
    };
    const o = OUT[String(body.outcome)];
    if (!o) return json({ error: "Pick what happened." }, 400);
    const note = clip(body.note, 1000), when = /^\d{4}-\d{2}-\d{2}$/.test(String(body.when ?? "")) ? String(body.when) : null;
    const entry = { at: new Date().toISOString(), by: user.email, outcome: body.outcome, ...(note ? { note } : {}), ...(when ? { when } : {}) };
    const [r] = await sql`update os.records set status = ${o[1]}, updated_at = now(),
        next_step = ${body.outcome === "callback" ? `call back${when ? " on " + when : ""}` : body.outcome === "no_answer" ? "try again" : body.outcome === "meeting" ? `meeting${when ? " on " + when : ""}` : null},
        next_step_due = ${when ?? (body.outcome === "no_answer" ? new Date(Date.now() + 86400000).toISOString().slice(0, 10) : null)},
        data = jsonb_set(data, '{calls}', coalesce(data->'calls', '[]'::jsonb) || ${sql.json([entry])})
      where id = ${Number(body.id)} and business_id = ${bid} returning id, title, data->>'phone' as phone, data->>'whatsapp' as whatsapp`;
    if (!r) return json({ error: "Not found." }, 404);
    await sql`insert into os.calls (business_id, direction, to_number, record_id, user_id, status, outcome, note, ended_at, duration_sec, minutes, cost_usd, billed_usd)
      values (${bid}, 'outbound', ${wa(r.whatsapp) || wa(r.phone) || null}, ${r.id}, ${user.id}, 'whatsapp', ${String(body.outcome)}, ${note || null}, now(), 0, 0, 0, 0)`;
    if (body.outcome === "signed") await sql`insert into os.wins (business_id, kind, record_id, created_by) values (${bid}, 'job', ${r.id}, ${user.email})`;
    await post(bid, "system", `${o[2] ? "@demarcus " : ""}Call logged (WhatsApp): #${r.id} ${r.title}: ${o[0]}${when ? ` (${when})` : ""}.${note ? ` Notes: ${note}` : ""}`, { status: o[2] ? "queued" : "handled", recordId: r.id });
    await audit(bid, "user", user.email, "wa_call", String(r.id), { outcome: body.outcome });
    return json({ ok: true });
  }
  if (action === "push_unsubscribe") {
    await sql`delete from os.push_subs where user_id = ${user.id} and endpoint = ${clip(body.endpoint, 1000)}`;
    return json({ ok: true });
  }

  if (action === "summary") {
    const wins = await sql`select kind, count(*)::int as n, coalesce(sum(value_usd), 0)::float as usd from os.wins
      where business_id = ${bid} and at >= date_trunc('month', now()) group by kind`;
    const quotes = await sql`select id, title, status, data, next_step, next_step_due, created_at, updated_at from os.records
      where business_id = ${bid} and type = 'quote' order by (status in ('sent','following up')) desc, updated_at desc limit 150`;
    const [c] = await sql`select count(*)::int as n from os.records where business_id = ${bid} and type = 'customer'`;
    const [o] = await sql`select count(*)::int as n from os.optouts where business_id = ${bid}`;
    const [s] = await sql`select review_link, sender_name, follow_ups, review_asks, weekly_recap, morning_message from os.growth_settings where business_id = ${bid}`;
    const [playbook] = await sql`select key, label, idea from os.playbook_for(${bid})`;
    const inquiries = await sql`select id, title, status, data - 'ip' as data, created_at from os.records
      where business_id = ${bid} and type = 'inquiry' order by (status = 'new') desc, created_at desc limit 40`;
    const [biz] = await sql`select slug from os.businesses where id = ${bid}`;
    const campaigns = await sql`select id, status, summary, payload->>'subject' as subject, note, created_at, decided_at from os.approvals
      where business_id = ${bid} and kind = 'campaign' order by id desc limit 5`;
    return json({ wins, quotes, customers: c.n, reachable: await recipients(bid), optouts: o.n, settings: s ?? { review_link: null, sender_name: null, follow_ups: true, review_asks: true, weekly_recap: true, morning_message: true }, playbook: playbook ?? null, campaigns, inquiries, slug: biz?.slug, can_edit: canEdit });
  }

  if (action === "quote_add") {
    const d = { name: clip(body.name, 120), email: clip(body.email, 200).toLowerCase(), phone: clip(body.phone, 40), job: clip(body.job, 200),
      amount: clip(body.amount, 20).replace(/[^0-9.]/g, ""), sent_on: /^\d{4}-\d{2}-\d{2}$/.test(String(body.sent_on)) ? String(body.sent_on) : new Date().toISOString().slice(0, 10) };
    if (d.name.length < 2) return json({ error: "Add the customer's name." }, 400);
    if (d.email && !EMAIL.test(d.email)) return json({ error: "That email doesn't look right." }, 400);
    const [r] = await sql`insert into os.records (business_id, type, status, title, data, created_by, next_step, next_step_due)
      values (${bid}, 'quote', 'sent', ${d.name + (d.job ? ` · ${d.job}` : "")}, ${sql.json(d)}, 'owner',
        ${d.email ? "follow-up 1 on day 2" : "add their email so the team can follow up"}, ${d.email ? new Date(Date.parse(d.sent_on) + 2 * 86400000).toISOString().slice(0, 10) : null}) returning id`;
    await sql`insert into os.wins (business_id, kind, record_id, value_usd, created_by) values (${bid}, 'estimate', ${r.id}, ${d.amount ? Number(d.amount) : null}, ${user.email})`;
    await audit(bid, "user", user.email, "quote_add", String(r.id), {});
    return json({ ok: true, id: r.id });
  }

  if (action === "quote_set") {
    const id = Number(body.id), status = String(body.status);
    if (!["won", "lost", "sent"].includes(status)) return json({ error: "Unknown status." }, 400);
    const amount = clip(body.amount, 20).replace(/[^0-9.]/g, "");
    const [r] = await sql`update os.records set status = ${status}, updated_at = now(), next_step = ${status === "sent" ? "follow-ups resume" : null}, next_step_due = null,
      data = data || ${sql.json({ ...(status === "won" ? { won_on: new Date().toISOString().slice(0, 10) } : {}), ...(amount ? { amount } : {}) })}
      where id = ${id} and business_id = ${bid} and type in ('quote', 'customer', 'lead') returning id, title, data`;
    if (!r) return json({ error: "Not found." }, 404);
    if (status === "won") await sql`insert into os.wins (business_id, kind, record_id, value_usd, created_by) values (${bid}, 'job', ${id}, ${r.data?.amount ? Number(r.data.amount) : null}, ${user.email})`;
    // Follow-ups still waiting for an OK are dropped once the quote is decided.
    if (status !== "sent") await sql`update os.approvals set status = 'rejected', note = 'Quote was marked ' || ${status} || '; follow-up not needed.', decided_at = now(), decided_by = 'system'
      where business_id = ${bid} and status = 'pending' and payload->>'ref_record' = ${String(id)} and summary like 'Follow-up%'`;
    await audit(bid, "user", user.email, `quote_${status}`, String(id), { amount: amount || undefined });
    return json({ ok: true });
  }

  if (action === "inquiry_done") {
    const [r] = await sql`update os.records set status = 'handled', next_step = null, next_step_due = null, updated_at = now()
      where id = ${Number(body.id)} and business_id = ${bid} and type = 'inquiry' returning id`;
    if (!r) return json({ error: "Not found." }, 404);
    return json({ ok: true });
  }

  if (action === "repeat_job") {
    const amount = clip(body.amount, 20).replace(/[^0-9.]/g, "");
    const [r] = await sql`select id from os.records where id = ${Number(body.id)} and business_id = ${bid} and type = 'customer'`;
    if (!r) return json({ error: "Not found." }, 404);
    await sql`insert into os.wins (business_id, kind, record_id, value_usd, created_by) values (${bid}, 'repeat', ${r.id}, ${amount ? Number(amount) : null}, ${user.email})`;
    return json({ ok: true });
  }

  // Bring in a whole list at once: a spreadsheet (as text) or a photo/screenshot of one. The AI reads it into rows,
  // the owner checks a preview, then import_rows saves them.
  if (action === "extract_list") {
    const kind = body.kind === "quotes" ? "quotes" : body.kind === "invoices" ? "invoices" : "customers";
    const text = clip(body.text, 60000), image = String(body.image ?? "");
    if (!text && !/^[A-Za-z0-9+/=]{100,}$/.test(image)) return json({ error: "Add a file, a photo or some text first." }, 400);
    if (image.length > 7_000_000) return json({ error: "That photo is too big. Try a smaller one or a screenshot." }, 400);
    const b = await business(bid);
    const fields = kind === "quotes"
      ? '{"name": "", "email": "", "phone": "", "job": "what the estimate was for", "amount": "number only", "sent_on": "YYYY-MM-DD or empty"}'
      : kind === "invoices"
      ? '{"name": "", "email": "", "phone": "", "number": "invoice number or empty", "job": "what it was for", "amount": "number only", "issued_on": "YYYY-MM-DD or empty", "due_on": "YYYY-MM-DD or empty", "paid": "yes if it is marked paid, else empty"}'
      : '{"name": "", "email": "", "phone": "", "service": "what they had done", "last_job": "YYYY-MM-DD or empty"}';
    const ask = `This is a business owner's list of ${kind === "quotes" ? "estimates/quotes they sent to customers" : kind === "invoices" ? "invoices they sent to customers" : "past customers"}. Read every row and return ONLY a JSON array of objects shaped like ${fields}. One object per person or row. Copy names, emails and phone numbers exactly as written; leave a field empty if it isn't there. Skip header rows, totals and blank lines. Never invent anything. Today is ${new Date().toISOString().slice(0, 10)}.`;
    const content: any[] = image ? [{ type: "image", source: { type: "base64", media_type: String(body.media_type || "image/jpeg"), data: image } }, { type: "text", text: ask }] : [{ type: "text", text: `${ask}\n\nTHE LIST:\n${text}` }];
    try {
      const res = await claude(b!, "analysis", { model: "claude-haiku-5-5", max_tokens: 16000, messages: [{ role: "user", content }] }, 120_000);
      const out = (res.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
      const rows = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1));
      if (!Array.isArray(rows)) throw new Error("no rows");
      const clean = rows.slice(0, 2000).map((r: any) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, clip(v, 300)]).filter(([, v]) => v)))
        .filter((r: any) => r.name || r.email || r.phone);
      return json({ kind, rows: clean, truncated: rows.length > 2000 });
    } catch (e) {
      return json({ error: `Couldn't read that list (${(e as Error).message.slice(0, 120)}). Try a clearer photo, or the spreadsheet file itself.` }, 422);
    }
  }

  if (action === "import_rows") {
    const kind = body.kind === "quotes" ? "quotes" : body.kind === "invoices" ? "invoices" : "customers";
    const rows: any[] = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
    let added = 0, skipped = 0, old = 0;
    const today = new Date().toISOString().slice(0, 10);
    if (kind === "customers") {
      const existing = new Set((await sql`select lower(coalesce(data->>'email', '')) || '|' || regexp_replace(coalesce(data->>'phone', ''), '\\D', '', 'g') as k, lower(data->>'email') as e
        from os.records where business_id = ${bid} and type = 'customer'`).flatMap((x: any) => [x.k, x.e].filter(Boolean)));
      for (const r of rows) {
        const email = clip(r.email, 200).toLowerCase(), phone = clip(r.phone, 40), name = clip(r.name, 120) || email.split("@")[0] || phone;
        if (email && !EMAIL.test(email)) { skipped++; continue; }
        const key = `${email}|${phone.replace(/\D/g, "")}`;
        if ((!email && !phone) || existing.has(email) || existing.has(key)) { skipped++; continue; }
        const d = { name, ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(r.service ? { service: clip(r.service, 200) } : {}), ...(r.last_job ? { last_job: clip(r.last_job, 20) } : {}), source: "imported list" };
        await sql`insert into os.records (business_id, type, status, title, data, created_by) values (${bid}, 'customer', 'past', ${name}, ${sql.json(d)}, 'owner')`;
        if (email) existing.add(email); existing.add(key); added++;
      }
    } else if (kind === "invoices") {
      // Nora's: unpaid ones get chased (reminders wait for the owner's OK); paid ones are kept as history.
      const have = new Set((await sql`select lower(coalesce(data->>'number', '')) || '|' || lower(coalesce(data->>'email', title)) || '|' || coalesce(data->>'amount', '') as k
        from os.records where business_id = ${bid} and type = 'invoice'`).map((x: any) => x.k));
      const day = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null;
      for (const r of rows) {
        const email = clip(r.email, 200).toLowerCase(), name = clip(r.name, 120);
        const amount = String(r.amount ?? "").replace(/[^0-9.]/g, "");
        if (!name || !amount || (email && !EMAIL.test(email))) { skipped++; continue; }
        const key = `${clip(r.number, 40).toLowerCase()}|${email || name.toLowerCase()}|${amount}`;
        if (have.has(key)) { skipped++; continue; }
        const paid = /^(y|yes|paid|true)$/i.test(String(r.paid ?? "").trim());
        const due = day(r.due_on), issued = day(r.issued_on);
        const d = { name, ...(email ? { email } : {}), ...(r.phone ? { phone: clip(r.phone, 40) } : {}), ...(r.number ? { number: clip(r.number, 40) } : {}),
          ...(r.job ? { job: clip(r.job, 200) } : {}), amount, ...(issued ? { issued_on: issued } : {}), ...(due ? { due_on: due } : {}), ...(paid ? { paid_on: due ?? issued ?? today } : {}), source: "imported list" };
        const nextDue = paid ? null : due && due >= today ? new Date(Date.parse(due) + 86400000).toISOString().slice(0, 10) : today;
        await sql`insert into os.records (business_id, type, status, title, data, owner_slot, created_by, next_step, next_step_due)
          values (${bid}, 'invoice', ${paid ? "paid" : "unpaid"}, ${name + (r.number ? ` · #${clip(r.number, 40)}` : r.job ? ` · ${clip(r.job, 80)}` : "")}, ${sql.json(d)}, 'finance', 'owner',
            ${paid ? null : email ? "friendly payment reminder (for your OK)" : "add their email so Nora can send reminders"}, ${nextDue})`;
        have.add(key); added++; if (paid) old++;
      }
      if (added > old) await post(bid, "system", `@nora The owner imported ${added - old} unpaid invoice${added - old === 1 ? "" : "s"}. Check them with money_numbers and draft reminders for the overdue ones (for approval).`);
    } else {
      const have = new Set((await sql`select lower(coalesce(data->>'email', '')) || '|' || lower(coalesce(data->>'job', '')) as k from os.records where business_id = ${bid} and type = 'quote'`).map((x: any) => x.k));
      for (const r of rows) {
        const email = clip(r.email, 200).toLowerCase(), name = clip(r.name, 120);
        if (!name || (email && !EMAIL.test(email))) { skipped++; continue; }
        const job = clip(r.job, 200), key = `${email}|${job.toLowerCase()}`;
        if (email && have.has(key)) { skipped++; continue; }
        const sent = /^\d{4}-\d{2}-\d{2}$/.test(String(r.sent_on)) && String(r.sent_on) <= today ? String(r.sent_on) : today;
        const age = (Date.parse(today) - Date.parse(sent)) / 86400000;
        // Recent quotes get the day 2/5/10 follow-ups; older ones are kept as history without emailing anyone out of the blue.
        const status = age > 30 ? "no answer" : "sent";
        const d = { name, ...(email ? { email } : {}), ...(r.phone ? { phone: clip(r.phone, 40) } : {}), ...(job ? { job } : {}), ...(r.amount ? { amount: String(r.amount).replace(/[^0-9.]/g, "") } : {}), sent_on: sent, source: "imported list" };
        await sql`insert into os.records (business_id, type, status, title, data, created_by, next_step, next_step_due)
          values (${bid}, 'quote', ${status}, ${name + (job ? ` · ${job}` : "")}, ${sql.json(d)}, 'owner',
            ${status === "sent" ? (email ? "follow-ups on day 2, 5 and 10" : "add their email so the team can follow up") : null}, null)`;
        if (email) have.add(key); added++; if (status !== "sent") old++;
      }
    }
    await audit(bid, "user", user.email, "import_rows", null, { kind, added, skipped, old });
    return json({ ok: true, added, skipped, old });
  }

  if (action === "customers_import") {
    const lines = String(body.text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3000);
    let added = 0, skipped = 0;
    const existing = new Set((await sql`select lower(data->>'email') as e from os.records where business_id = ${bid} and type = 'customer' and data ? 'email'`).map((x: any) => x.e));
    for (const line of lines) {
      const parts = line.split(/\t|,|;/).map((p) => p.trim().replace(/^"|"$/g, "")).filter(Boolean);
      const email = parts.find((p) => EMAIL.test(p))?.toLowerCase();
      if (!email || existing.has(email) || /^e-?mail$/i.test(parts[0] ?? "")) { skipped++; continue; }
      const rest = parts.filter((p) => p.toLowerCase() !== email);
      const phone = rest.find((p) => /^[+()\d\s.-]{7,}$/.test(p)) ?? "";
      const date = rest.find((p) => /\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/.test(p)) ?? "";
      const words = rest.filter((p) => p !== phone && p !== date);
      const name = words[0] ?? email.split("@")[0];
      const d = { name, email, ...(phone ? { phone } : {}), ...(words[1] ? { service: words.slice(1).join(", ") } : {}), ...(date ? { last_job: date } : {}) };
      await sql`insert into os.records (business_id, type, status, title, data, created_by) values (${bid}, 'customer', 'past', ${name}, ${sql.json(d)}, 'owner')`;
      existing.add(email); added++;
    }
    await audit(bid, "user", user.email, "customers_import", null, { added, skipped });
    return json({ ok: true, added, skipped });
  }

  if (action === "campaign_create") {
    const subject = clip(body.subject, 160), text = clip(body.body, 6000);
    if (subject.length < 3 || text.length < 20) return json({ error: "Write a subject and a message." }, 400);
    const n = await recipients(bid);
    if (!n) return json({ error: "There are no past customers with an email address yet. Add some first." }, 400);
    const payload = { subject, body: text, audience: "past customers", recipients: n };
    // The owner wrote it and confirmed, so it's approved now; os-jobs sends it within a few minutes.
    const [a] = await sql`insert into os.approvals (business_id, kind, summary, payload, original_payload, requested_by, status, decided_by, decided_at)
      values (${bid}, 'campaign', ${`Email to ${n} past customers: ${subject}`}, ${sql.json(payload)}, ${sql.json(payload)}, 'owner', 'approved', ${"user:" + user.id}, now()) returning id`;
    await audit(bid, "user", user.email, "campaign_create", String(a.id), { recipients: n });
    return json({ ok: true, recipients: n });
  }

  if (action === "campaign_ask") {
    const idea = clip(body.idea, 1000);
    await post(bid, "owner", `@kole Please write a seasonal email to our past customers${idea ? `: ${idea}` : "."} Keep it short and warm, one clear reason to book now, and only offers or prices I've actually given. Queue it with request_approval, kind "campaign", payload {subject, body}. It goes to every past customer who hasn't opted out, and an unsubscribe link is added automatically.`, { senderName: "Owner" });
    return json({ ok: true });
  }

  if (action === "settings_set") {
    const link = clip(body.review_link, 400);
    if (link && !/^https:\/\/\S+$/.test(link)) return json({ error: "The review link should start with https://" }, 400);
    await sql`insert into os.growth_settings (business_id, review_link, sender_name, follow_ups, review_asks, weekly_recap, morning_message, updated_at)
      values (${bid}, ${link || null}, ${clip(body.sender_name, 80) || null}, ${body.follow_ups !== false}, ${body.review_asks !== false}, ${body.weekly_recap !== false}, ${body.morning_message !== false}, now())
      on conflict (business_id) do update set review_link = excluded.review_link, sender_name = excluded.sender_name,
        follow_ups = excluded.follow_ups, review_asks = excluded.review_asks, weekly_recap = excluded.weekly_recap, morning_message = excluded.morning_message, updated_at = now()`;
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
});
