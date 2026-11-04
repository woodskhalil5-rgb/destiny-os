# Destiny OS

One platform, six agents, any business. Build once, configure for each business, deploy repeatedly.

## The six agents (defined once, in `os.agents`)

| Handle | Agent | Core job |
| --- | --- | --- |
| @james | James | Research and sourcing |
| @emily | Emily | Analysis and intelligence |
| @kole | Kole | Documentation, production, direct written outreach |
| @demarcus | DeMarcus | Communications, coordination, owner reporting |
| @grayson | Grayson | Media production, scheduling and publishing |
| @benjamin | Benjamin | Distribution and customer/community outreach |

A business never changes the six slots, names or personalities. It only adds job instructions, facts, rules, record types, approval rules and integrations.

## Layout

```
businesses/<slug>/business.json   one file per business: mission, facts, rules, record types, agents' jobs, integrations
supabase/migrations/              the database (schema "os"), versioned
supabase/functions/_core/         shared runtime: db, vault secrets, audit, usage metering, tools, integrations
supabase/functions/os-brain/      router + agent workers (every business)
supabase/functions/os-api/        dashboard backend (sign-in, per-business roles)
scripts/new-business.mjs          business.json -> SQL that creates or updates the business
apps/dashboard/                   the web app (one app, business switcher)
```

## Deploy a new business

1. Write `businesses/<slug>/business.json` (copy `businesses/acquisition/business.json`).
2. `node scripts/new-business.mjs <slug> > deploy.sql` and run it against the database. The business starts in `setup`.
3. Put its secrets in Supabase Vault as `<slug>:<NAME>` (for example `jhp:GMAIL_APP_PASSWORD`), then mark the integration `connected`.
4. Add people: `insert into os.business_members (business_id, user_id, role)`; roles are owner, admin, operator, viewer.
5. Flip `os.businesses.status` to `live`. Shifts and hourly check-ins start in its timezone.

Re-running step 2 adds a new config version and makes it active; older versions stay for rollback.

## Security

- Every business row carries `business_id`; row-level security limits signed-in people to businesses they belong to. The `os` schema is not exposed to the public API at all; the dashboard goes through `os-api`, which checks the person's role on every action.
- Secrets live only in Supabase Vault, named per business.
- `os.activity_log` is append-only (a trigger blocks updates and deletes).
- Emails, offers, publishing and spend go through `os.approvals`. An agent can approve a kind only after the owner has made the configured number of decisions on it, and within the configured daily limit.
- Every Claude call is metered to its business in `os.usage_events`; a business can have a monthly budget that pauses its agents.

## Ownership

The source, the Supabase project, the Vercel project and the Anthropic organization belong to the owner. Keys are never committed to this repo.
