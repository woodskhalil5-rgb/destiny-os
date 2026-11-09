// os-team-mail: sends the team's own emails to the business's people (e.g. DeMarcus's daily brief to a sales rep),
// from the team address (team@destinymarketinggroup.com) through Resend. Called every 5 minutes by pg_cron.
// Reads os.person_mail rows that haven't been sent. Self-contained on purpose (no shared imports).
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20 });

Deno.serve(async (req) => {
  const [k] = await sql`select decrypted_secret as v from vault.decrypted_secrets where name = 'OS_INVOKE_KEY'`;
  if (!k?.v || (req.headers.get("authorization") ?? "") !== `Bearer ${k.v}`) return new Response("forbidden", { status: 403 });
  const key = Deno.env.get("OS_RESEND_API_KEY")?.trim();
  if (!key) return new Response("OS_RESEND_API_KEY missing", { status: 500 });
  // Anything older than a day is dropped rather than retried forever.
  await sql`update os.person_mail set sent_at = now(), error = coalesce(error, '') || ' (expired)' where sent_at is null and created_at < now() - interval '1 day'`;
  const rows = await sql`update os.person_mail set sent_at = now() where id in (
      select id from os.person_mail where sent_at is null order by id limit 20 for update skip locked) returning *`;
  let sent = 0;
  for (const m of rows) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from: m.from_addr, to: [m.to_addr], subject: m.subject, text: m.body, ...(m.reply_to ? { reply_to: m.reply_to } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
      sent++;
    } catch (e) {
      await sql`update os.person_mail set sent_at = null, error = ${(e as Error).message.slice(0, 300)}, attempts = attempts + 1 where id = ${m.id}`;
    }
  }
  return new Response(JSON.stringify({ sent, tried: rows.length }), { headers: { "content-type": "application/json" } });
});
