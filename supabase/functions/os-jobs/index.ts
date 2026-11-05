// os-jobs: runs every 5 minutes (pg_cron -> os.jobs()).
//  1. Sends alert emails (agent errors, failed payments, budget) to the platform owner or the business owner.
//  2. Publishes approved content whose scheduled time has come (Facebook Page today; anything else is flagged to post by hand).
//  3. Watches each business's connected Gmail inbox (when "watch for replies" is on): owner emails go on the board,
//     replies from records' email addresses mark the record "replied" and wake the team.
import { audit, post, secret, sql } from "../_core/core.ts";
import { platformMail } from "../_core/mail.ts";
import { download, mediaFor } from "../_core/storage.ts";
import { describePending } from "../_core/vision.ts";
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
  // A post stuck mid-upload (the run timed out) is marked failed so the owner hears about it instead of it vanishing.
  await sql`update os.content set status = 'failed', note = 'Facebook: the upload timed out. Check the Page before posting again.'
    where status = 'publishing' and scheduled_for < now() - interval '20 minutes'`;
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
    // A system-user or user token can't post as the Page itself; trade it for the Page's own token when possible.
    const pg = await fetch(`${FB}/${encodeURIComponent(fb.settings.page_id)}?fields=access_token&access_token=${encodeURIComponent(tok.v)}`, { signal: AbortSignal.timeout(15_000) })
      .then((x) => x.json()).catch(() => ({}));
    const pageTok: string = pg?.access_token ?? tok.v;
    // Claim it first so a slow upload can't be picked up twice by the next run.
    const [claimed] = await sql`update os.content set status = 'publishing' where id = ${c.id} and status = 'scheduled' returning id`;
    if (!claimed) continue;
    let res: { id?: string; err?: string };
    try { res = await publishOne(fb.settings.page_id, pageTok, c, message); } catch (e) { res = { err: (e as Error).message }; }
    if (res.id) {
      await sql`update os.content set status = 'published', published_at = now(), note = ${"Facebook " + (c.kind === "reel" ? "reel " : "post ") + res.id} where id = ${c.id}`;
      await post(c.business_id, "system", `Published content #${c.id} to Facebook${c.kind === "reel" ? " as a Reel" : ""}.`, { status: "handled" });
      await audit(c.business_id, "system", "publisher", "published", String(c.id), { facebook_id: res.id });
      done++;
    } else {
      const err = res.err ?? "unknown error";
      await sql`update os.content set status = 'failed', note = ${"Facebook: " + err} where id = ${c.id}`;
      await post(c.business_id, "system", `Couldn't publish content #${c.id} to Facebook: ${err}. @grayson tell the owner; it may need reconnecting.`, { status: "queued" });
      await sql`select os.alert(${c.business_id}, 'business', 'publish_failed', ${"A scheduled post didn't publish"}, ${`Content #${c.id} couldn't be posted to Facebook: ${err}. Check Connections in your dashboard.`}, ${"pf:" + c.id})`;
    }
  }
  return done;
}

const FB = "https://graph.facebook.com/v24.0";
async function fbPost(path: string, form: Record<string, string> | FormData, timeout = 60_000) {
  const body = form instanceof FormData ? form : new URLSearchParams(form);
  const r = await fetch(`${FB}/${path}`, { method: "POST", body, signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

/** Posts one piece of content to a Page: text, photos (1-10) or one video (a Reel when kind is 'reel'). Returns the Facebook id. */
async function publishOne(pageId: string, tok: string, c: any, message: string): Promise<{ id?: string; err?: string }> {
  const page = encodeURIComponent(pageId);
  const ids: number[] = (c.media_ids ?? []).map(Number);
  const media = ids.length ? await mediaFor(c.business_id, ids) : [];
  if (media.length !== ids.length) return { err: "a photo or video attached to this post was deleted from the library" };
  const file = async (m: any) => new Blob([await download(m.path)], { type: m.mime || "application/octet-stream" });

  if (!media.length) return { id: (await fbPost(`${page}/feed`, { message, access_token: tok })).id };

  const video = media.find((m) => m.kind === "video");
  if (video) {
    const bytes = await download(video.path);
    if (c.kind === "reel") {
      // Reels: start an upload session, send the bytes, then publish with the caption.
      const start = await fbPost(`${page}/video_reels`, { upload_phase: "start", access_token: tok });
      const up = await fetch(`https://rupload.facebook.com/video-upload/v24.0/${start.video_id}`, {
        method: "POST", headers: { Authorization: `OAuth ${tok}`, offset: "0", file_size: String(bytes.length) }, body: bytes, signal: AbortSignal.timeout(180_000),
      });
      const uj = await up.json().catch(() => ({}));
      if (!up.ok || !uj.success) return { err: `video upload failed: ${uj.debug_info?.message ?? uj.error?.message ?? up.status}` };
      await fbPost(`${page}/video_reels`, { upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description: message, access_token: tok });
      return { id: String(start.video_id) };
    }
    const fd = new FormData();
    fd.set("description", message); fd.set("access_token", tok);
    fd.set("source", new Blob([bytes], { type: video.mime || "video/mp4" }), "video.mp4");
    return { id: (await fbPost(`${page}/videos`, fd, 180_000)).id };
  }

  if (media.length === 1) {
    const fd = new FormData();
    fd.set("message", message); fd.set("access_token", tok); fd.set("source", await file(media[0]), "photo.jpg");
    const j = await fbPost(`${page}/photos`, fd);
    return { id: j.post_id ?? j.id };
  }
  // Several photos: upload each unpublished, then one post that carries them all.
  const fbIds: string[] = [];
  for (const m of media) {
    const fd = new FormData();
    fd.set("published", "false"); fd.set("access_token", tok); fd.set("source", await file(m), "photo.jpg");
    fbIds.push((await fbPost(`${page}/photos`, fd)).id);
  }
  const form: Record<string, string> = { message, access_token: tok };
  fbIds.forEach((id, i) => form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }));
  return { id: (await fbPost(`${page}/feed`, form)).id };
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
  try { out.described = await describePending(); } catch (e) { out.describe_error = (e as Error).message; }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
});
