// os-jobs: runs every 5 minutes (pg_cron -> os.jobs()).
//  1. Sends alert emails (agent errors, failed payments, budget) to the platform owner or the business owner.
//  2. Publishes approved content whose scheduled time has come (Facebook Page today; anything else is flagged to post by hand).
import { audit, post, secret, sql } from "../_core/core.ts";
import { platformMail } from "../_core/mail.ts";

async function ownerEmailFor(bid: string | null) {
  if (!bid) return null;
  const [c] = await sql`select config->'owner'->>'email' as e from os.business_config where business_id = ${bid} and active`;
  if (c?.e) return c.e as string;
  const [m] = await sql`select u.email from os.business_members m join auth.users u on u.id = m.user_id where m.business_id = ${bid} and m.role = 'owner' order by m.created_at limit 1`;
  return (m?.email as string) ?? null;
}

async function sendAlerts() {
  // Anything not delivered within a day is dropped rather than retried forever.
  await sql`update os.alerts set sent_at = now(), error = coalesce(error, '') || ' (expired)' where sent_at is null and created_at < now() - interval '1 day'`;
  const rows = await sql`select a.*, b.name as biz from os.alerts a left join os.businesses b on b.id = a.business_id where a.sent_at is null order by a.id limit 50`;
  if (!rows.length) return 0;
  const platformTo = await secret("OS_OWNER_EMAIL");
  // Group per recipient so a burst becomes one email.
  const groups = new Map<string, any[]>();
  for (const a of rows) {
    const to = a.audience === "platform" ? platformTo : await ownerEmailFor(a.business_id);
    if (!to) { await sql`update os.alerts set sent_at = now(), error = 'no recipient' where id = ${a.id}`; continue; }
    groups.set(to, [...(groups.get(to) ?? []), a]);
  }
  let sent = 0;
  for (const [to, list] of groups) {
    const subject = list.length === 1 ? list[0].subject : `Destiny OS: ${list.length} updates`;
    const text = list.map((a) => (list.length > 1 ? `• ${a.subject}\n  ${a.body}` : a.body)).join("\n\n") + "\n\n— Destiny OS";
    try {
      await platformMail(to, subject, text);
      await sql`update os.alerts set sent_at = now(), error = null where id = any(${sql.array(list.map((a) => a.id))})`;
      sent += list.length;
    } catch (e) {
      await sql`update os.alerts set error = ${(e as Error).message.slice(0, 300)} where id = any(${sql.array(list.map((a) => a.id))})`;
    }
  }
  return sent;
}

async function publishDue() {
  const due = await sql`select c.*, b.slug, b.name as biz from os.content c join os.businesses b on b.id = c.business_id
    where c.status = 'scheduled' and c.scheduled_for <= now() and b.status <> 'archived' order by c.scheduled_for limit 20`;
  let done = 0;
  for (const c of due) {
    const channel = String(c.channel ?? "facebook").toLowerCase();
    const [fb] = await sql`select settings from os.integrations where business_id = ${c.business_id} and provider = 'facebook' and status = 'connected'`;
    const [tok] = fb ? await sql`select decrypted_secret as v from vault.decrypted_secrets where name = ${c.slug + ":FACEBOOK_PAGE_TOKEN"}` : [];
    const isFb = /facebook|^fb|^$/.test(channel);
    if (!isFb || !fb || !tok) {
      await sql`update os.content set status = 'needs_manual', note = ${isFb ? "Facebook isn't connected" : `No automatic publishing for ${channel} yet`} where id = ${c.id}`;
      await post(c.business_id, "system", `Content #${c.id}${c.title ? ` "${c.title}"` : ""} is due on ${c.channel ?? "Facebook"}, but it can't be posted automatically (${isFb ? "Facebook isn't connected under Connections" : "only Facebook is automatic so far"}). Post it by hand, then mark it done.`, { status: "handled" });
      await sql`select os.alert(${c.business_id}, 'business', 'publish_manual', ${"A post is ready for you to publish"}, ${`Content #${c.id} for ${c.channel ?? "Facebook"} is due now. Open the Content tab to copy it and post it.`}, ${"pm:" + c.id})`;
      continue;
    }
    const message = [c.title && !c.body?.startsWith(c.title) ? c.title : null, c.body].filter(Boolean).join("\n\n");
    const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(fb.settings.page_id)}/feed`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message, access_token: tok.v }).toString(), signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.id) {
      await sql`update os.content set status = 'published', published_at = now(), note = ${"Facebook post " + j.id} where id = ${c.id}`;
      await post(c.business_id, "system", `Published content #${c.id} to Facebook.`, { status: "handled" });
      await audit(c.business_id, "system", "publisher", "published", String(c.id), { facebook_post: j.id });
      done++;
    } else {
      const err = j.error?.message ?? `HTTP ${r.status}`;
      await sql`update os.content set status = 'failed', note = ${"Facebook: " + err} where id = ${c.id}`;
      await post(c.business_id, "system", `Couldn't publish content #${c.id} to Facebook: ${err}. @grayson tell the owner; it may need reconnecting.`, { status: "queued" });
      await sql`select os.alert(${c.business_id}, 'business', 'publish_failed', ${"A scheduled post didn't publish"}, ${`Content #${c.id} couldn't be posted to Facebook: ${err}. Check Connections in your dashboard.`}, ${"pf:" + c.id})`;
    }
  }
  return done;
}

Deno.serve(async (req) => {
  const key = await secret("OS_INVOKE_KEY");
  if (!key || (req.headers.get("authorization") ?? "") !== `Bearer ${key}`) return new Response("forbidden", { status: 403 });
  const out: Record<string, unknown> = {};
  try { out.alerts = await sendAlerts(); } catch (e) { out.alerts_error = (e as Error).message; }
  try { out.published = await publishDue(); } catch (e) { out.publish_error = (e as Error).message; }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
});
