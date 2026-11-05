// The shared tool set. Every tool runs inside one business; ids from another business are never found.
import { audit, Business, BizAgent, config, post, sql } from "./core.ts";
import { PACKS, sendEmail } from "./integrations.ts";
import { e164 } from "./twilio.ts";
import { previewBlocks } from "./storage.ts";
import { execute } from "./execute.ts";
export { execute };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const S = { type: "string" }, I = { type: "integer" };

export const TOOL_DEFS: Record<string, Record<string, unknown>> = {
  web_search: { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  recall: { name: "recall", description: "Look up what the team already learned (research notes) before searching the web. Search by words in the subject or note; leave query empty for the latest notes.",
    input_schema: obj({ query: S }) },
  save_note: { name: "save_note", description: "Save something you learned so nobody pays to look it up again: a short subject (e.g. 'Montclair roofers' or 'NJ HIC license lookup'), the finding in a few lines, and source URLs.",
    input_schema: obj({ subject: S, note: S, sources: { type: "array", items: S } }, ["subject", "note"]) },
  write_notebook: { name: "write_notebook", description: "Write today's team notebook entry: what got done, what's in progress, what's blocked, and the plan for tomorrow. Under 200 words. Tomorrow's shift starts by reading it.",
    input_schema: obj({ body: S }, ["body"]) },
  save_record: { name: "save_record", description: "Create a record (omit id) or update one (give id). type must be one of the business's record types. Only include what you actually know; put details in data.",
    input_schema: obj({ id: I, type: S, status: S, title: S, data: { type: "object" }, next_step: S, next_step_due: { type: "string", description: "YYYY-MM-DD" } }) },
  find_records: { name: "find_records", description: "Search this business's records by type, status and/or words in the title.", input_schema: obj({ type: S, status: S, query: S }) },
  get_record: { name: "get_record", description: "Read one record in full.", input_schema: obj({ id: I }, ["id"]) },
  create_task: { name: "create_task", description: "Create a task and assign it to a teammate by handle (james, emily, kole, demarcus, grayson, benjamin).", input_schema: obj({ title: S, detail: S, assignee: S, due_at: S, record_id: I }, ["title", "assignee"]) },
  update_task: { name: "update_task", description: "Update a task's status (open, in_progress, blocked, done, cancelled) or detail.", input_schema: obj({ id: I, status: S, detail: S }, ["id"]) },
  list_tasks: { name: "list_tasks", description: "List open tasks for the business, optionally for one assignee.", input_schema: obj({ assignee: S }) },
  request_approval: { name: "request_approval", description: "Queue anything consequential (an email, offer, spend, publish) for approval. Nothing happens until it is approved. For email, payload = {to, subject, body}.",
    input_schema: obj({ kind: { type: "string", enum: ["email", "offer", "spend", "publish", "other"] }, summary: S, record_id: I, payload: { type: "object" } }, ["kind", "summary", "payload"]) },
  review_approval: { name: "review_approval", description: "Decide a pending approval you are cleared for: approve (it is carried out), reject (with a note for the teammate), or escalate (leave for the owner).",
    input_schema: obj({ id: I, decision: { type: "string", enum: ["approve", "reject", "escalate"] }, note: S }, ["id", "decision"]) },
  update_guide: { name: "update_guide", description: "Replace one of your learned guides (e.g. kind 'email' = what the owner approves). Keep it as short rules, under 250 words, everything still true.", input_schema: obj({ kind: S, body: S }, ["kind", "body"]) },
  report_to_owner: { name: "report_to_owner", description: "Send the owner a report or a decision only they can make. Use sparingly: end-of-day report, a reply from a prospect, urgent decisions.", input_schema: obj({ subject: S, body: S }, ["subject", "body"]) },
  save_content: { name: "save_content", description: "Save a piece of content (post, ad, reel, video script, graphic brief, page) for approval. To post photos or a video from the media library, give their ids in media_ids (find them with find_media): up to 10 photos, or exactly one video. kind 'reel' = one vertical video posted as a Facebook Reel; body is its caption.",
    input_schema: obj({ kind: { type: "string", enum: ["post", "ad", "reel", "video_script", "graphic_brief", "page", "email", "other"] }, channel: S, audience: S, title: S, body: S, media_ids: { type: "array", items: I } }, ["kind", "body"]) },
  find_media: { name: "find_media", description: "Look through the business's media library: photos (e.g. contractors' before and after shots), videos (finished reels) and music the owner uploaded. Filter by tag (before, after, job, reel, music, brand, other), kind (photo, video, audio), or words in the labels or in 'seen' (a description of what is actually in the picture). Only files the owner cleared for public use are listed. Use view_media to look at the ones you're considering.",
    input_schema: obj({ tag: S, kind: S, query: S }) },
  view_media: { name: "view_media", description: "Look at up to 4 library items yourself: a photo's preview, or frames from a video in order. Do this before you write a post around a photo, so the words match what it actually shows.",
    input_schema: obj({ ids: { type: "array", items: I } }, ["ids"]) },
  queue_call: { name: "queue_call", description: "Put someone on the call list for the business's caller (a person makes the calls). Give the record id (its data.phone is used) or a phone number, and say why to call and what to cover. Only for people the business rules allow calling.",
    input_schema: obj({ record_id: I, phone: S, reason: S }, ["reason"]) },
  schedule_content: { name: "schedule_content", description: "Schedule APPROVED content for publishing (ISO date-time).", input_schema: obj({ id: I, when: S }, ["id", "when"]) },
};

export function toolsFor(a: BizAgent, cfg: Record<string, any>) {
  const names = a.tools ?? a.default_tools;
  const defs = names.filter((n) => TOOL_DEFS[n]).map((n) => TOOL_DEFS[n]);
  for (const pack of cfg.tool_packs ?? []) for (const t of PACKS[pack]?.tools ?? []) if (t.agents.includes(a.slot)) defs.push(t.def);
  return defs;
}

/** How many decisions the owner has made on approvals of this kind: agents earn the right to approve after N. */
async function ownerDecisions(bid: string, kind: string) {
  const [r] = await sql`select count(*)::int as n from os.approvals where business_id = ${bid} and kind = ${kind} and decided_by like 'user:%' and status in ('approved','done','rejected')`;
  return r.n as number;
}

/** Carry out an approved action. Returns what happened. */
export async function runTool(b: Business, cfg: Record<string, any>, a: BizAgent, name: string, input: any, ctx: { recordId?: number; saved: number; depth: number }): Promise<string | any[]> {
  const allowed = (a.tools ?? a.default_tools).includes(name) || (cfg.tool_packs ?? []).some((p: string) => PACKS[p]?.tools.some((t) => (t.def as any).name === name && t.agents.includes(a.slot)));
  if (!allowed) return `error: ${name} isn't one of your tools`;
  await audit(b.id, "agent", a.slot, `tool:${name}`, input?.id ? String(input.id) : null, input);

  for (const pack of cfg.tool_packs ?? []) {
    const t = PACKS[pack]?.tools.find((t) => (t.def as any).name === name);
    if (t) { try { return await t.run(b, input); } catch (e) { return `${name} failed: ${(e as Error).message}. Hold this and say so.`; } }
  }

  switch (name) {
    case "save_record": {
      const types: string[] = Object.keys(cfg.record_types ?? {});
      const { id, data, ...f } = input ?? {};
      if (id) {
        const [r] = await sql`update os.records set
          type = coalesce(${f.type ?? null}, type), status = coalesce(${f.status ?? null}, status), title = coalesce(${f.title ?? null}, title),
          data = data || ${sql.json(data ?? {})}, next_step = coalesce(${f.next_step ?? null}, next_step),
          next_step_due = coalesce(${f.next_step_due ?? null}::date, next_step_due), updated_at = now()
          where id = ${id} and business_id = ${b.id} returning id, title, status`;
        if (!r) return "not found";
        ctx.recordId = r.id; ctx.saved++;
        return `updated #${r.id} ${r.title} (${r.status})`;
      }
      if (!f.type || !f.title) return "error: type and title are required for a new record";
      if (types.length && !types.includes(f.type)) return `error: type must be one of ${types.join(", ")}`;
      const [dup] = await sql`select id, title from os.records where business_id = ${b.id} and type = ${f.type} and lower(title) = lower(${f.title})`;
      if (dup) return `duplicate: already tracked as #${dup.id} ${dup.title}`;
      const status = f.status ?? cfg.record_types?.[f.type]?.stages?.[0] ?? "new";
      const [r] = await sql`insert into os.records (business_id, type, status, title, data, owner_slot, next_step, next_step_due, created_by)
        values (${b.id}, ${f.type}, ${status}, ${f.title}, ${sql.json(data ?? {})}, ${a.slot}, ${f.next_step ?? null}, ${f.next_step_due ?? null}, ${a.slot}) returning id`;
      ctx.recordId = r.id; ctx.saved++;
      return `created #${r.id} ${f.title}`;
    }
    case "find_records": {
      const rows = await sql`select id, type, status, title, next_step, next_step_due, updated_at::date as updated from os.records
        where business_id = ${b.id} ${input.type ? sql`and type = ${input.type}` : sql``} ${input.status ? sql`and status = ${input.status}` : sql``}
        ${input.query ? sql`and title ilike ${"%" + input.query + "%"}` : sql``} order by updated_at desc limit 30`;
      return rows.length ? JSON.stringify(rows) : "no matching records";
    }
    case "get_record": {
      const [r] = await sql`select * from os.records where id = ${input.id} and business_id = ${b.id}`;
      return r ? JSON.stringify(r) : "not found";
    }
    case "create_task": {
      const [ag] = await sql`select slot from os.agents where handle = ${String(input.assignee ?? "").replace("@", "").toLowerCase()}`;
      if (!ag) return "error: unknown assignee";
      const [t] = await sql`insert into os.tasks (business_id, title, detail, assignee_slot, created_by, due_at, record_id)
        values (${b.id}, ${input.title}, ${input.detail ?? null}, ${ag.slot}, ${a.slot}, ${input.due_at ?? null}, ${input.record_id ?? null}) returning id`;
      return `task #${t.id} created for ${input.assignee}. @mention them in your reply if they should start now.`;
    }
    case "update_task": {
      const [t] = await sql`update os.tasks set status = coalesce(${input.status ?? null}, status), detail = coalesce(${input.detail ?? null}, detail), updated_at = now()
        where id = ${input.id} and business_id = ${b.id} returning id, status`;
      return t ? `task #${t.id} is ${t.status}` : "not found";
    }
    case "list_tasks": {
      const rows = await sql`select t.id, t.title, a.name as assignee, t.status, t.due_at from os.tasks t left join os.agents a on a.slot = t.assignee_slot
        where t.business_id = ${b.id} and t.status in ('open','in_progress','blocked') ${input.assignee ? sql`and a.handle = ${String(input.assignee).replace("@", "").toLowerCase()}` : sql``} order by t.id limit 40`;
      return rows.length ? JSON.stringify(rows) : "no open tasks";
    }
    case "request_approval": {
      const [r] = await sql`insert into os.approvals (business_id, kind, record_id, summary, payload, original_payload, requested_by)
        values (${b.id}, ${input.kind}, ${input.record_id ?? null}, ${input.summary}, ${sql.json(input.payload)}, ${sql.json(input.payload)}, ${a.slot}) returning id`;
      const rule = cfg.approvals?.[input.kind];
      const cleared = rule?.agent_can_approve_after != null && (await ownerDecisions(b.id, input.kind)) >= rule.agent_can_approve_after;
      return `queued as approval #${r.id}; ${cleared ? "DeMarcus reviews it" : "the owner reviews it"}. Nothing is sent until it's approved.`;
    }
    case "review_approval": {
      const [ap] = await sql`select * from os.approvals where id = ${input.id} and business_id = ${b.id}`;
      if (!ap) return "not found";
      if (ap.status !== "pending") return `already ${ap.status}`;
      if (input.decision === "escalate") { await sql`update os.approvals set note = ${"DeMarcus: " + (input.note ?? "needs the owner")} where id = ${ap.id}`; return "left for the owner"; }
      const rule = cfg.approvals?.[ap.kind];
      const done = await ownerDecisions(b.id, ap.kind);
      if (rule?.agent_can_approve_after == null || done < rule.agent_can_approve_after) return `not cleared for ${ap.kind} approvals yet (owner has decided ${done}${rule?.agent_can_approve_after != null ? ` of ${rule.agent_can_approve_after}` : ""}). Leave it for the owner.`;
      if (rule.daily_limit) {
        const [c] = await sql`select count(*)::int as n from os.approvals where business_id = ${b.id} and kind = ${ap.kind} and status = 'done' and decided_at > now() - interval '24 hours'`;
        if (c.n >= rule.daily_limit) return `daily limit for ${ap.kind} (${rule.daily_limit}) reached; it waits until tomorrow.`;
      }
      if (input.decision === "reject") {
        await sql`update os.approvals set status = 'rejected', decided_by = ${a.slot}, decided_at = now(), note = ${input.note ?? null} where id = ${ap.id}`;
        return "rejected. Tell the teammate what to fix.";
      }
      await sql`update os.approvals set status = 'approved', decided_by = ${a.slot}, decided_at = now(), note = ${input.note ?? null} where id = ${ap.id}`;
      try { return await execute(b, ap); } catch (e) { await sql`update os.approvals set status = 'failed', note = ${(e as Error).message} where id = ${ap.id}`; return `approved but failed: ${(e as Error).message}`; }
    }
    case "update_guide": {
      await sql`insert into os.agent_guides (business_id, slot, kind, body) values (${b.id}, ${a.slot}, ${input.kind}, ${String(input.body).slice(0, 3000)})
        on conflict (business_id, slot, kind) do update set body = excluded.body, version = os.agent_guides.version + 1, updated_at = now()`;
      return "guide saved";
    }
    case "report_to_owner": {
      await post(b.id, "system", `${a.name} reported to the owner: "${input.subject}"\n\n${input.body}`, { status: "handled" });
      const to = cfg.owner?.email;
      if (!to) return "posted on the board (no owner email set in the business config).";
      try { await sendEmail(b, { to, subject: input.subject, text: input.body, fromName: "__owner__" }); return "sent to the owner and posted on the board"; }
      catch (e) { return `posted on the board; email failed: ${(e as Error).message}`; }
    }
    case "save_content": {
      const ids: number[] = [...new Set((Array.isArray(input.media_ids) ? input.media_ids : []).map(Number).filter((n: number) => n > 0))] as number[];
      if (ids.length) {
        const found = await sql`select id, kind, permission from os.media where business_id = ${b.id} and status = 'ready' and id = any(${sql.array(ids)}::bigint[])`;
        if (found.length !== ids.length) return "error: some media ids weren't found in this business's library. Use find_media.";
        if (found.some((m: any) => !m.permission)) return "error: one of those files isn't cleared for public use. Pick another or ask the owner.";
        const vids = found.filter((m: any) => m.kind === "video"), pics = found.filter((m: any) => m.kind === "photo");
        if (found.some((m: any) => m.kind === "audio")) return "error: music can't be posted on its own; attach photos or a video.";
        if (vids.length > 1 || (vids.length && pics.length)) return "error: attach either one video, or up to 10 photos, not both.";
        if (pics.length > 10) return "error: 10 photos at most per post.";
        if (input.kind === "reel" && vids.length !== 1) return "error: a reel needs exactly one video from the library.";
      } else if (input.kind === "reel") return "error: a reel needs one video from the library (media_ids).";
      const [c] = await sql`insert into os.content (business_id, created_by, kind, channel, audience, title, body, media_ids)
        values (${b.id}, ${a.slot}, ${input.kind}, ${input.channel ?? null}, ${input.audience ?? null}, ${input.title ?? null}, ${input.body}, ${sql.array(ids)}::bigint[]) returning id`;
      return `saved as content #${c.id}${ids.length ? ` with ${ids.length} file${ids.length > 1 ? "s" : ""}` : ""}; it waits for approval.`;
    }
    case "find_media": {
      const words = String(input?.query ?? "").toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w.length > 1).slice(0, 6);
      const rows = await sql`select id, kind, tag, contractor, trade, job, title, notes, ai_notes as seen, created_at::date as added from os.media
        where business_id = ${b.id} and status = 'ready' and permission
        ${input?.tag ? sql`and tag = ${String(input.tag)}` : sql``}
        ${input?.kind ? sql`and kind = ${String(input.kind)}` : sql``}
        ${words.length ? sql`and concat_ws(' ', contractor, trade, job, title, notes, ai_notes) ilike all(${sql.array(words.map((w) => `%${w}%`))})` : sql``}
        order by created_at desc limit 40`;
      if (!rows.length) {
        const [n] = await sql`select count(*)::int as n from os.media where business_id = ${b.id} and status = 'ready' and not permission`;
        return `nothing matches${n.n ? ` (${n.n} file${n.n > 1 ? "s are" : " is"} in the library but not cleared for public use yet)` : ""}. Ask the owner to upload what you need in the Media tab.`;
      }
      return JSON.stringify(rows);
    }
    case "view_media": {
      const ids = (Array.isArray(input.ids) ? input.ids : []).map(Number).filter((n: number) => n > 0).slice(0, 4);
      if (!ids.length) return "error: give the ids to look at (from find_media).";
      const rows = await sql`select id, kind, tag, contractor, trade, job, frames from os.media
        where business_id = ${b.id} and status = 'ready' and permission and id = any(${sql.array(ids)}::bigint[]) order by id`;
      if (!rows.length) return "none of those are in the library (or cleared for use).";
      const blocks: any[] = [];
      for (const m of rows) {
        const what = `#${m.id} ${m.kind}: ${[m.tag, m.trade, m.contractor, m.job].filter(Boolean).join(", ")}`;
        if (!m.frames?.length) { blocks.push({ type: "text", text: `${what}. No preview to look at (e.g. an iPhone HEIC photo); go by its labels.` }); continue; }
        const show = m.frames.slice(0, m.kind === "video" ? 4 : 1);
        blocks.push({ type: "text", text: m.kind === "video" ? `${what}. ${show.length} frames, in order:` : `${what}:` });
        blocks.push(...(await previewBlocks(show)));
      }
      return blocks;
    }
    case "recall": {
      const words = String(input?.query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).slice(0, 6);
      const list = (words.length
        ? await sql`select id, subject, note, sources, created_by, created_at::date as day from os.research_notes where business_id = ${b.id}
            and (subject || ' ' || note) ilike any(${sql.array(words.map((w) => `%${w}%`))}) order by created_at desc limit 12`
        : await sql`select id, subject, note, sources, created_by, created_at::date as day from os.research_notes where business_id = ${b.id} order by created_at desc limit 12`);
      return list.length ? JSON.stringify(list) : "nothing saved on that yet; search, then save_note what you find";
    }
    case "save_note": {
      const sources = Array.isArray(input.sources) ? input.sources.map(String).slice(0, 10) : [];
      const [n] = await sql`insert into os.research_notes (business_id, subject, note, sources, created_by)
        values (${b.id}, ${String(input.subject).slice(0, 200)}, ${String(input.note).slice(0, 2000)}, ${sql.array(sources)}::text[], ${a.slot}) returning id`;
      return `note #${n.id} saved`;
    }
    case "write_notebook": {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: b.timezone }).format(new Date());
      await sql`insert into os.notebook (business_id, day, body, created_by) values (${b.id}, ${day}, ${String(input.body).slice(0, 2500)}, ${a.slot})
        on conflict (business_id, day) do update set body = excluded.body, created_by = excluded.created_by, updated_at = now()`;
      return `notebook for ${day} saved`;
    }
    case "queue_call": {
      const [ph] = await sql`select 1 from os.integrations where business_id = ${b.id} and provider = 'phone' and status = 'connected'`;
      if (!ph) return "This business doesn't have a phone line yet, so there's no call list. Say so to the owner if calls would help.";
      const [rec] = input.record_id ? await sql`select id, title, data->>'phone' as phone from os.records where id = ${input.record_id} and business_id = ${b.id}` : [];
      if (input.record_id && !rec) return "record not found";
      const phone = e164(input.phone ?? rec?.phone);
      if (!phone) return "error: no valid phone number on that record. Find one from a real source first (save_record), or skip.";
      const [nc] = await sql`select 1 from os.never_call where business_id = ${b.id} and phone = ${phone}`;
      if (nc) return "That number is on the do-not-call list. Don't call them.";
      const [q] = await sql`insert into os.call_queue (business_id, record_id, phone, name, reason, queued_by)
        values (${b.id}, ${rec?.id ?? null}, ${phone}, ${rec?.title ?? null}, ${String(input.reason ?? "").slice(0, 500)}, ${a.slot}) on conflict do nothing returning id`;
      return q ? `added to the call list (#${q.id})` : "already on the call list";
    }
    case "schedule_content": {
      const [c] = await sql`select status from os.content where id = ${input.id} and business_id = ${b.id}`;
      if (!c) return "not found";
      if (!["approved", "scheduled"].includes(c.status)) return `content #${input.id} is ${c.status}; only approved content can be scheduled.`;
      const when = new Date(input.when);
      if (isNaN(when.getTime())) return "error: bad date";
      await sql`update os.content set status = 'scheduled', scheduled_for = ${when} where id = ${input.id}`;
      return `scheduled for ${when.toLocaleString("en-US", { timeZone: b.timezone })}.`;
    }
  }
  return `error: unknown tool ${name}`;
}
