// Phone notifications (Web Push, RFC 8291 + RFC 8292), done with the platform's own crypto: no outside service, no fees.
// The signing keys are created once and kept in the vault (OS_VAPID_PUBLIC / OS_VAPID_PRIVATE); only the public key
// ever leaves the server. Each person's devices are rows in os.push_subs.
import { secret, sql } from "./core.ts";

type B = Uint8Array<ArrayBuffer>;
const te = new TextEncoder();
const b64u = (b: B) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string): B => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const cat = (...a: B[]): B => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

/** The public key browsers need to subscribe; creates the key pair the first time. */
export async function vapidPublic() {
  const pub = await secret("OS_VAPID_PUBLIC");
  if (pub) return pub;
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey));
  // Two requests at once must not create two different key pairs: only the first insert wins.
  await sql`select vault.create_secret(${jwk}, 'OS_VAPID_PRIVATE') where not exists (select 1 from vault.secrets where name = 'OS_VAPID_PRIVATE')`;
  await sql`select vault.create_secret(${raw}, 'OS_VAPID_PUBLIC') where not exists (select 1 from vault.secrets where name = 'OS_VAPID_PUBLIC')`;
  return (await secret("OS_VAPID_PUBLIC"))!;
}

async function vapidHeader(endpoint: string) {
  const pub = await vapidPublic();
  const jwk = JSON.parse((await secret("OS_VAPID_PRIVATE"))!);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: (await secret("OS_APP_URL")) ?? "https://app.destinymarketinggroup.com" })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pub}`;
}

async function hkdf(salt: B, ikm: B, info: B, bytes: number): Promise<B> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

/** Encrypts one message for one device (aes128gcm) and sends it. Returns the push service's status code. */
export async function sendPush(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: unknown) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = cat(te.encode(JSON.stringify(payload)), new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  const body = cat(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);
  const r = await fetch(sub.endpoint, {
    method: "POST", body, signal: AbortSignal.timeout(15_000),
    headers: { Authorization: await vapidHeader(sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" },
  });
  return r.status;
}

/** Sends a notification to every device these people turned notifications on for. Dead devices are removed. */
export async function pushTo(userIds: string[], msg: { title: string; body: string; url?: string; tag?: string }) {
  if (!userIds.length) return 0;
  const subs = await sql`select id, endpoint, keys from os.push_subs where user_id = any(${sql.array(userIds)}::uuid[])`;
  let ok = 0;
  for (const s of subs) {
    try {
      const status = await sendPush({ endpoint: s.endpoint, keys: s.keys }, msg);
      if (status >= 200 && status < 300) { ok++; await sql`update os.push_subs set last_ok = now(), fails = 0 where id = ${s.id}`; }
      else if (status === 404 || status === 410) await sql`delete from os.push_subs where id = ${s.id}`;
      else await sql`update os.push_subs set fails = fails + 1 where id = ${s.id}`;
    } catch { await sql`update os.push_subs set fails = fails + 1 where id = ${s.id}`; }
  }
  await sql`delete from os.push_subs where fails >= 10`;
  return ok;
}

/** Who gets a business's notifications: its owners and admins (and, for platform alerts, the platform owners). */
export async function pushUsersFor(bid: string | null, audience: string) {
  const rows = audience === "platform" || !bid
    ? await sql`select user_id from os.platform_admins`
    : await sql`select user_id from os.business_members where business_id = ${bid} and role in ('owner', 'admin')`;
  return rows.map((r: any) => String(r.user_id));
}
