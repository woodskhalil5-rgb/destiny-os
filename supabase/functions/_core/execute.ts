// Carries out an approval once the owner (or a cleared teammate) has said yes. Shared by the dashboard, the agents
// and the one-tap approval page, so an approval does exactly the same thing wherever it's given.
import { Business, config, sql } from "./core.ts";
import { sendEmail } from "./integrations.ts";

export async function execute(b: Business, ap: any): Promise<string> {
  if (ap.kind === "email") {
    const p = ap.payload ?? {};
    if (!p.to || !p.subject || !p.body) throw new Error("email approval is missing to, subject or body");
    // The sender can depend on who it's to: config.email_from maps a record type to a From address
    // (e.g. JHP: homeowners see hello@, everyone else team@).
    const [rec] = ap.record_id ? await sql`select type from os.records where id = ${ap.record_id} and business_id = ${b.id}` : [];
    const from = rec ? (await config(b.id)).email_from?.[rec.type] : undefined;
    await sendEmail(b, { to: p.to, subject: p.subject, text: p.body, from });
    await sql`update os.approvals set status = 'done' where id = ${ap.id}`;
    // A payment reminder (Nora's): the invoice stays open as "reminded", counts the reminder and waits a week for the next one.
    if (ap.record_id && rec?.type === "invoice") await sql`update os.records set
        status = case when status in ('paid', 'written off') then status else 'reminded' end,
        data = jsonb_set(data, '{reminders}', to_jsonb(coalesce(case when coalesce(data->>'reminders', '') ~ '^[0-9]+$' then (data->>'reminders')::int end, 0) + 1)),
        next_step = case when coalesce(case when coalesce(data->>'reminders', '') ~ '^[0-9]+$' then (data->>'reminders')::int end, 0) + 1 >= 3 then 'three reminders sent: the owner should call' else 'next reminder if still unpaid' end,
        next_step_due = (now() + interval '7 days')::date, updated_at = now()
      where id = ${ap.record_id} and business_id = ${b.id}`;
    else if (ap.record_id) await sql`update os.records set status = 'contacted', next_step = 'wait for reply, follow up if none', next_step_due = (now() + interval '4 days')::date, updated_at = now() where id = ${ap.record_id} and business_id = ${b.id}`;
    return `email sent to ${p.to}`;
  }
  if (ap.kind === "campaign") return "approved; it goes out to your past customers within a few minutes";
  return "approved; nothing to carry out automatically for this kind";
}
