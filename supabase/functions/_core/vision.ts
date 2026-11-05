// Looks at a library item's previews once and writes down what's actually in it, so the team can search and choose
// by what a photo shows, not just by its labels. Billed to the business like any other model call.
import { business, claude, sql } from "./core.ts";
import { previewBlocks } from "./storage.ts";

const VISION_MODEL = "claude-haiku-5-5";

export async function describeMedia(bid: string, id: number) {
  const [m] = await sql`select id, kind, tag, contractor, trade, job, notes, frames from os.media where id = ${id} and business_id = ${bid} and status = 'ready'`;
  if (!m?.frames?.length) return;
  const b = await business(bid);
  if (!b) return;
  const labels = [m.tag, m.trade, m.contractor, m.job].filter(Boolean).join(", ");
  await sql`update os.media set describe_tries = describe_tries + 1 where id = ${id}`;
  const res = await claude(b, "media", {
    model: VISION_MODEL, max_tokens: 1024,
    messages: [{ role: "user", content: [
      ...(await previewBlocks(m.frames.slice(0, 6))),
      { type: "text", text: `${m.kind === "video" ? "These are frames from one video, in order." : "This is one photo."} A home-services business uploaded it for its marketing${labels ? ` (labelled: ${labels})` : ""}.
In 2 to 4 plain sentences, say what is actually visible: the subject and its condition (for example worn or damaged versus finished work), the setting, any readable text or logos, whether people's faces show, and whether it is clear enough to post. Only what you can see; no guesses, no marketing language.` },
    ] }],
  }, 60_000);
  const text = (res.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ").trim().slice(0, 1200);
  if (!text) throw new Error(`no description (stop: ${res.stop_reason}; blocks: ${(res.content ?? []).map((x: any) => x.type).join(",")})`);
  await sql`update os.media set ai_notes = ${text} where id = ${id} and business_id = ${bid}`;
}

/** Background pass (os-jobs): describe anything that has previews but no description yet. */
export async function describePending() {
  const rows = await sql`select id, business_id from os.media where status = 'ready' and ai_notes is null and cardinality(frames) > 0
    and describe_tries < 3 and created_at < now() - interval '1 minute' order by id limit 4`;
  const out: Record<string, string> = {};
  for (const r of rows) {
    try { await describeMedia(r.business_id, Number(r.id)); out[r.id] = "ok"; } catch (e) { out[r.id] = (e as Error).message.slice(0, 200); }
  }
  return out;
}
