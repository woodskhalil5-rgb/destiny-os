// os-growth: the Customers screen. Quotes the owner logs (followed up at 2, 5 and 10 days), wins, past customers,
// seasonal emails to them, review-request settings, and the public unsubscribe link.
// Signed-in calls use the dashboard's session token (x-os-token); 'unsub' is public and checks a signed link.
import { audit, post, sql } from "../_core/core.ts";
import { unsubToken } from "../_core/unsub.ts";
import { pushTo, vapidPublic } from "../_core/push.ts";

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

  const user = await who(req);
  if (!user) return json({ error: "Please sign in." }, 401);
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
    const [s] = await sql`select review_link, sender_name, follow_ups, review_asks from os.growth_settings where business_id = ${bid}`;
    const inquiries = await sql`select id, title, status, data - 'ip' as data, created_at from os.records
      where business_id = ${bid} and type = 'inquiry' order by (status = 'new') desc, created_at desc limit 40`;
    const [biz] = await sql`select slug from os.businesses where id = ${bid}`;
    const campaigns = await sql`select id, status, summary, payload->>'subject' as subject, note, created_at, decided_at from os.approvals
      where business_id = ${bid} and kind = 'campaign' order by id desc limit 5`;
    return json({ wins, quotes, customers: c.n, reachable: await recipients(bid), optouts: o.n, settings: s ?? { review_link: null, sender_name: null, follow_ups: true, review_asks: true }, campaigns, inquiries, slug: biz?.slug, can_edit: canEdit });
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
    await sql`insert into os.growth_settings (business_id, review_link, sender_name, follow_ups, review_asks, updated_at)
      values (${bid}, ${link || null}, ${clip(body.sender_name, 80) || null}, ${body.follow_ups !== false}, ${body.review_asks !== false}, now())
      on conflict (business_id) do update set review_link = excluded.review_link, sender_name = excluded.sender_name,
        follow_ups = excluded.follow_ups, review_asks = excluded.review_asks, updated_at = now()`;
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
});
