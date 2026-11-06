// The AI phone assistant: answers a business's line when nobody picks up (only if the owner turned it on).
// It takes down the caller's name, what they need, where, and a good time to call back, then hands it to the
// owner as an inquiry. It never quotes prices, availability or appointment times. Billed like any other AI work.
import { Business, claude, config, monthSpend, post, sql } from "./core.ts";

const MODEL = "claude-haiku-5-5";
export const MAX_TURNS = 8;

type Msg = { role: "user" | "assistant"; content: string };
export type Lead = { name?: string; need?: string; location?: string; callback?: string; phone?: string };

export function greeting(name: string) {
  return `Thanks for calling ${name}. Everyone's out on a job right now, so this is the virtual assistant. I'll take down what you need and have someone call you back. How can we help?`;
}

/** Can the assistant take this call? Owner turned it on, the AI isn't down, the business is in good standing and under budget. */
export async function assistantOk(b: Business & { phone?: any }) {
  if (b.phone?.ai_answer !== "true") return false;
  if (b.status === "archived" || b.billing_status === "past_due") return false;
  const [down] = await sql`select os.ai_down() as d`;
  if (down?.d) return false;
  if (b.monthly_budget_usd != null && (await monthSpend(b.id)) >= Number(b.monthly_budget_usd)) return false;
  return true;
}

/** One turn: what the assistant says next, whether the call is over, and what it has learned so far. */
export async function assistantTurn(b: Business, from: string, transcript: Msg[], lastTurn: boolean): Promise<{ say: string; done: boolean; lead: Lead }> {
  const cfg = await config(b.id);
  const about = [cfg.mission, cfg.facts].filter(Boolean).join("\n").slice(0, 4000);
  const system = `You answer the phone for ${b.name} when nobody on the team can pick up. You are a virtual assistant and say so if asked. The caller is calling from ${from || "an unknown number"}.

About the business (the only facts you may use):
${about || "(no details yet)"}

Your job: find out the caller's name, what they need, where the job is (town or address), and the best time to call them back, and check that the number they're calling from is the best one to reach them. Then tell them someone from ${b.name} will call them back as soon as they can, and end the call.

How to talk: like a friendly, efficient receptionist. One or two short sentences per reply, one question at a time, plain words (this is read aloud, so no lists, symbols or emojis). Don't repeat back everything they said.
Never quote prices, estimates, availability or appointment times, and never promise anything that isn't in the facts above: say the owner will go over that when they call back.
If it sounds like an emergency (a gas smell, fire, sparking or flooding near electricity, someone hurt), tell them to hang up and call 911, or the gas company for a gas smell, and end the call.
If it's a sales call or spam, take a short message and end politely. If they ask for a person, say no one can pick up right now and you'll make sure the message gets through.
${lastTurn ? "This is your last reply: thank them and end the call now." : ""}
Reply with JSON only, no other text: {"say": "what you say next", "done": false, "lead": {"name": "", "need": "", "location": "", "callback": "", "phone": ""}}
Fill in lead with everything you know so far (empty strings for what you don't). Set done to true only when "say" ends the call.`;
  const messages: Msg[] = [{ role: "user", content: "(The call connects. You answered with the greeting below.)" }, ...transcript];
  const res = await claude(b, "coordination", { model: MODEL, max_tokens: 400, system, messages }, 9_000);
  const text = (res.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("").trim();
  try {
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const say = String(j.say ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    if (say) return { say, done: !!j.done || lastTurn, lead: (j.lead ?? {}) as Lead };
  } catch { /* fall through */ }
  const say = text.replace(/[{}"]/g, "").replace(/\s+/g, " ").trim().slice(0, 600) || "Thanks for calling. Someone will call you back as soon as they can. Goodbye.";
  return { say, done: lastTurn, lead: {} };
}

/** The call is over (finished, cut short or hung up): turn what the caller said into an inquiry for the owner. Runs once. */
export async function finishAssistantCall(cid: number) {
  const [c] = await sql`update os.calls set ai_done = true where id = ${cid} and ai_answered and not ai_done returning *`;
  if (!c) return;
  const t: Msg[] = c.ai_transcript ?? [];
  const said = t.filter((m) => m.role === "user");
  const [b] = await sql`select name from os.businesses where id = ${c.business_id}`;
  if (!said.length) {
    await sql`select os.alert(${c.business_id}, 'business', 'missed_call', ${"Missed call from " + c.from_number}, ${`Someone called ${b?.name ?? "your business"} from ${c.from_number} and hung up before saying anything. You may want to call them back.`}, ${"mc:" + cid})`;
    return;
  }
  const l: Lead = c.ai_lead ?? {};
  const phone = (l.phone && l.phone.replace(/\D/g, "").length >= 7 ? l.phone : c.from_number) as string;
  const name = (l.name || "").trim() || "Caller " + c.from_number;
  const summary = [l.need, l.location && `Where: ${l.location}`, l.callback && `Best time to call back: ${l.callback}`].filter(Boolean).join(". ") || said.map((m) => m.content).join(" ").slice(0, 500);
  const lines = t.map((m) => `${m.role === "user" ? "Caller" : "Assistant"}: ${m.content}`).join("\n");
  const [r] = await sql`insert into os.records (business_id, type, status, title, data, created_by, next_step, next_step_due)
    values (${c.business_id}, 'inquiry', 'new', ${name}, ${sql.json({ name, phone, message: summary, source: "phone (virtual assistant)", call_id: cid, transcript: lines.slice(0, 8000), consent_calls: false, received_at: new Date().toISOString() })},
      'phone', 'call back today', current_date) returning id`;
  await sql`update os.calls set record_id = coalesce(record_id, ${r.id}), note = ${("Virtual assistant: " + summary).slice(0, 1000)} where id = ${cid}`;
  await sql`select os.alert(${c.business_id}, 'business', 'inquiry', ${`New call: ${name}${l.need ? " · " + l.need : ""}`.slice(0, 140)},
    ${`${name} called and the virtual assistant took the message.\n\n${summary}\n\nCall them back: ${phone}. The first business to call back usually wins the job.\n\nWhat was said:\n${lines.slice(0, 3000)}`}, ${"call:" + cid})`;
  await post(c.business_id, "system", `@demarcus The virtual assistant answered a call: #${r.id} ${name} (${phone}): "${summary.slice(0, 800)}" Make sure the owner calls them back today.`, { recordId: r.id });
}
