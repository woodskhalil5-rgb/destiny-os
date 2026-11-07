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
| @nora | Nora | Money: jobs won, open quotes, unpaid invoices and reminders (Benjamin, Distribution, retired: his partner work moved to James and Kole) |

A business never changes the six slots, names or personalities. It only adds job instructions, facts, rules, record types, approval rules and integrations.

## Layout

```
businesses/<slug>/business.json   one file per business: mission, facts, rules, record types, agents' jobs, integrations
supabase/migrations/              the database (schema "os"), versioned
supabase/functions/_core/         shared runtime: db, vault secrets, audit, usage metering, tools, integrations
supabase/functions/os-brain/      router + agent workers (every business)
supabase/functions/os-api/        dashboard backend (sign-in, roles, settings, connections, billing, new businesses)
supabase/functions/os-billing/    monthly Stripe invoices (1st of the month) + Stripe webhook
supabase/functions/os-jobs/       every 5 minutes: alert emails, publishing due content, watching connected inboxes
scripts/new-business.mjs          business.json -> SQL that creates or updates the business
apps/dashboard/                   the web app (one app, business switcher) + terms/privacy pages
.github/workflows/deploy.yml      deploys functions and dashboard on every push to main
```

## Add a new business

From the dashboard (platform owner): **+ New business** → name, owner's email, what they do, facts, rules, prices.
That creates the business with its own team, data and billing, and emails the owner a sign-in link.
The owner then fills in **Settings**, connects email under **Connections**, adds a card on **Costs**, and clicks **Start team**.

The older file-based way still works:

1. Write `businesses/<slug>/business.json` (copy `businesses/acquisition/business.json`).
2. `node scripts/new-business.mjs <slug> > deploy.sql` and run it against the database. The business starts in `setup`.
3. Put its secrets in Supabase Vault as `<slug>:<NAME>` (for example `jhp:GMAIL_APP_PASSWORD`), then mark the integration `connected`.
4. Add people: `insert into os.business_members (business_id, user_id, role)`; roles are owner, admin, operator, viewer.
5. Flip `os.businesses.status` to `live`. Shifts and hourly check-ins start in its timezone.

Re-running step 2 adds a new config version and makes it active; older versions stay for rollback.

## Running it

| Thing | Where |
| --- | --- |
| Dashboard | https://app.destinymarketinggroup.com (Vercel project `destiny-os`, root `apps/dashboard`) |
| Database + functions | Supabase project `destiny-realty-intel` (`xicywfiquzqvlulwirln`), schema `os` |
| Billing | Stripe account "Destiny OS Marketing"; key in the function secret `OS KEY`; webhook secret in the vault |
| Platform email | Resend when the `OS_RESEND_API_KEY` function secret is set (from `OS_MAIL_FROM` in the vault), else Gmail |
| Cron | `os-hourly` (shifts), `os-watchdog`, `os-jobs` (every 5 min), `os-monthly-billing` (1st, 9 AM ET) |

Each business starts with a $650/month platform fee, a 30% markup on AI usage and a $200/month AI budget (the team rests
when it's reached; owners are emailed at 80%). Failed payments put the team on hold until paid.

## Security

- Every business row carries `business_id`; row-level security limits signed-in people to businesses they belong to. The `os` schema is not exposed to the public API at all; the dashboard goes through `os-api`, which checks the person's role on every action.
- Secrets live only in Supabase Vault, named per business.
- `os.activity_log` is append-only (a trigger blocks updates and deletes).
- Emails, offers, publishing and spend go through `os.approvals`. An agent can approve a kind only after the owner has made the configured number of decisions on it, and within the configured daily limit.
- Every Claude call is metered to its business in `os.usage_events`; a business can have a monthly budget that pauses its agents.

## Ownership

The source, the Supabase project, the Vercel project and the Anthropic organization belong to the owner. Keys are never committed to this repo.
