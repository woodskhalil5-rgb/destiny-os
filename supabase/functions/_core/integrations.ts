// Integration adapters. Each business connects its own; credentials are read from the vault by name, never stored in rows.
import nodemailer from "npm:nodemailer@6";
import { Business, bizSecret, sql } from "./core.ts";

export async function integration(bid: string, provider: string) {
  const [i] = await sql`select * from os.integrations where business_id = ${bid} and provider = ${provider} and status = 'connected'`;
  return i ?? null;
}

// ---------- Email: Gmail (SMTP) or Resend ----------
export async function sendEmail(b: Business, msg: { to: string; subject: string; text: string; fromName?: string; replyTo?: string; from?: string }) {
  const resend = await integration(b.id, "resend");
  if (resend && msg.fromName !== "__owner__") {
    const key = await bizSecret(b, "RESEND_API_KEY");
    if (!key) throw new Error("Resend is connected but its key is missing from the vault.");
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: msg.from || resend.settings.from, to: [msg.to], subject: msg.subject, text: msg.text, reply_to: msg.replyTo ?? resend.settings.reply_to }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return String(j.id ?? "");
  }
  const gmail = await integration(b.id, "gmail");
  if (!gmail) throw new Error("No email integration is connected for this business.");
  const pass = await bizSecret(b, "GMAIL_APP_PASSWORD");
  if (!pass) throw new Error("Gmail is connected but its app password is missing from the vault.");
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: gmail.settings.user, pass: pass.replace(/\s+/g, "") } });
  const name = msg.fromName && msg.fromName !== "__owner__" ? msg.fromName : gmail.settings.from_name ?? b.name;
  const info = await t.sendMail({ from: `"${name}" <${gmail.settings.user}>`, to: msg.to, subject: msg.subject, text: msg.text, replyTo: msg.replyTo });
  return String(info.messageId ?? "");
}

// ---------- Business-specific tool packs ----------
// A business turns a pack on by listing it in config.tool_packs; the pack's tools are then offered to the agents it names.
type Pack = { tools: { def: Record<string, unknown>; agents: string[]; run: (b: Business, input: any) => Promise<string> }[] };

async function jhpGet(b: Business, path: string, keyName: string) {
  const key = await bizSecret(b, keyName);
  if (!key) throw new Error(`${keyName} is missing from the vault`);
  const r = await fetch(`https://jerseyhomepros.com/api/team/${path}`, { headers: { "x-jhp-team-key": key }, signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`JHP ${path} ${r.status}`);
  return j;
}
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
  .filter((w) => w && !["llc", "inc", "co", "company", "corp", "the", "and", "services", "service", "of", "nj", "ltd", "group"].includes(w)).join(" ");
const dom = (s: string) => String(s ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];

export const PACKS: Record<string, Pack> = {
  jhp: {
    tools: [
      {
        agents: ["research", "analysis", "production", "coordination"],
        def: { name: "check_jhp", description: "Is this company already a JHP member, applied, pre-listed (with profile link), or not on JHP? Run before saving or pitching any contractor.", input_schema: { type: "object", properties: { business: { type: "string" }, website: { type: "string" } }, required: ["business"] } },
        run: async (b, input) => {
          const list: any[] = (await jhpGet(b, "companies", "JHP_LOOKUP_KEY")).companies ?? [];
          const n = norm(input.business), d = input.website ? dom(input.website) : "";
          const hit = list.find((c) => d && c.website && dom(c.website) === d) ?? list.find((c) => norm(c.company) === n)
            ?? list.find((c) => { const m = norm(c.company); return n.length >= 6 && m.length >= 6 && (m.includes(n) || n.includes(m)); });
          if (!hit) return `not on JHP: no match for "${input.business}". Normal pitch.`;
          const s = String(hit.jhp_status);
          if (s.startsWith("member") || s.startsWith("applied")) return `already on JHP (${s}) as "${hit.company}". Skip them.`;
          return `pre-listed: "${hit.company}" has an unclaimed profile at ${hit.profile_url}. Pitch "claim your profile" with that link.`;
        },
      },
      {
        agents: ["research", "analysis", "production", "coordination", "distribution"],
        def: { name: "jhp_companies", description: "The full live list of companies on jerseyhomepros.com in one call: company, trade, city, website, profile link, license number and JHP status (member or pre-listed, meaning an unclaimed profile). Filter by status, trade or city. Each row says whether it's already in our pipeline (record id). Use this instead of check_jhp when you need the list, e.g. to work the pre-listed companies.", input_schema: { type: "object", properties: { status: { type: "string", enum: ["pre-listed", "member", "all"] }, trade: { type: "string" }, city: { type: "string" }, not_in_pipeline: { type: "boolean", description: "only companies we don't have a record for yet" } } } },
        run: async (b, input) => {
          const list: any[] = (await jhpGet(b, "companies", "JHP_LOOKUP_KEY")).companies ?? [];
          const recs = await sql`select id, title, status, data->>'website' as website from os.records where business_id = ${b.id} and type = 'contractor'`;
          const byKey = new Map<string, any>();
          for (const r of recs) { byKey.set(norm(r.title), r); if (r.website) byKey.set("d:" + dom(r.website), r); }
          const st = String(input.status ?? "all"), tr = String(input.trade ?? "").toLowerCase(), ct = String(input.city ?? "").toLowerCase();
          const rows = list.filter((c) => (st === "all" || String(c.jhp_status).startsWith(st)) && (!tr || String(c.trade).toLowerCase().includes(tr)) && (!ct || String(c.city).toLowerCase().includes(ct)))
            .map((c) => { const r = (c.website && byKey.get("d:" + dom(c.website))) || byKey.get(norm(c.company)); return { ...c, pipeline: r ? `#${r.id} (${r.status})` : null }; })
            .filter((c) => !input.not_in_pipeline || !c.pipeline);
          return JSON.stringify({ total: rows.length, companies: rows });
        },
      },
      {
        agents: ["coordination", "media"],
        def: { name: "jhp_stats", description: "Live JHP counts: homeowner requests, sign-ups, members, applied, pre-listed.", input_schema: { type: "object", properties: {} } },
        run: async (b) => JSON.stringify(await jhpGet(b, "stats", "JHP_STATS_KEY")),
      },
    ],
  },
};
