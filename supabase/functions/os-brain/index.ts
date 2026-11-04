// os-brain: the router and agent worker for every Destiny OS business.
// A new message -> the router picks who answers -> each agent gets its own run (its own server call).
import { audit, business, BizAgent, Business, claude, config, monthSpend, onShift, post, sql, team } from "../_core/core.ts";
import { runTool, toolsFor } from "../_core/tools.ts";

const PLATFORM_RULES = `Rules you never break, in every business:
- Never invent facts, numbers, names, contact details, reviews or results. Unknown stays blank; say when something is a guess.
- Nothing consequential happens without approval: sending emails or offers, publishing, spending money, or any commitment. Use request_approval and never say it was sent until it was.
- Never pose as a real person you are not, and if anyone asks whether they are dealing with AI, be honest.
- Never contact individuals from bought, scraped or collected lists; no cold texts or calls.
- Only use this business's information. Never mention other businesses on the platform.`;

const TALK = `How to talk on the board:
- You are a real coworker in a real workplace: your own personality, teammates by first name. Short and natural, 1 to 4 sentences, plain words, no headers or emojis.
- To hand work to a teammate, @mention them by handle. Only @mention someone who needs to act now; if nothing more is needed, mention no one and the conversation rests.
- Never @mention yourself. Thanks and small talk stay short; the work comes first.
- Refer to records as #id and tasks as task #id.`;

function bubbleDate(b: Business) {
  return new Date().toLocaleString("en-US", { timeZone: b.timezone, dateStyle: "full", timeStyle: "short" });
}

async function systemPrompt(b: Business, cfg: Record<string, any>, me: BizAgent, crew: BizAgent[]) {
  const roster = crew.filter((x) => x.enabled).map((x) => `- ${x.name} (@${x.handle}): ${x.core_role.split(":")[0]}. ${x.role_instructions ? x.role_instructions.split("\n")[0] : ""}`).join("\n");
  const guides = await sql`select kind, body from os.agent_guides where business_id = ${b.id} and slot = ${me.slot} and body <> ''`;
  const facts = cfg.facts ? `\n\nFACTS (use exactly; never add to them):\n${cfg.facts}` : "";
  const rules = cfg.rules ? `\n\nBUSINESS RULES:\n${cfg.rules}` : "";
  const types = cfg.record_types ? `\n\nRECORD TYPES (type: stages):\n${Object.entries(cfg.record_types).map(([k, v]: any) => `- ${k}: ${(v.stages ?? []).join(" -> ")}${v.description ? ` (${v.description})` : ""}`).join("\n")}` : "";
  return `You work at ${b.name}. ${cfg.mission ?? ""}${facts}${rules}${types}

YOUR TEAM:
${roster}
- The owner${cfg.owner?.name ? ` (${cfg.owner.name})` : ""}: the boss. Their messages come first, and when the owner posts, everyone answers.
Work hours: a ${b.shift_end - b.shift_start}-hour shift with hourly check-ins; use each one to move your own work forward.

${TALK}

${PLATFORM_RULES}

YOU ARE ${me.name.toUpperCase()} (@${me.handle}).
Who you are: ${me.personality}
Your job on every team: ${me.core_role}
Your job here: ${me.role_instructions || "(follow the mission and your core job)"}${guides.length ? `\n\nWHAT YOU'VE LEARNED:\n${guides.map((g: any) => `[${g.kind}] ${g.body}`).join("\n")}` : ""}

It is now ${bubbleDate(b)} (${b.timezone}).`;
}

async function contextBlock(b: Business, crew: BizAgent[]) {
  const name = (s: string, n?: string) => n ?? crew.find((c) => c.slot === s)?.name ?? (s === "owner" ? "Owner" : s === "system" ? "System" : s);
  const msgs = await sql`select id, created_at, sender, sender_name, body from os.messages where business_id = ${b.id} order by id desc limit 30`;
  const tasks = await sql`select t.id, t.title, a.name as who, t.status from os.tasks t left join os.agents a on a.slot = t.assignee_slot
    where t.business_id = ${b.id} and t.status in ('open','in_progress','blocked') order by t.id limit 30`;
  const recs = await sql`select id, type, status, title, next_step, next_step_due from os.records where business_id = ${b.id}
    order by updated_at desc limit 40`;
  const aps = await sql`select id, kind, summary, status, note from os.approvals where business_id = ${b.id} and status in ('pending','failed') order by id limit 15`;
  return `OPEN TASKS:\n${tasks.map((t: any) => `task #${t.id} ${t.title} | ${t.who ?? "unassigned"} | ${t.status}`).join("\n") || "(none)"}

RECENT RECORDS:\n${recs.map((r: any) => `#${r.id} [${r.type}] ${r.title} | ${r.status}${r.next_step ? ` | next: ${r.next_step}` : ""}${r.next_step_due ? ` due ${String(r.next_step_due).slice(0, 10)}` : ""}`).join("\n") || "(none)"}

APPROVALS WAITING:\n${aps.map((a: any) => `#${a.id} ${a.kind}: ${a.summary} [${a.status}${a.note ? `: ${a.note}` : ""}]`).join("\n") || "(none)"}

TEAM BOARD (latest at bottom):\n${msgs.reverse().map((m: any) => `[${new Date(m.created_at).toLocaleString("en-US", { timeZone: b.timezone })}] ${name(m.sender, m.sender_name)}: ${m.body}`).join("\n")}`;
}

async function agentTurn(b: Business, me: BizAgent, crew: BizAgent[], cfg: Record<string, any>, trigger: any) {
  const fromOwner = trigger.sender === "owner" || String(trigger.sender).startsWith("user:");
  const system = await systemPrompt(b, cfg, me, crew);
  const ask = fromOwner
    ? "The newest message is from the owner to the whole team. Everyone answers: reply in your own voice (1 to 3 sentences) about the part that concerns your job, and if it gives you work, do it with your tools first."
    : `The newest message is for you. Do the work it needs with your tools, then write your reply for the board. If no reply is needed, answer with exactly: (no reply)`;
  const messages: any[] = [{ role: "user", content: `${await contextBlock(b, crew)}\n\n${ask}` }];
  const tools = toolsFor(me, cfg);
  const ctx = { recordId: trigger.record_id ?? undefined, saved: 0, depth: trigger.depth ?? 0 };
  const started = Date.now(), BUDGET = 100_000;
  let final = "";
  for (let i = 0; i < 8; i++) {
    const left = BUDGET - (Date.now() - started);
    if (i > 0 && left < 30_000) {
      await post(b.id, "system", `@${me.handle} keep going where you left off; check tasks and records first so nothing is redone.`, { depth: ctx.depth + 1 });
      return;
    }
    let res;
    try {
      res = await claude(b, me.slot, { model: me.model ?? b.model, max_tokens: 2000, system, tools, messages }, left);
    } catch (e) {
      if (/abort/i.test((e as Error).name + (e as Error).message)) {
        await post(b.id, "system", `@${me.handle} that step took too long. Keep going where you left off.`, { depth: ctx.depth + 1 });
        return;
      }
      throw e;
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
    break;
  }
  if (final && !/^\(no reply\)$/i.test(final)) await post(b.id, me.slot, final, { depth: ctx.depth + 1, recordId: ctx.recordId });
}

function responders(m: any, crew: BizAgent[]) {
  const on = crew.filter((c) => c.enabled);
  const fromOwner = m.sender === "owner" || String(m.sender).startsWith("user:");
  if (fromOwner) return on;
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
