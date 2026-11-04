// Stripe over its REST API. The secret key is an Edge Function secret (STRIPE_SECRET_KEY), never stored in tables.
import { sql } from "./core.ts";

function form(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === "object" ? form(x as any, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x)));
    else if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

/** The platform's Stripe key: the secret named "OS KEY" (the owner's live key) if set, else STRIPE_SECRET_KEY. */
export function stripeKey() {
  const env = Deno.env.toObject() as Record<string, string>;
  const os = Object.entries(env).find(([k]) => k.trim().toUpperCase().replace(/[\s-]+/g, "_") === "OS_KEY")?.[1]?.trim();
  return os || env.STRIPE_SECRET_KEY?.trim() || null;
}

export async function stripe(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, idempotencyKey?: string) {
  const key = stripeKey();
  if (!key) throw new Error("Stripe isn't connected yet: add the key as OS KEY (or STRIPE_SECRET_KEY) in the Edge Function secrets.");
  const body = form(params).toString();
  const r = await fetch(`https://api.stripe.com/v1/${path}${method === "GET" && body ? "?" + body : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" ? body : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Stripe: ${j.error?.message ?? r.status}`), { status: r.status, code: j.error?.code });
  return j;
}

/** The business's Stripe customer, created the first time it's needed. */
export async function ensureCustomer(bid: string, email: string) {
  const [b] = await sql`select id, name, stripe_customer_id from os.businesses where id = ${bid}`;
  if (b.stripe_customer_id) return b.stripe_customer_id as string;
  const c = await stripe("POST", "customers", { name: b.name, email, metadata: { business_id: bid } }, `cust-${bid}`);
  await sql`update os.businesses set stripe_customer_id = ${c.id}, billing_status = case when billing_status = 'none' then 'card_needed' else billing_status end where id = ${bid}`;
  return c.id as string;
}

/** Checks a webhook's Stripe-Signature header (5-minute tolerance). */
export async function verifyWebhook(raw: string, header: string | null) {
  // The endpoint's signing secret: set by os-billing's setup_webhook (vault), or by hand as an Edge Function secret.
  const rows = await sql`select decrypted_secret as s from vault.decrypted_secrets where name in ('OS_STRIPE_WEBHOOK_SECRET_test', 'OS_STRIPE_WEBHOOK_SECRET_live')`;
  const secrets = [Deno.env.get("STRIPE_WEBHOOK_SECRET"), ...rows.map((r: any) => r.s as string)].filter(Boolean) as string[];
  for (const secret of secrets) if (await checkSig(raw, header, secret)) return true;
  return false;
}

async function checkSig(raw: string, header: string | null, secret: string) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]).filter((p) => p[0] === "t"));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300 || !sigs.length) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = Array.from(mac).map((x) => x.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

/** Which Stripe account and mode the configured key belongs to. Never returns the key. */
export async function stripeAccount() {
  const key = stripeKey() ?? "";
  const a = await stripe("GET", "account");
  const bal = await stripe("GET", "balance"); // Stripe says itself whether this key is live
  return { id: a.id as string, name: (a.settings?.dashboard?.display_name ?? a.business_profile?.name ?? "") as string,
    mode: bal.livemode ? "live" : "test", key_type: key.slice(0, key.indexOf("_", 3) + 1) || "?",
    charges_enabled: !!a.charges_enabled,
    // Names (never values) of every Edge Function secret that holds a Stripe key, with its key type.
    stripe_secrets: Object.entries(Deno.env.toObject() as Record<string, string>).filter(([, v]) => /^(sk|rk)_(live|test)_/.test(v))
      .map(([k, v]) => `${k}: ${v.slice(0, v.indexOf("_", 3) + 1)}`) };
}
