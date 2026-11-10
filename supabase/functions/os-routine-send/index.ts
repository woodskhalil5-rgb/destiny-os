// os-routine-send: sends routine emails (quote follow-ups and review requests) that were approved automatically
// because the owner had already approved 5 of the same kind (see migration 0051). Called every 5 minutes by pg_cron.
// Sends through the business's own email connection exactly like an owner approval does (Resend first, then Gmail).
// Self-contained on purpose (no shared imports), so it can be deployed on its own.
import postgres from "npm:postgres@3.4.5";
import nodemailer from "npm:nodemailer@6";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20 });
const secret = async (name: string) =>
  ((await sql`select decrypted_secret as v from vault.decrypted_secrets where name = ${name}`)[0]?.v as string) ?? null;

async function send(b: any, to: string, subject: string, text: string) {
  const [resend] = await sql`select * from os.integrations where business_id = ${b.id} and provider = 'resend' and status = 'connected'`;
  if (resend) {
    const key = await secret(`${b.slug}:RESEND_API_KEY`);
    if (!key) throw new Error("Resend is connected but its key is missing from the vault.");
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: resend.settings.from, to: [to], subject, text, reply_to: resend.settings.reply_to }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  const [gmail] = await sql`select * from os.integrations where business_id = ${b.id} and provider = 'gmail' and status = 'connected'`;
  if (!gmail) throw new Error("No email integration is connected for this business.");
  const pass = await secret(`${b.slug}:GMAIL_APP_PASSWORD`);
  if (!pass) throw new Error("Gmail is connected but its app password is missing from the vault.");
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: gmail.settings.user, pass: pass.replace(/\s+/g, "") } });
  await t.sendMail({ from: `"${gmail.settings.from_name ?? b.name}" <${gmail.settings.user}>`, to, subject, text });
}

Deno.serve(async (req) => {
  const key = await secret("OS_INVOKE_KEY");
  if (!key || (req.headers.get("authorization") ?? "") !== `Bearer ${key}`) return new Response("forbidden", { status: 403 });
  // Claim the batch so two runs never send the same email.
  // (approvals have no "sending" status, so the claim is made on decided_by)
  const rows = await sql`update os.approvals set decided_by = 'auto:routine:sent' where id in (
      select id from os.approvals where status = 'approved' and decided_by = 'auto:routine' and kind = 'email' order by id limit 20 for update skip locked)
    returning *`;
  let sent = 0;
  for (const ap of rows) {
    try {
      const [b] = await sql`select * from os.businesses where id = ${ap.business_id} and status = 'live'`;
      if (!b) throw new Error("business isn't live");
      const p = ap.payload ?? {};
      if (!p.to || !p.subject || !p.body) throw new Error("missing to, subject or body");
      const [out] = await sql`select 1 from os.optouts where business_id = ${b.id} and email = ${String(p.to).toLowerCase()}`;
      if (out) { await sql`update os.approvals set status = 'rejected', note = 'Opted out before sending' where id = ${ap.id}`; continue; }
      await send(b, p.to, p.subject, p.body);
      await sql`update os.approvals set status = 'done' where id = ${ap.id}`;
      await sql`insert into os.activity_log (business_id, actor_type, actor, action, target, details)
        values (${b.id}, 'system', 'auto:routine', 'email_sent', ${p.to}, ${sql.json({ approval: ap.id, summary: ap.summary })})`;
      sent++;
    } catch (e) {
      await sql`update os.approvals set status = 'failed', note = ${"Automatic send failed: " + (e as Error).message.slice(0, 250)} where id = ${ap.id}`;
    }
  }
  return new Response(JSON.stringify({ sent, tried: rows.length }), { headers: { "content-type": "application/json" } });
});
