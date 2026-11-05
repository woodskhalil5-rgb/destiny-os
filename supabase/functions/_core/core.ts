// Destiny OS core: database access, secrets, audit log, usage metering and the Claude call.
// Every function here takes a business id; nothing reads or writes across businesses.
import postgres from "npm:postgres@3.4.5";

export const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

export type Business = {
  id: string; slug: string; name: string; status: string; timezone: string;
  shift_start: number; shift_end: number; shift_days: number[]; model: string; monthly_budget_usd: number | null;
  markup_pct: number; platform_fee_usd: number; billing_status: string;
};
export type Agent = { slot: string; name: string; handle: string; personality: string; core_role: string; default_tools: string[]; sort: number };
export type BizAgent = Agent & { enabled: boolean; role_instructions: string; tools: string[] | null; model: string | null };

export async function business(id: string): Promise<Business | null> {
  const [b] = await sql`select * from os.businesses where id = ${id}`;
  return (b as Business) ?? null;
}

/** The active configuration for a business: mission, facts, rules, record types, approval rules. */
export async function config(bid: string): Promise<Record<string, any>> {
  const [c] = await sql`select config from os.business_config where business_id = ${bid} and active`;
  return (c?.config as Record<string, any>) ?? {};
}

export async function team(bid: string): Promise<BizAgent[]> {
  return await sql`
    select a.*, ba.enabled, ba.role_instructions, ba.tools, ba.model
    from os.agents a join os.business_agents ba on ba.slot = a.slot and ba.business_id = ${bid}
    order by a.sort` as unknown as BizAgent[];
}

export async function audit(bid: string | null, actorType: string, actor: string, action: string, target: string | null, details: unknown = {}) {
  await sql`insert into os.activity_log (business_id, actor_type, actor, action, target, details)
            values (${bid}, ${actorType}, ${actor}, ${action}, ${target}, ${sql.json(details as any)})`;
}

export async function post(bid: string, sender: string, body: string, opts: { depth?: number; status?: string; senderName?: string; taskId?: number; recordId?: number } = {}) {
  const [m] = await sql`insert into os.messages (business_id, sender, sender_name, body, depth, status, task_id, record_id)
    values (${bid}, ${sender}, ${opts.senderName ?? null}, ${body}, ${opts.depth ?? 0}, ${opts.status ?? "queued"}, ${opts.taskId ?? null}, ${opts.recordId ?? null})
    returning id`;
  return m.id as number;
}

/** Secrets live in Supabase Vault. Per-business secrets are named "<slug>:<NAME>". */
export async function secret(name: string): Promise<string | null> {
  const [s] = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name}`;
  return (s?.decrypted_secret as string) ?? null;
}
export async function bizSecret(b: Business, name: string) {
  return (await secret(`${b.slug}:${name}`)) ?? null;
}

export async function monthSpend(bid: string) {
  // What the customer has been billed for AI usage this month (our cost plus markup).
  const [r] = await sql`select coalesce(sum(billed_usd), 0) as usd from os.usage_events
    where business_id = ${bid} and at >= date_trunc('month', now())`;
  return Number(r.usd);
}

/** Calls Claude with the business's own key when it has one, and meters every call to that business. */
export async function claude(b: Business, slot: string, body: Record<string, any>, timeoutMs: number) {
  const key = (await bizSecret(b, "ANTHROPIC_API_KEY")) ?? Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("No Anthropic key: add ANTHROPIC_API_KEY (or <slug>:ANTHROPIC_API_KEY in the vault).");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(Math.max(5_000, timeoutMs)),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  const u = j.usage ?? {};
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  // Prompt caching: writing to the cache costs 1.25x the input price, reading from it 0.1x.
  const fresh = u.input_tokens ?? 0, cWrite = u.cache_creation_input_tokens ?? 0, cRead = u.cache_read_input_tokens ?? 0;
  const inTok = fresh + cWrite + cRead;
  const [p] = await sql`select * from os.model_prices where model = ${body.model}`;
  const inPrice = Number(p?.input_per_mtok ?? 0);
  const cost = p ? ((fresh + cWrite * 1.25 + cRead * 0.1) * inPrice + (u.output_tokens ?? 0) * Number(p.output_per_mtok ?? 0)) / 1e6 + searches * Number(p.web_search_per_k ?? 0) / 1000 : null;
  // billed = our cost plus this business's markup, fixed at the time of the call
  const billed = cost == null ? null : Math.round(cost * (1 + Number(b.markup_pct ?? 0) / 100) * 1e6) / 1e6;
  await sql`insert into os.usage_events (business_id, slot, model, input_tokens, output_tokens, web_searches, cost_usd, billed_usd, cache_write_tokens, cache_read_tokens)
            values (${b.id}, ${slot}, ${body.model}, ${inTok}, ${u.output_tokens ?? 0}, ${searches}, ${cost}, ${billed}, ${cWrite}, ${cRead})`;
  return j;
}

export function onShift(b: Business) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: b.timezone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date());
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.find((p) => p.type === "weekday")!.value) + 1;
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  return b.shift_days.includes(wd) && h >= b.shift_start && h < b.shift_end;
}
