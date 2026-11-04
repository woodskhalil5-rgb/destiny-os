// Platform email (sign-in codes, invites, alerts) — not a business's own outreach.
// Uses Resend when the vault has OS_RESEND_API_KEY and OS_MAIL_FROM (e.g. "Destiny OS <no-reply@destinymarketinggroup.com>");
// otherwise falls back to the Gmail account in OS_MAIL_USER with the GMAIL_APP_PASSWORD function secret.
import { secret } from "./core.ts";

export async function platformMail(to: string, subject: string, text: string, replyTo?: string) {
  const [key, from] = await Promise.all([secret("OS_RESEND_API_KEY"), secret("OS_MAIL_FROM")]);
  if (key && from) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return "resend";
    const j = await r.json().catch(() => ({}));
    console.error("Resend failed, falling back to Gmail", r.status, JSON.stringify(j).slice(0, 200));
  }
  const user = await secret("OS_MAIL_USER");
  const pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) throw new Error("Platform email isn't set up (add OS_RESEND_API_KEY + OS_MAIL_FROM to the vault).");
  const nodemailer = (await import("npm:nodemailer@6")).default;
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass: pass.replace(/\s+/g, "") } });
  await t.sendMail({ from: `"Destiny OS" <${user}>`, to, subject, text, replyTo });
  return "gmail";
}

/** The dashboard's public address (vault OS_APP_URL). */
export async function appUrl() {
  return (await secret("OS_APP_URL")) ?? "the Destiny OS dashboard";
}
