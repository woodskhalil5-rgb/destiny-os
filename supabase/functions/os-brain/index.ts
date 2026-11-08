// os-brain: the router and agent worker for every Destiny OS business.
// A new message -> the router picks who answers -> each agent gets its own run (its own server call).
import { audit, business, BizAgent, Business, claude, config, monthSpend, onShift, post, sql, team } from "../_core/core.ts";
import { runTool, toolsFor } from "../_core/tools.ts";

const PLATFORM_RULES = `Rules you never break, in every business:
- Never invent facts, numbers, names, contact details, reviews or results. Unknown stays blank; say when something is a guess.
- Nothing consequential happens without approval: sending emails or offers, publishing, spending money, or any commitment. Use request_approval and never say it was sent until it was.
- Never pose as a real person you are not, and if anyone asks whether they are dealing with AI, be honest.
- Never contact private individuals (consumers) from bought, scraped or collected lists, and never text anyone. You never call anyone yourself: a person makes the calls from the call list (queue_call). Only add businesses, professionals (agents, contractors, owners of a business), or people who asked to hear from us or already work with us, and never anyone the business rules or the do-not-call list rule out.
- Only use this business's information. Never mention other businesses on the platform.`;

const TALK = `How to talk on the board:
- You are a real coworker in a real workplace: your own personality, teammates by first name. Short and natural, 1 to 4 sentences, plain words, no headers or emojis.
- To hand work to a teammate, @mention them by handle. Only @mention someone who needs to act now; if nothing more is needed, mention no one and the conversation rests.
- Never @mention yourself. Thanks and small talk stay short; the work comes first.
- Refer to records as #id and tasks as task #id.`;

const WORK = `How to work efficiently:
- Work in batches. When you have several similar items (records to research, emails to draft, posts to write), do 5 to 8 in one go, then post one short summary instead of one message per item.
- Before searching the web, use recall to check what the team already learned. After useful research, save_note the finding with its sources so nobody pays to look it up again.
- Your context shows only your part of the work. Use find_records, get_record and list_tasks for anything else you need.`;

function bubbleDate(b: Business) {
  return new Date().toLocaleString("en-US", { timeZone: b.timezone, dateStyle: "full", timeStyle: "short" });
}
function today(b: Business) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: b.timezone }).format(new Date());
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const isOwner = (sender: string) => sender === "owner" || String(sender).startsWith("user:");

/** The stable part of an agent's instructions (no clock, no board), so it can be cached between calls. */
async function systemPrompt(b: Business, cfg: Record<string, any>, me: BizAgent, crew: BizAgent[]) {
  const roster = crew.filter((x) => x.enabled).map((x) => `- ${x.name} (@${x.handle}): ${x.core_role.split(":")[0]}. ${x.role_instructions ? x.role_instructions.split("\n")[0] : ""}`).join("\n");
  const guides = await sql`select kind, body from os.agent_guides where business_id = ${b.id} and slot = ${me.slot} and body <> ''`;
  const facts = cfg.facts ? `\n\nFACTS (use exactly; never add to them):\n${cfg.facts}` : "";
  const rules = cfg.rules ? `\n\nBUSINESS RULES:\n${cfg.rules}` : "";
  const types = cfg.record_types ? `\n\nRECORD TYPES (type: stages):\n${Object.entries(cfg.record_types).map(([k, v]: any) => `- ${k}: ${(v.stages ?? []).join(" -> ")}${v.description ? ` (${v.description})` : ""}`).join("\n")}` : "";
  return `You work at ${b.name}. ${cfg.mission ?? ""}${facts}${rules}${types}

YOUR TEAM:
${roster}
- The owner${cfg.owner?.name ? ` (${cfg.owner.name})` : ""}: the boss. Their messages come first. When the owner posts, everyone answers, unless the owner names someone; then only they answer.
Work hours: a ${b.shift_end - b.shift_start}-hour shift with hourly check-ins; use each one to move your own work forward.

${TALK}

${WORK}

${PLATFORM_RULES}

YOU ARE ${me.name.toUpperCase()} (@${me.handle}).
Who you are: ${me.personality}
Your job on every team: ${me.core_role}
Your job here: ${me.role_instructions || "(follow the mission and your core job)"}${guides.length ? `\n\nWHAT YOU'VE LEARNED:\n${guides.map((g: any) => `[${g.kind}] ${g.body}`).join("\n")}` : ""}`;
}

/** What this agent needs to see right now: its own work in full, the rest of the team as counts. */
async function contextBlock(b: Business, crew: BizAgent[], me: BizAgent, trigger: any) {
  const name = (s: string, n?: string) => n ?? crew.find((c) => c.slot === s)?.name ?? (s === "owner" ? "Owner" : s === "system" ? "System" : s);
  const lead = me.slot === "coordination";
  const day = today(b);
  const [msgs, tasks, pipeline, aps, notes] = await Promise.all([
    sql`select id, created_at, sender, sender_name, body from os.messages where business_id = ${b.id} and id <= ${trigger.id} order by id desc limit 20`,
    sql`select t.id, t.title, t.assignee_slot, a.name as who, t.status, t.due_at from os.tasks t left join os.agents a on a.slot = t.assignee_slot
      where t.business_id = ${b.id} and t.status in ('open','in_progress','blocked') order by t.id limit 60`,
    sql`select type, status, count(*)::int as n from os.records where business_id = ${b.id} group by 1, 2 order by 1, 3 desc`,
    sql`select id, kind, summary, status, note, requested_by from os.approvals where business_id = ${b.id}
      and (status in ('pending','failed') or (status = 'rejected' and decided_at > now() - interval '3 days')) order by id limit 30`,
    sql`select day, body from os.notebook where business_id = ${b.id} order by day desc limit 1`,
  ]);
  // Records: DeMarcus sees everything due plus the latest activity; everyone else sees what they own.
  const recs = lead
    ? await sql`(select id, type, status, title, next_step, next_step_due, owner_slot from os.records where business_id = ${b.id} and next_step_due <= ${day} order by next_step_due limit 25)
        union (select id, type, status, title, next_step, next_step_due, owner_slot from os.records where business_id = ${b.id} order by updated_at desc limit 15)`
    : await sql`select id, type, status, title, next_step, next_step_due, owner_slot from os.records where business_id = ${b.id} and owner_slot = ${me.slot}
        order by (next_step_due is null), next_step_due, updated_at desc limit 25`;
  if (trigger.record_id && !recs.some((r: any) => String(r.id) === String(trigger.record_id))) {
    const [r] = await sql`select id, type, status, title, next_step, next_step_due, owner_slot from os.records where id = ${trigger.record_id} and business_id = ${b.id}`;
    if (r) recs.unshift(r);
  }
  const mine = tasks.filter((t: any) => t.assignee_slot === me.slot);
  const others = tasks.filter((t: any) => t.assignee_slot !== me.slot);
  const myAps = lead ? aps : aps.filter((a: any) => a.requested_by === me.slot);
  const content = ["media", "coordination"].includes(me.slot)
    ? await sql`select id, kind, channel, title, status, scheduled_for, note from os.content where business_id = ${b.id}
        and status not in ('published','rejected') order by id desc limit 15`
    : [];
  const recLine = (r: any) => `#${r.id} [${r.type}] ${r.title} | ${r.status}${r.next_step ? ` | next: ${r.next_step}` : ""}${r.next_step_due ? ` due ${String(r.next_step_due).slice(0, 10)}` : ""}${lead && r.owner_slot ? ` | ${name(r.owner_slot)}` : ""}`;
  const taskLine = (t: any) => `task #${t.id} ${t.title} | ${t.who ?? "unassigned"} | ${t.status}${t.due_at ? ` | due ${String(t.due_at).slice(0, 10)}` : ""}`;
  const counts = Object.entries(others.reduce((m: Record<string, number>, t: any) => ((m[t.who ?? "unassigned"] = (m[t.who ?? "unassigned"] ?? 0) + 1), m), {}))
    .map(([k, v]) => `${k} ${v}`).join(", ");
  const parts = [
    notes[0] ? `TEAM NOTEBOOK (${String(notes[0].day).slice(0, 10)}):\n${clip(notes[0].body, 1500)}` : "",
    `PIPELINE (records by type and status):\n${pipeline.map((p: any) => `${p.type}/${p.status}: ${p.n}`).join(", ") || "(empty)"}`,
    lead
      ? `OPEN TASKS:\n${tasks.map(taskLine).join("\n") || "(none)"}`
      : `YOUR OPEN TASKS:\n${mine.map(taskLine).join("\n") || "(none)"}${counts ? `\nTeammates' open tasks: ${counts}` : ""}`,
    `${lead ? "RECORDS DUE AND RECENT" : "YOUR RECORDS"}:\n${recs.map(recLine).join("\n") || "(none)"}`,
    `${lead ? "APPROVALS WAITING" : "YOUR APPROVALS"}:\n${myAps.map((a: any) => `#${a.id} ${a.kind}: ${a.summary} [${a.status}${a.note ? `: ${clip(a.note, 200)}` : ""}]`).join("\n") || "(none)"}${!lead && aps.length > myAps.length ? `\n(${aps.length - myAps.length} more waiting for others)` : ""}`,
    content.length ? `CONTENT IN PROGRESS:\n${content.map((c: any) => `content #${c.id} ${c.kind}${c.channel ? `/${c.channel}` : ""}: ${c.title ?? "(untitled)"} | ${c.status}${c.scheduled_for ? ` for ${new Date(c.scheduled_for).toLocaleString("en-US", { timeZone: b.timezone })}` : ""}${c.note ? ` | ${clip(c.note, 120)}` : ""}`).join("\n")}` : "",
    `TEAM BOARD (latest at bottom):\n${msgs.reverse().map((m: any) => `[${new Date(m.created_at).toLocaleString("en-US", { timeZone: b.timezone })}] ${name(m.sender, m.sender_name)}: ${clip(m.body, String(m.id) === String(trigger.id) || isOwner(m.sender) ? 3000 : 600)}`).join("\n")}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Mark the newest user turn as a cache point (and clear older ones) so each loop step re-reads the conversation at a tenth of the price. */
function cachePoint(messages: any[]) {
  for (const m of messages) if (Array.isArray(m.content)) for (const blk of m.content) if (blk && typeof blk === "object") delete blk.cache_control;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || !Array.isArray(m.content) || !m.content.length) continue;
    const last = m.content[m.content.length - 1];
    if (last.type === "text" || last.type === "tool_result") last.cache_control = { type: "ephemeral" };
    return;
  }
}

async function agentTurn(b: Business, me: BizAgent, crew: BizAgent[], cfg: Record<string, any>, trigger: any) {
  const fromOwner = isOwner(trigger.sender);
  const system = [{ type: "text", text: await systemPrompt(b, cfg, me, crew), cache_control: { type: "ephemeral" } }];
  const direct = fromOwner && named(trigger.body, crew).length > 0;
  const ask = direct
    ? "The message above (the last on the board) is from the owner and names you. Answer it yourself in your own voice, and if it gives you work, do it with your tools first. Only the teammates the owner named will answer."
    : fromOwner
    ? "The message above (the last on the board) is from the owner to the whole team. Everyone answers: reply in your own voice (1 to 3 sentences) about the part that concerns your job, and if it gives you work, do it with your tools first."
    : `Message #${trigger.id} (the last on the board) is for you. Do the work it needs with your tools, then write your reply for the board. If no reply is needed, answer with exactly: (no reply)`
      + " When the work covers several records, finish them one at a time (read one, save it, then the next) rather than reading them all first: a run can stop part-way, and only saved work carries over.";
  const messages: any[] = [{ role: "user", content: [{ type: "text", text: `${await contextBlock(b, crew, me, trigger)}\n\nIt is now ${bubbleDate(b)} (${b.timezone}).\n\n${ask}` }] }];
  const tools = toolsFor(me, cfg);
  const ctx = { recordId: trigger.record_id ?? undefined, saved: 0, depth: trigger.depth ?? 0, savedIds: [] as number[] };
  // Handing over to the next run: say what this run already saved, so it isn't read and redone.
  const done = () => { const ids = [...new Set(ctx.savedIds)]; return ids.length ? ` You already saved ${ids.map((x) => "#" + x).join(", ")} in the last run: don't reopen those; go on with the next one.` : ""; };
  const started = Date.now(), BUDGET = 100_000;
  let final = "", nudged = false;
  for (let i = 0; i < 8; i++) {
    const left = BUDGET - (Date.now() - started);
    if (i > 0 && left < 30_000) {
      await post(b.id, "system", `@${me.handle} keep going where you left off; check your task first so nothing is redone.${done()}`, { depth: ctx.depth + 1 });
      return;
    }
    let res;
    cachePoint(messages);
    try {
      res = await claude(b, me.slot, { model: me.model ?? b.model, max_tokens: 4096, system, tools, messages }, left);
    } catch (e) {
      if (/abort/i.test((e as Error).name + (e as Error).message)) {
        await post(b.id, "system", `@${me.handle} that step took too long. Keep going where you left off.${done()}`, { depth: ctx.depth + 1 });
        return;
      }
      throw e;
    }
    // Out of room mid-reply (usually after a lot of searching): keep what was said, drop the cut-off tool call,
    // and have them save what they found instead of losing the whole run.
    if (res.stop_reason === "max_tokens") {
      const kept = [...(res.content ?? [])];
      while (kept.length && ["tool_use", "server_tool_use"].includes(kept[kept.length - 1].type)) kept.pop();
      const nudge = { type: "text", text: "You ran out of room in that reply. Stop searching now: save what you already found with your tools (one save_record per item, facts in data, with sources), then write a short board update." };
      if (kept.length) { messages.push({ role: "assistant", content: kept }); messages.push({ role: "user", content: [nudge] }); }
      else messages[messages.length - 1].content.push(nudge);
      continue;
    }
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "tool_use") {
      const results: any[] = [];
      for (const blk of res.content) if (blk.type === "tool_use") {
        results.push({ type: "tool_result", tool_use_id: blk.id, content: await runTool(b, cfg, me, blk.name, blk.input, ctx) });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    if (res.stop_reason === "pause_turn") continue;
    final = res.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("").trim();
    // Searched the web but ended without saving or saying anything: give them one chance to keep the work.
    const searched = res.content.some((x: any) => x.type === "server_tool_use");
    if (!nudged && searched && !ctx.saved && (!final || /^\(no reply\)$/i.test(final))) {
      nudged = true;
      messages.push({ role: "user", content: [{ type: "text", text: "You searched but didn't save anything or post an update. Save what you found now (save_record, facts in data, with sources), or say on the board why nothing was worth saving." }] });
      continue;
    }
    break;
  }
  if (final && !/^\(no reply\)$/i.test(final)) await post(b.id, me.slot, final, { depth: ctx.depth + 1, recordId: ctx.recordId });
}

/** Teammates the message names, by first name or @handle ("Grayson what are you making", "@james ..."). */
function named(body: string, crew: BizAgent[]) {
  return crew.filter((c) => c.enabled && [c.name, c.handle].some((n) => new RegExp(`(^|[^\\w])@?${n}\\b`, "i").test(body)));
}

function responders(m: any, crew: BizAgent[]) {
  const on = crew.filter((c) => c.enabled);
  const fromOwner = m.sender === "owner" || String(m.sender).startsWith("user:");
  if (fromOwner) { const n = named(m.body, crew); return n.length ? n : on; } // name someone and only they answer
  const mentioned = on.filter((c) => new RegExp(`@${c.handle}\\b`, "i").test(m.body));
  if (mentioned.length) return mentioned.filter((c) => c.slot !== m.sender);
  return m.sender === "system" ? on.filter((c) => c.slot === "coordination") : [];
}

async function route(id: number) {
  const [m] = await sql`update os.messages set status = 'handled' where id = ${id} and status = 'queued' returning *`;
  if (!m) return;
  const b = await business(m.business_id);
  if (!b || b.status === "archived") return;
  const fromOwner = m.sender === "owner" || String(m.sender).startsWith("user:");
  if (!fromOwner && (b.status !== "live" || !onShift(b))) return;
  if (b.monthly_budget_usd != null && (await monthSpend(b.id)) >= b.monthly_budget_usd) {
    await post(b.id, "system", `Monthly budget of $${b.monthly_budget_usd} reached; the team is paused until the owner raises it.`, { status: "handled" });
    return;
  }
  const who = responders(m, await team(b.id));
  await Promise.all(who.map((a) => fetch(SELF, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: req_auth },
    body: JSON.stringify({ message_id: id, slot: a.slot }),
  }).catch(() => null)));
}

async function work(id: number, slot: string) {
  const [m] = await sql`select * from os.messages where id = ${id}`;
  if (!m) return;
  const b = (await business(m.business_id))!;
  const crew = await team(b.id);
  const me = crew.find((c) => c.slot === slot && c.enabled);
  if (!me) return;
  for (let i = 0; i < 6; i++) {
    const [busy] = await sql`select id from os.agent_runs where business_id = ${b.id} and slot = ${slot} and status = 'running' and started_at > now() - interval '4 minutes'`;
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const [run] = await sql`insert into os.agent_runs (business_id, slot, message_id) values (${b.id}, ${slot}, ${id}) returning id`;
  try {
    await agentTurn(b, me, crew, await config(b.id), m);
    await sql`update os.agent_runs set status = 'done', ended_at = now() where id = ${run.id}`;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    await sql`update os.agent_runs set status = 'error', ended_at = now(), error = ${msg} where id = ${run.id}`;
    await audit(b.id, "agent", slot, "error", String(id), { error: msg });
    await post(b.id, "system", `${me.name} hit an error: ${msg}`, { status: "handled" });
  }
}

const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/os-brain`;
let req_auth = "";

Deno.serve(async (req) => {
  req_auth = req.headers.get("authorization") ?? "";
  const { message_id, slot } = await req.json().catch(() => ({}));
  if (!message_id) return new Response("missing message_id", { status: 400 });
  const job = slot ? work(Number(message_id), String(slot)) : route(Number(message_id));
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(job);
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json" } });
});
