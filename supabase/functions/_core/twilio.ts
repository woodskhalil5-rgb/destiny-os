// Twilio (calling). The platform's Twilio credentials live in the vault as OS_TWILIO_* (saved from the dashboard by
// the platform owner); every business gets its own number under that account. Nothing here returns a secret.
import { sql } from "./core.ts";

export type TwilioCreds = { ACCOUNT_SID: string; AUTH_TOKEN: string; API_KEY_SID: string; API_KEY_SECRET: string; APP_SID?: string };

export async function twilioCreds(): Promise<TwilioCreds | null> {
  const rows = await sql`select name, decrypted_secret as v from vault.decrypted_secrets where name like 'OS_TWILIO_%'`;
  const c: Record<string, string> = Object.fromEntries(rows.map((r: any) => [String(r.name).replace("OS_TWILIO_", ""), String(r.v)]));
  return c.ACCOUNT_SID && c.AUTH_TOKEN && c.API_KEY_SID && c.API_KEY_SECRET ? (c as TwilioCreds) : null;
}

/** Twilio REST call (form-encoded). path is relative to /2010-04-01/Accounts/{sid}/ unless it starts with "/". */
export async function twilio(c: TwilioCreds, method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string> = {}) {
  const base = path.startsWith("/") ? `https://api.twilio.com${path}` : `https://api.twilio.com/2010-04-01/Accounts/${c.ACCOUNT_SID}/${path}`;
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(method === "POST" ? base : `${base}${qs ? (base.includes("?") ? "&" : "?") + qs : ""}`, {
    method,
    headers: { Authorization: "Basic " + btoa(`${c.ACCOUNT_SID}:${c.AUTH_TOKEN}`), "content-type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? qs : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (method === "DELETE") { if (!r.ok && r.status !== 404) throw new Error(`Twilio ${r.status}`); return {}; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Twilio: ${j.message ?? r.status}`);
  return j;
}

const b64url = (b: Uint8Array | string) => {
  const s = typeof b === "string" ? btoa(unescape(encodeURIComponent(b))) : btoa(String.fromCharCode(...b));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A one-hour Twilio Voice access token for the browser. */
export async function voiceToken(c: TwilioCreds, identity: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" }));
  const body = b64url(JSON.stringify({
    jti: `${c.API_KEY_SID}-${now}`, iss: c.API_KEY_SID, sub: c.ACCOUNT_SID, iat: now, exp: now + 3600,
    grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: c.APP_SID } } },
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(c.API_KEY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Checks a webhook really came from Twilio (X-Twilio-Signature over the public URL plus sorted POST params). */
export async function twilioSigOk(authToken: string, publicUrl: string, params: Record<string, string>, header: string | null) {
  if (!header) return false;
  const data = publicUrl + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  const expect = btoa(String.fromCharCode(...mac));
  return expect.length === header.length && [...expect].reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ header.charCodeAt(i)), 0) === 0;
}

/** US/Canada numbers to +1XXXXXXXXXX; anything else that already starts with + is kept; otherwise null. */
export function e164(raw: unknown) {
  const s = String(raw ?? "").trim();
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  if (s.startsWith("+") && d.length >= 8 && d.length <= 15) return "+" + d;
  return null;
}

/** Browser identity for one person in one business ("u<user>b<business>", no dashes). */
export const identityFor = (uid: string, bid: string) => `u${uid.replace(/-/g, "")}b${bid.replace(/-/g, "")}`;
export function parseIdentity(id: string) {
  const m = /^(?:client:)?u([0-9a-f]{32})b([0-9a-f]{32})$/.exec(id ?? "");
  if (!m) return null;
  const uuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return { uid: uuid(m[1]), bid: uuid(m[2]) };
}

/** Prices a finished call: Twilio's cost, and what the business pays (cost plus its per-minute fee). */
export async function priceCall(callId: number, durationSec: number) {
  const [c] = await sql`select c.direction, c.recorded, b.call_fee_per_min from os.calls c join os.businesses b on b.id = c.business_id where c.id = ${callId}`;
  if (!c) return;
  const [r] = await sql`select * from os.call_rates where id = 1`;
  const minutes = durationSec > 0 ? Math.ceil(durationSec / 60) : 0;
  const perMin = Number(c.direction === "outbound" ? r.outbound_per_min : r.inbound_per_min) + Number(r.browser_per_min) + (c.recorded ? Number(r.record_per_min) : 0);
  const cost = Math.round(minutes * perMin * 1e6) / 1e6;
  const billed = Math.round((cost + minutes * Number(c.call_fee_per_min)) * 1e6) / 1e6;
  await sql`update os.calls set duration_sec = ${durationSec}, minutes = ${minutes}, cost_usd = ${cost}, billed_usd = ${billed}, ended_at = coalesce(ended_at, now()) where id = ${callId}`;
}

/** Who can call for a business: platform admins and members with the caller role or above. */
export async function canCall(uid: string, bid: string) {
  const [a] = await sql`select 1 from os.platform_admins where user_id = ${uid}`;
  if (a) return true;
  const [m] = await sql`select role from os.business_members where user_id = ${uid} and business_id = ${bid}`;
  return !!m && ["owner", "admin", "operator", "caller"].includes(m.role);
}

/** Finds the record whose phone matches a number (last 10 digits). */
export async function recordForPhone(bid: string, phone: string) {
  const last10 = phone.replace(/\D/g, "").slice(-10);
  if (last10.length < 10) return null;
  const [r] = await sql`select id, title from os.records where business_id = ${bid}
    and right(regexp_replace(coalesce(data->>'phone', ''), '\\D', '', 'g'), 10) = ${last10} order by updated_at desc limit 1`;
  return r ?? null;
}
