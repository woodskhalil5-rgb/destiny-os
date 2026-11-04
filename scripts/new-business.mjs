#!/usr/bin/env node
// Turns businesses/<slug>/business.json into SQL that creates (or updates) that business on Destiny OS.
// Usage: node scripts/new-business.mjs <slug> [--live] > out.sql   then run out.sql against the database.
// Re-running it for an existing business adds a new config version and makes it active (the old one stays for rollback).
import { readFileSync } from "node:fs";

const [slug, ...flags] = process.argv.slice(2);
if (!slug) { console.error("usage: node scripts/new-business.mjs <slug> [--live]"); process.exit(1); }
const b = JSON.parse(readFileSync(new URL(`../businesses/${slug}/business.json`, import.meta.url), "utf8"));
const q = (s) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);
const SLOTS = ["research", "analysis", "production", "coordination", "media", "distribution"];
const status = flags.includes("--live") ? "live" : "setup";

let out = `-- Destiny OS: deploy business "${b.slug}"\nbegin;\n`;
out += `insert into os.businesses (slug, name, status, timezone, shift_start, shift_end, shift_days)
values (${q(b.slug)}, ${q(b.name)}, ${q(status)}, ${q(b.timezone ?? "America/New_York")}, ${b.shift?.start ?? 9}, ${b.shift?.end ?? 18}, array[${(b.shift?.days ?? [1, 2, 3, 4, 5]).join(",")}])
on conflict (slug) do update set name = excluded.name, timezone = excluded.timezone, shift_start = excluded.shift_start, shift_end = excluded.shift_end, shift_days = excluded.shift_days;\n`;
out += `update os.business_config set active = false where business_id = (select id from os.businesses where slug = ${q(b.slug)});\n`;
out += `insert into os.business_config (business_id, version, config, note, active)
select id, coalesce((select max(version) from os.business_config c where c.business_id = b.id), 0) + 1, ${q(JSON.stringify(b.config))}::jsonb, 'deployed from businesses/${b.slug}/business.json', true
from os.businesses b where slug = ${q(b.slug)};\n`;
for (const slot of SLOTS) {
  const text = b.agents?.[slot];
  out += `insert into os.business_agents (business_id, slot, enabled, role_instructions)
select id, ${q(slot)}, ${text ? "true" : "false"}, ${q(text ?? "")} from os.businesses where slug = ${q(b.slug)}
on conflict (business_id, slot) do update set enabled = excluded.enabled, role_instructions = excluded.role_instructions;\n`;
}
for (const [provider, i] of Object.entries(b.integrations ?? {})) {
  out += `insert into os.integrations (business_id, provider, status, secret_names, settings)
select id, ${q(provider)}, 'not_connected', array[${(i.secrets ?? []).map((s) => q(s)).join(",")}]::text[], ${q(JSON.stringify(i.settings ?? {}))}::jsonb from os.businesses where slug = ${q(b.slug)}
on conflict (business_id, provider) do update set secret_names = excluded.secret_names, settings = excluded.settings;\n`;
}
out += `insert into os.activity_log (business_id, actor_type, actor, action, target)
select id, 'system', 'new-business', 'deploy-config', ${q(b.slug)} from os.businesses where slug = ${q(b.slug)};\ncommit;\n`;
process.stdout.write(out);
