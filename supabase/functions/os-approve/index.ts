// os-approve: the one-tap approval page (/ok?t=...). Public, but every call needs a link token from an approval email:
// the token is for one item only, expires after 3 days, and only its hash is stored.
//  - view:   what the item is and exactly what will go out (photos included)
//  - decide: approve or send back, doing the same as the dashboard's buttons
import { audit, business, post, sql } from "../_core/core.ts";
import { execute } from "../_core/execute.ts";
import { mediaFor } from "../_core/storage.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function ownerEmail(bid: string) {
  const [c] = await sql`select config->'owner'->>'email' as e from os.business_config where business_id = ${bid} and active`;
  return (c?.e as string) || "owner";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const body = await req.json().catch(() => ({}));
  const token = String(body.t ?? "").replace(/[^a-f0-9]/gi, "");
  if (token.length < 32) return json({ error: "This link isn't complete. Open it again from the email." }, 400);
  const [link] = await sql`select l.*, b.name as biz, b.status as biz_status from os.approval_links l join os.businesses b on b.id = l.business_id
    where l.token_hash = ${await sha256(token)}`;
  if (!link) return json({ error: "This link doesn't work. Open the newest email, or review it in your dashboard." }, 404);
  if (new Date(link.expires_at) < new Date()) return json({ error: "This link has expired (they last 3 days). Review it in your dashboard instead.", expired: true }, 410);
  if (link.biz_status === "archived") return json({ error: "This business is no longer active." }, 410);
  const bid = link.business_id as string, id = Number(link.item_id);
  const names = Object.fromEntries((await sql`select slot, name from os.agents`).map((a: any) => [a.slot, a.name]));

  async function load() {
    if (link.item_kind === "approval") {
      const [ap] = await sql`select * from os.approvals where id = ${id} and business_id = ${bid}`;
      if (!ap) return null;
      return { kind: "approval", status: ap.status, type: ap.kind, title: ap.summary, from: names[ap.requested_by] ?? "Your team", note: ap.note,
        email: ap.kind === "email" ? { to: ap.payload?.to, subject: ap.payload?.subject, body: ap.payload?.body } : null,
        details: ap.kind === "email" ? null : ap.payload, row: ap };
    }
    const [c] = await sql`select * from os.content where id = ${id} and business_id = ${bid}`;
    if (!c) return null;
    const media = c.media_ids?.length ? (await mediaFor(bid, c.media_ids.map(Number), 3 * 3600)).map((m: any) => ({ kind: m.kind, tag: m.tag, url: m.url })) : [];
    return { kind: "content", status: c.status, type: c.kind, channel: c.channel ?? "Facebook", title: c.title, from: names[c.created_by] ?? "Your team", body: c.body, media, row: c };
  }

  const item = await load();
  if (!item) return json({ error: "This item was removed. There's nothing to approve." }, 404);
  const { row, ...shown } = item as any;

  if (body.action === "view") return json({ business: link.biz, item: shown });

  if (body.action === "decide") {
    const approve = body.decision === "approve";
    if (!approve && body.decision !== "reject") return json({ error: "Unknown choice." }, 400);
    if (item.status !== "pending" && !(item.kind === "approval" && item.status === "failed")) return json({ error: `This was already ${item.status === "done" ? "sent" : item.status}.`, item: shown }, 409);
    const note = body.note ? String(body.note).trim().slice(0, 1000) || null : null;
    const who = await ownerEmail(bid);
    await sql`update os.approval_links set used_at = now() where token_hash = ${link.token_hash}`;

    if (item.kind === "approval") {
      const ap = row;
      await audit(bid, "user", who, `approval:${approve ? "approve" : "reject"}`, String(ap.id), { note, via: "email link" });
      if (!approve) {
        await sql`update os.approvals set status = 'rejected', decided_by = 'owner:email-link', decided_at = now(), note = ${note} where id = ${ap.id} and status in ('pending','failed')`;
        await post(bid, "system", `The owner sent back approval #${ap.id} (${ap.summary}).${note ? " Why: " + note : ""} @demarcus learn from it; @${(await sql`select handle from os.agents where slot = ${ap.requested_by}`)[0]?.handle ?? "demarcus"} redo it if it's worth saving.`);
        return json({ ok: true, result: "Sent back to the team." });
      }
      const [claimed] = await sql`update os.approvals set status = 'approved', decided_by = 'owner:email-link', decided_at = now(), note = ${note} where id = ${ap.id} and status in ('pending','failed') returning id`;
      if (!claimed) return json({ error: "This was just decided somewhere else." }, 409);
      const b = await business(bid);
      try {
        const result = await execute(b as any, ap);
        await post(bid, "system", `The owner approved #${ap.id} from the email link: ${result}.${note ? " " + note + " @demarcus take note." : ""}`, { status: note ? "queued" : "handled" });
        return json({ ok: true, result: result.replace(/^email sent to/, "Sent to") });
      } catch (e) {
        await sql`update os.approvals set status = 'failed', note = ${(e as Error).message} where id = ${ap.id}`;
        return json({ error: `Approved, but it couldn't be sent: ${(e as Error).message}. Open your dashboard to fix it.` }, 502);
      }
    }

    const c = row;
    const [done] = await sql`update os.content set status = ${approve ? "approved" : "rejected"}, note = ${note} where id = ${c.id} and status = 'pending' returning id`;
    if (!done) return json({ error: "This was just decided somewhere else." }, 409);
    await audit(bid, "user", who, `content:${approve ? "approve" : "reject"}`, String(c.id), { note, via: "email link" });
    await post(bid, "system", approve ? `The owner approved content #${c.id} from the email link.${note ? " " + note : ""} @grayson schedule it.`
      : `The owner sent back content #${c.id}.${note ? " Why: " + note : ""} @grayson redo it if it's worth saving.`);
    return json({ ok: true, result: approve ? "Approved. Grayson will schedule it." : "Sent back to the team." });
  }

  return json({ error: "Unknown action." }, 400);
});
