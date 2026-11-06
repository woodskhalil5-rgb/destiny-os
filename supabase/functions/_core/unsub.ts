// Signed unsubscribe links for emails to a business's own customers: /unsub?b=<business>&e=<email>&t=<token>.
// The token proves the link came from us, so nobody can unsubscribe someone else.
import { secret } from "./core.ts";

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function unsubToken(bid: string, email: string) {
  return (await sha256(`${bid}|${email.toLowerCase()}|${await secret("OS_INVOKE_KEY")}`)).slice(0, 32);
}

export async function unsubLink(app: string, bid: string, email: string) {
  return `${app}/unsub?b=${encodeURIComponent(bid)}&e=${encodeURIComponent(email.toLowerCase())}&t=${await unsubToken(bid, email)}`;
}
