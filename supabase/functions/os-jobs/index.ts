// os-jobs: runs every 5 minutes (pg_cron -> os.jobs()).
//  1. Sends alert emails (agent errors, failed payments, budget) to the platform owner or the business owner.
//  2. Publishes approved content whose scheduled time has come (Facebook Page today; anything else is flagged to post by hand).
//  3. Watches each business's connected Gmail inbox (when "watch for replies" is on): owner emails go on the board,
//     replies from records' email addresses mark the record "replied" and wake the team.
import { audit, post, secret, sql } from "../_core/core.ts";
import { platformMail } from "../_core/mail.ts";
import { ImapFlow } from "npm:imapflow@1";
import { simpleParser } from "npm:mailparser@3";

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


function stripQuoted(text: string) {
  const out: string[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const t = line.trim();
    if ((/^On .+/.test(t) && /wrote:?$/.test(t)) || /^-{2,}\s*Original Message/i.test(t) || /^From:\s/.test(t) || /^Sent from my/i.test(t)) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim().slice(0, 3000);
}

async function watchInboxes() {
  const conns = await sql`select i.business_id, i.settings, i.updated_at, b.slug, b.name from os.integrations i join os.businesses b on b.id = i.business_id
    where i.provider = 'gmail' and i.status = 'connected' and coalesce((i.settings->>'check_inbox')::boolean, false) and b.status = 'live'`;
  const result: Record<string, unknown> = {};
  for (const c of conns) {
    const [pw] = await sql`select decrypted_secret as v from vault.decrypted_secrets where name = ${c.slug + ":GMAIL_APP_PASSWORD"}`;
    if (!pw || !c.settings.user) { result[c.slug] = "no password"; continue; }
    const startAt = new Date(c.settings.mail_since ?? c.updated_at);
    const [cfg] = await sql`select config->'owner'->>'email' as owner from os.business_config where business_id = ${c.business_id} and active`;
    const owner = String(cfg?.owner ?? "").toLowerCase();
    const recs = await sql`select id, title, lower(data->>'email') as email from os.records where business_id = ${c.business_id} and coalesce(data->>'email', '') <> ''`;
    const byEmail = new Map(recs.map((r: any) => [r.email, r]));
    const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: c.settings.user, pass: String(pw.v).replace(/\s+/g, "") }, logger: false });
    let handled = 0;
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = (await client.search({ since: new Date(Date.now() - 3 * 86400000) }, { uid: true })) || [];
        const wanted: { uid: number; mid: string; from: string }[] = [];
        for await (const m of client.fetch(uids.slice(-80), { envelope: true }, { uid: true })) {
          const from = (m.envelope?.from?.[0]?.address ?? "").toLowerCase();
          if (from !== owner && !byEmail.has(from)) continue;
          if (m.envelope?.date && new Date(m.envelope.date) < startAt) continue;
          wanted.push({ uid: m.uid, mid: m.envelope?.messageId || `uid-${m.uid}`, from });
        }
        for (const w of wanted) {
          const [claimed] = await sql`insert into os.mail_seen (business_id, message_id) values (${c.business_id}, ${w.mid}) on conflict do nothing returning message_id`;
          if (!claimed) continue;
          const one = await client.fetchOne(String(w.uid), { source: true }, { uid: true });
          if (!one) continue;
          const parsed = await simpleParser(one.source);
          const text = stripQuoted(parsed.text ?? "") || (parsed.subject ?? "");
          if (w.from === owner) {
            await post(c.business_id, "owner", `(by email) ${text}`, { senderName: "Owner" });
          } else {
            const r: any = byEmail.get(w.from);
            await sql`update os.records set status = 'replied', next_step = 'owner to respond', updated_at = now() where id = ${r.id}`;
            await post(c.business_id, "system", `@demarcus #${r.id} ${r.title} replied by email: "${text.slice(0, 1200)}"`, { recordId: r.id });
            await sql`select os.alert(${c.business_id}, 'business', 'reply', ${`${r.title} replied`}, ${`${r.title} replied to your team's email:\n\n${text.slice(0, 1500)}\n\nThe team has been told; reply from your inbox or the dashboard.`}, ${"reply:" + w.mid})`;
          }
          handled++;
        }
      } finally { lock.release(); }
    } catch (e) {
      result[c.slug] = `error: ${(e as Error).message}`;
      await sql`select os.alert(${c.business_id}, 'platform', 'inbox_error', ${c.name + ": inbox check failed"}, ${(e as Error).message}, ${"inbox:" + c.business_id + ":" + new Date().toISOString().slice(0, 13)})`;
      continue;
    } finally { await client.logout().catch(() => {}); }
    result[c.slug] = handled;
  }
  return result;
}

Deno.serve(async (req) => {
  const key = await secret("OS_INVOKE_KEY");
  if (!key || (req.headers.get("authorization") ?? "") !== `Bearer ${key}`) return new Response("forbidden", { status: 403 });
  const out: Record<string, unknown> = {};
  try { out.inbox = await watchInboxes(); } catch (e) { out.inbox_error = (e as Error).message; }
  try { out.alerts = await sendAlerts(); } catch (e) { out.alerts_error = (e as Error).message; }
  try { out.published = await publishDue(); } catch (e) { out.publish_error = (e as Error).message; }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
});
