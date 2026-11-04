// The shared tool set. Every tool runs inside one business; ids from another business are never found.
import { audit, Business, BizAgent, post, sql } from "./core.ts";
import { PACKS, sendEmail } from "./integrations.ts";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const S = { type: "string" }, I = { type: "integer" };

export const TOOL_DEFS: Record<string, Record<string, unknown>> = {
  web_search: { type: "web_search_20250305", name: "web_search", max_uses: 3 },
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
  save_content: { name: "save_content", description: "Save a piece of content (post, ad, video script, graphic brief, page) for approval.",
    input_schema: obj({ kind: { type: "string", enum: ["post", "ad", "video_script", "graphic_brief", "page", "email", "other"] }, channel: S, audience: S, title: S, body: S }, ["kind", "body"]) },
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
export async function execute(b: Business, ap: any): Promise<string> {
  if (ap.kind === "email") {
    const p = ap.payload ?? {};
    if (!p.to || !p.subject || !p.body) throw new Error("email approval is missing to, subject or body");
    await sendEmail(b, { to: p.to, subject: p.subject, text: p.body });
    await sql`update os.approvals set status = 'done' where id = ${ap.id}`;
    if (ap.record_id) await sql`update os.records set status = 'contacted', next_step = 'wait for reply, follow up if none', next_step_due = (now() + interval '4 days')::date, updated_at = now() where id = ${ap.record_id} and business_id = ${b.id}`;
    return `email sent to ${p.to}`;
  }
  return "approved; nothing to carry out automatically for this kind";
}

export async function runTool(b: Business, cfg: Record<string, any>, a: BizAgent, name: string, input: any, ctx: { recordId?: number; saved: number; depth: number }): Promise<string> {
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
      const [c] = await sql`insert into os.content (business_id, created_by, kind, channel, audience, title, body)
        values (${b.id}, ${a.slot}, ${input.kind}, ${input.channel ?? null}, ${input.audience ?? null}, ${input.title ?? null}, ${input.body}) returning id`;
      return `saved as content #${c.id}; it waits for approval.`;
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
