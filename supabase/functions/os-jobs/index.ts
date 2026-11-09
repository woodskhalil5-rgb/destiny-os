// os-jobs: runs every 5 minutes (pg_cron -> os.jobs()).
//  1. Sends alert emails (agent errors, failed payments, budget) to the platform owner or the business owner.
//  2. Publishes approved content whose scheduled time has come (Facebook Page today; anything else is flagged to post by hand).
//  3. Watches each business's connected Gmail inbox (when "watch for replies" is on): owner emails go on the board,
//     replies from records' email addresses mark the record "replied" and wake the team.
import { audit, business, claude, post, secret, sql } from "../_core/core.ts";
import { sendEmail } from "../_core/integrations.ts";
import { unsubLink } from "../_core/unsub.ts";
import { pushTo, pushUsersFor } from "../_core/push.ts";
import { appUrl, platformMail } from "../_core/mail.ts";
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
  // Items waiting for the owner's OK go out as their own email with one-tap links.
  const okRows = rows.filter((a: any) => a.kind === "needs_ok");
  let sent = okRows.length ? await sendOkEmails(okRows) : 0;
  const rest = rows.filter((a: any) => a.kind !== "needs_ok");
  if (!rest.length) return sent;
  const platformTo = await secret("OS_OWNER_EMAIL");
  // Group per recipient so a burst becomes one email.
  const groups = new Map<string, any[]>();
  for (const a of rest) {
    // "person" alerts go to one named person (ref.to), e.g. a rep's daily brief from DeMarcus.
    const to = a.audience === "platform" ? platformTo : a.audience === "person" ? (a.ref?.to ?? null) : await ownerEmailFor(a.business_id);
    if (!to) { await sql`update os.alerts set sent_at = now(), error = 'no recipient' where id = ${a.id}`; continue; }
    groups.set(to, [...(groups.get(to) ?? []), a]);
  }
  for (const [to, list] of groups) {
    const subject = list.length === 1 ? list[0].subject : `Destiny OS: ${list.length} updates`;
    const text = list.map((a) => (list.length > 1 ? `• ${a.subject}\n  ${a.body}` : a.body)).join("\n\n") + "\n\n— Destiny OS";
    // Mark them sent first: if anything below breaks, the worst case is one missed email, never the same email over and over.
    const ids = sql.array(list.map((a) => String(a.id)));
    const marked = await sql`update os.alerts set sent_at = now(), error = null where id = any(${ids}::bigint[]) and sent_at is null returning id`;
    if (!marked.length) continue;
    try {
      await platformMail(to, subject, text);
      sent += list.length;
      // Same news on their phone, for anyone who turned notifications on. Never holds up the email.
      try {
        const audience = list[0].audience, bid = audience === "platform" ? null : list[0].business_id;
        if (audience !== "person") await pushTo(await pushUsersFor(bid, audience), { title: subject.slice(0, 80), body: list.map((a) => a.subject).join(" · ").slice(0, 160), url: "/app", tag: "alerts" });
      } catch (e) { console.error("push", (e as Error).message); }
    } catch (e) {
      await sql`update os.alerts set sent_at = null, error = ${(e as Error).message.slice(0, 300)} where id = any(${ids}::bigint[])`;
    }
  }
  return sent;
}

const esc = (t: unknown) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
async function sha256hex(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** One email per business owner listing what's waiting, each with a link to a page where one tap approves or sends it back. */
async function sendOkEmails(alerts: any[]) {
  const names = Object.fromEntries((await sql`select slot, name from os.agents`).map((a: any) => [a.slot, a.name]));
  const app = await appUrl();
  const groups = new Map<string, any[]>();
  for (const a of alerts) groups.set(a.business_id, [...(groups.get(a.business_id) ?? []), a]);
  let sent = 0;
  for (const [bid, list] of groups) {
    const ids = sql.array(list.map((a) => String(a.id)));
    const marked = await sql`update os.alerts set sent_at = now(), error = null where id = any(${ids}::bigint[]) and sent_at is null returning id`;
    if (!marked.length) continue;
    const to = await ownerEmailFor(bid);
    if (!to) { await sql`update os.alerts set error = 'no recipient' where id = any(${ids}::bigint[])`; continue; }
    // Only what is still waiting: a teammate may have decided it in the meantime.
    const items: { kind: string; title: string; from: string; what: string; preview: string; link: string }[] = [];
    for (const a of list) {
      const id = Number(a.ref?.id);
      let it: any = null;
      if (a.ref?.kind === "approval") {
        const [ap] = await sql`select summary, kind, payload, requested_by from os.approvals where id = ${id} and business_id = ${bid} and status = 'pending'`;
        if (ap) it = { kind: "approval", title: ap.summary, from: names[ap.requested_by] ?? "Your team",
          what: ap.kind === "email" ? `Email to ${ap.payload?.to ?? "a contact"}` : `${String(ap.kind).replace(/_/g, " ")} to approve`,
          preview: ap.kind === "email" ? `${ap.payload?.subject ?? ""} — ${ap.payload?.body ?? ""}` : "" };
      } else if (a.ref?.kind === "content") {
        const [c] = await sql`select title, body, kind, channel, created_by, cardinality(media_ids) as files from os.content where id = ${id} and business_id = ${bid} and status = 'pending'`;
        if (c) it = { kind: "content", title: c.title || `${c.kind} for ${c.channel ?? "Facebook"}`, from: names[c.created_by] ?? "Your team",
          what: `${c.kind === "reel" ? "Reel" : "Post"} for ${c.channel ?? "Facebook"}${c.files ? ` · ${c.files} ${c.files > 1 ? "files" : "file"}` : ""}`, preview: c.body ?? "" };
      }
      if (!it) continue;
      const token = Array.from(crypto.getRandomValues(new Uint8Array(24))).map((x) => x.toString(16).padStart(2, "0")).join("");
      await sql`insert into os.approval_links (token_hash, business_id, item_kind, item_id, expires_at) values (${await sha256hex(token)}, ${bid}, ${it.kind}, ${id}, now() + interval '3 days')`;
      items.push({ ...it, preview: String(it.preview).replace(/\s+/g, " ").trim().slice(0, 220), link: `${app}/ok?t=${token}` });
    }
    if (!items.length) continue;
    const biz = list[0].biz ?? "your business";
    const subject = items.length === 1 ? `OK to ${items[0].kind === "content" ? "post" : "send"}? ${items[0].title}`.slice(0, 140) : `${items.length} things need your OK · ${biz}`;
    const text = `${biz}: ${items.length === 1 ? "this needs" : "these need"} your OK. Tap a link to see it and approve or send it back.\n\n`
      + items.map((i) => `• ${i.title} (${i.what}, from ${i.from})\n  ${i.link}`).join("\n\n")
      + `\n\nEach link works for 3 days, for that item only. Or review everything in your dashboard: ${app}/app\n\n— Destiny OS`;
    const html = `<!doctype html><html><body style="margin:0;background:#f3f5f2;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18222d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f2;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 14px;font-size:14px;color:#68737e"><b style="color:#106b55">Destiny OS</b> · ${esc(biz)}</td></tr>
<tr><td style="padding:0 4px 18px;font-size:24px;font-weight:800;line-height:1.2">${items.length === 1 ? "1 thing needs your OK" : `${items.length} things need your OK`}</td></tr>
${items.map((i) => `<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #dfe4de;border-radius:14px"><tr><td style="padding:18px 20px">
<div style="font-size:13px;color:#68737e;margin-bottom:6px">${esc(i.what)} · from ${esc(i.from)}</div>
<div style="font-size:17px;font-weight:700;margin-bottom:8px">${esc(i.title)}</div>
${i.preview ? `<div style="font-size:15px;color:#3c4854;line-height:1.5;margin-bottom:16px">${esc(i.preview)}${i.preview.length >= 220 ? "…" : ""}</div>` : ""}
<a href="${esc(i.link)}" style="display:inline-block;background:#106b55;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:12px 22px;border-radius:10px">Review and approve</a>
</td></tr></table></td></tr>`).join("")}
<tr><td style="padding:6px 4px;font-size:13px;color:#68737e;line-height:1.5">Nothing is sent or posted until you tap Approve on the page. Each link works for 3 days, for that item only.<br><a href="${esc(app)}/app" style="color:#106b55">Open your dashboard</a></td></tr>
</table></td></tr></table></body></html>`;
    try {
      await platformMail(to, subject, text, undefined, html);
      sent += items.length;
      try {
        await pushTo(await pushUsersFor(bid, "business"), { title: items.length === 1 ? "Needs your OK" : `${items.length} things need your OK`,
          body: items.map((i) => i.title).join(" · ").slice(0, 160), url: items.length === 1 ? items[0].link : `${app}/app`, tag: "ok" });
      } catch (e) { console.error("push", (e as Error).message); }
    } catch (e) {
      await sql`update os.alerts set sent_at = null, error = ${(e as Error).message.slice(0, 300)} where id = any(${ids}::bigint[])`;
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


// Notification emails from a business's own website form or a lead service ("New form submission", Wix, Angi...).
const FORM_SUBJECT = /(new (form |website |contact )?(submission|entry|message|inquiry|enquiry|lead|contact|request)|contact (us )?form|website (form|inquiry|enquiry|message|lead)|form (submission|entry)|quote request|estimate request|request (a|for a) (quote|estimate)|someone (filled|submitted|sent))/i;
const FORM_SENDER = /(wordpress|wix|squarespace|jotform|formspree|typeform|hubspot|godaddy|weebly|webflow|wpforms|gravity ?forms|elementor|ninja ?forms|contactform|formsubmit|netlify|thumbtack|angi|homeadvisor|yelp|nextdoor|houzz|porch|bark\.com|networx)/i;
function isFormEmail(from: string, subject: string) {
  return FORM_SUBJECT.test(subject) || (FORM_SENDER.test(from) && /(lead|request|message|quote|estimate|inquiry|enquiry|submission|contact)/i.test(subject));
}

/** A website-form or lead-service email becomes an inquiry: the owner hears right away and Kole drafts the reply. */
async function formToInquiry(bid: string, from: string, subject: string, text: string, mid: string) {
  const b = await business(bid);
  if (!b) return false;
  let d: any = null;
  const [down] = await sql`select os.ai_down() as d`;
  if (!down?.d) {
    try {
      const res = await claude(b, "coordination", { model: "claude-haiku-5-5", max_tokens: 800, messages: [{ role: "user", content:
        `This email reached a business's inbox. If it is a notification of a customer contacting the business (a website contact form, or a lead service like Angi or Thumbtack), return ONLY JSON: {"name": "", "email": "", "phone": "", "message": "what they need, in their words", "source": "e.g. website form, Angi"}. Copy contact details exactly; leave unknown fields empty. If it is anything else (newsletter, receipt, marketing, spam, a system notice), return {"not_a_lead": true}.\n\nFrom: ${from}\nSubject: ${subject}\n\n${text.slice(0, 6000)}` }] }, 30_000);
      const out = (res.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
      d = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    } catch { d = null; }
  }
  if (d?.not_a_lead) return false;
  const lead = d ?? { name: "", email: "", phone: "", message: `${subject}\n\n${text.slice(0, 1500)}`, source: "website form (unread)" };
  const email = String(lead.email ?? "").toLowerCase().trim(), phone = String(lead.phone ?? "").trim(), name = String(lead.name ?? "").trim() || email || phone || "Website visitor";
  const [r] = await sql`insert into os.records (business_id, type, status, title, data, created_by, next_step, next_step_due)
    values (${bid}, 'inquiry', 'new', ${name.slice(0, 100)}, ${sql.json({ name, ...(email ? { email } : {}), ...(phone ? { phone } : {}), message: String(lead.message ?? "").slice(0, 3000), source: lead.source || "website form (email)", email_subject: subject.slice(0, 200), received_at: new Date().toISOString() })},
      'inbox', 'answer today', current_date) returning id`;
  const contact = [email, phone].filter(Boolean).join(" · ");
  await sql`select os.alert(${bid}, 'business', 'inquiry', ${"New inquiry: " + name}, ${`${name}${contact ? ` (${contact})` : ""} wrote through ${lead.source || "your website form"}:\n\n${String(lead.message ?? "").slice(0, 1500)}\n\n${email ? "Kole is drafting a reply for your OK. " : ""}${phone ? `Fastest: call them now at ${phone}. ` : ""}The first business to answer usually wins the job.`}, ${"inqmail:" + mid})`;
  await post(bid, "system", email
    ? `@kole New inquiry #${r.id} from ${name} (${contact}) via ${lead.source || "the website form"}: "${String(lead.message ?? "").slice(0, 1500)}" Draft a short, friendly reply to ${email} now and queue it with request_approval (kind email, record_id ${r.id}). Answer only from our facts, and offer the next step. @demarcus make sure it's answered today.`
    : `@demarcus New inquiry #${r.id} from ${name}${phone ? `, phone only (${phone})` : ""} via ${lead.source || "the website form"}: "${String(lead.message ?? "").slice(0, 1500)}" Remind the owner to call them back today.`, { recordId: r.id });
  return true;
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
    // Gmail sometimes drops the connection without a clean goodbye; without a listener that error crashes the whole run.
    client.on("error", (e: Error) => console.error("imap", c.slug, e?.message));
    let handled = 0;
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = (await client.search({ since: new Date(Date.now() - 3 * 86400000) }, { uid: true })) || [];
        const wanted: { uid: number; mid: string; from: string; subject: string; form: boolean }[] = [];
        for await (const m of client.fetch(uids.slice(-80), { envelope: true }, { uid: true })) {
          const from = (m.envelope?.from?.[0]?.address ?? "").toLowerCase(), subject = m.envelope?.subject ?? "";
          const form = from !== owner && !byEmail.has(from) && isFormEmail(`${m.envelope?.from?.[0]?.name ?? ""} ${from}`, subject);
          if (from !== owner && !byEmail.has(from) && !form) continue;
          if (m.envelope?.date && new Date(m.envelope.date) < startAt) continue;
          wanted.push({ uid: m.uid, mid: m.envelope?.messageId || `uid-${m.uid}`, from, subject, form });
        }
        for (const w of wanted) {
          const [claimed] = await sql`insert into os.mail_seen (business_id, message_id) values (${c.business_id}, ${w.mid}) on conflict do nothing returning message_id`;
          if (!claimed) continue;
          const one = await client.fetchOne(String(w.uid), { source: true }, { uid: true });
          if (!one) continue;
          const parsed = await simpleParser(one.source);
          const text = stripQuoted(parsed.text ?? "") || (parsed.subject ?? "");
          if (w.form) {
            if (await formToInquiry(c.business_id, w.from, w.subject, parsed.text ?? text, w.mid)) handled++;
            continue;
          }
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

/** Seasonal emails to past customers, after the owner approved them: 40 per run, each person once, with an unsubscribe link. */
async function sendCampaigns() {
  const out: Record<string, string> = {};
  const camps = await sql`select a.* from os.approvals a join os.businesses b on b.id = a.business_id
    where a.kind = 'campaign' and a.status in ('approved', 'sending') and b.status <> 'archived' order by a.id limit 3`;
  for (const c of camps) {
    await sql`update os.approvals set status = 'sending' where id = ${c.id} and status = 'approved'`;
    const b = await business(c.business_id);
    if (!b) continue;
    const app = await appUrl();
    const todo = await sql`select distinct on (lower(r.data->>'email')) lower(r.data->>'email') as email, r.data->>'name' as name from os.records r
      where r.business_id = ${c.business_id} and r.type = 'customer' and coalesce(r.data->>'email', '') <> ''
        and not exists (select 1 from os.optouts o where o.business_id = r.business_id and o.email = lower(r.data->>'email'))
        and not exists (select 1 from os.campaign_sends s where s.approval_id = ${c.id} and s.email = lower(r.data->>'email'))
      order by lower(r.data->>'email') limit 40`;
    let ok = 0, bad = 0;
    for (const t of todo) {
      // Claim first: a cut-short batch never emails anyone twice.
      const [claimed] = await sql`insert into os.campaign_sends (approval_id, email) values (${c.id}, ${t.email}) on conflict do nothing returning email`;
      if (!claimed) continue;
      const first = String(t.name ?? "").split(" ")[0];
      const text = String(c.payload?.body ?? "").replace(/\{first_name\}|\{name\}/gi, first || "there")
        + `\n\n—\nYou're getting this because you're a customer of ${b.name}. Don't want these emails? Unsubscribe: ${await unsubLink(app, b.id, t.email)}`;
      try { await sendEmail(b, { to: t.email, subject: String(c.payload?.subject ?? b.name), text }); ok++; }
      catch (e) { bad++; await sql`update os.campaign_sends set error = ${(e as Error).message.slice(0, 300)} where approval_id = ${c.id} and email = ${t.email}`; }
    }
    if (todo.length < 40) {
      const [n] = await sql`select count(*) filter (where error is null)::int as sent, count(*) filter (where error is not null)::int as failed from os.campaign_sends where approval_id = ${c.id}`;
      await sql`update os.approvals set status = ${n.sent ? "done" : "failed"}, note = ${`Sent to ${n.sent} past customer${n.sent === 1 ? "" : "s"}${n.failed ? `; ${n.failed} didn't go through` : ""}.`} where id = ${c.id}`;
      await post(c.business_id, "system", `The seasonal email "${c.payload?.subject}" went to ${n.sent} past customer${n.sent === 1 ? "" : "s"}${n.failed ? ` (${n.failed} didn't go through)` : ""}.`, { status: "handled" });
    }
    out[c.id] = `${ok} sent${bad ? `, ${bad} failed` : ""}`;
  }
  return out;
}

/** While the AI service is marked down, try one tiny call; when it works, os.ai_back() restarts the teams. */
async function checkAi() {
  const [down] = await sql`select 1 from os.platform_state where key = 'ai_down'`;
  if (!down) return "up";
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return "down (no key)";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
  }).catch(() => null);
  if (!r?.ok) return `down (${r?.status ?? "no answer"})`;
  const [x] = await sql`select os.ai_back() as n`;
  return `back (${x.n} resent)`;
}

// A stray network error from a mail connection is logged, not fatal to the run.
addEventListener("unhandledrejection", (e) => { e.preventDefault(); console.error("unhandled", (e as PromiseRejectionEvent).reason?.message ?? e); });

Deno.serve(async (req) => {
  const key = await secret("OS_INVOKE_KEY");
  if (!key || (req.headers.get("authorization") ?? "") !== `Bearer ${key}`) return new Response("forbidden", { status: 403 });
  const out: Record<string, unknown> = {};
  try { out.ai = await checkAi(); } catch (e) { out.ai_error = (e as Error).message; }
  // Alerts, publishing and campaigns first: a slow or broken inbox connection must never hold them up.
  try { out.alerts = await sendAlerts(); } catch (e) { out.alerts_error = (e as Error).message; }
  try { out.published = await publishDue(); } catch (e) { out.publish_error = (e as Error).message; }
  try { out.campaigns = await sendCampaigns(); } catch (e) { out.campaign_error = (e as Error).message; }
  try { out.inbox = await watchInboxes(); } catch (e) { out.inbox_error = (e as Error).message; }
  try { out.described = await describePending(); } catch (e) { out.describe_error = (e as Error).message; }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
});
