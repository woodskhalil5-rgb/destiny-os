// os-billing: the monthly invoice run (called by pg_cron on the 1st) and the Stripe webhook.
// Each business with a Stripe customer is invoiced for last month: platform fee + AI team usage + other charges,
// exactly the lines on its Costs tab. A failed payment puts the team on hold until it's paid.
import { audit, post, secret, sql } from "../_core/core.ts";
import { stripe, stripeAccount, verifyWebhook } from "../_core/stripe.ts";

// JHP's contractor billing lives on the Destiny Marketing Group account; Destiny OS never configures it.
const FORBIDDEN_ACCOUNTS = ["acct_1UWNu2ISquyuV0hE"];
const EVENTS = ["checkout.session.completed", "invoice.paid", "invoice.payment_failed", "invoice.overdue", "invoice.finalized",
  "invoice.updated", "invoice.voided", "invoice.marked_uncollectible"];
const cents = (usd: number) => Math.round(Number(usd) * 100);

async function billBusiness(b: any, month: string) {
  const label = new Date(month + "T12:00:00Z").toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const [done] = await sql`select stripe_invoice_id, status from os.invoices where business_id = ${b.id} and month = ${month}`;
  if (done?.stripe_invoice_id && done.status !== "draft") return `already invoiced (${done.status})`;
  const lines = (await sql`select * from os.month_bill(${b.id}, ${month}::date)`).filter((l: any) => cents(l.amount_usd) > 0);
  if (!lines.length) return "nothing to bill";

  const cust = await stripe("GET", `customers/${b.stripe_customer_id}`);
  const hasCard = !!cust.invoice_settings?.default_payment_method;
  const inv = await stripe("POST", "invoices", {
    customer: b.stripe_customer_id,
    collection_method: hasCard ? "charge_automatically" : "send_invoice",
    days_until_due: hasCard ? undefined : 7,
    auto_advance: true,
    pending_invoice_items_behavior: "exclude",
    description: `Destiny OS: ${b.name}, ${label}`,
    metadata: { business_id: b.id, month },
  }, `inv-${b.id}-${month}`);
  await sql`insert into os.invoices (business_id, month, stripe_invoice_id, status) values (${b.id}, ${month}, ${inv.id}, 'draft')
    on conflict (business_id, month) do update set stripe_invoice_id = excluded.stripe_invoice_id, updated_at = now()`;

  for (const [i, l] of lines.entries()) {
    await stripe("POST", "invoiceitems", {
      customer: b.stripe_customer_id, invoice: inv.id, currency: "usd",
      amount: cents(l.amount_usd), description: `${l.line} (${label})`,
    }, `item-${b.id}-${month}-${i}`);
  }
  let fin = await stripe("POST", `invoices/${inv.id}/finalize`, { auto_advance: true }, `fin-${b.id}-${month}`);
  if (!hasCard) fin = await stripe("POST", `invoices/${inv.id}/send`, {}, `send-${b.id}-${month}`);
  await sql`update os.invoices set status = ${fin.status}, amount_usd = ${fin.total / 100}, hosted_url = ${fin.hosted_invoice_url ?? null}, updated_at = now() where stripe_invoice_id = ${inv.id}`;
  await audit(b.id, "system", "billing", "invoice", inv.id, { month, total_usd: fin.total / 100, auto_charge: hasCard });
  await post(b.id, "system", `${label} invoice: $${(fin.total / 100).toFixed(2)}. ${hasCard ? "It will be charged to the card on file." : "It was emailed with a payment link (due in 7 days). Add a card on the Costs tab to pay automatically."}`, { status: "handled" });
  return `invoiced $${(fin.total / 100).toFixed(2)}`;
}

async function runMonth(monthOverride?: string) {
  const [{ m }] = await sql`select to_char(coalesce(${monthOverride ?? null}::date, (date_trunc('month', now() at time zone 'America/New_York') - interval '1 month')::date), 'YYYY-MM-01') as m`;
  const list = await sql`select * from os.businesses where stripe_customer_id is not null and status <> 'archived'`;
  const results: Record<string, string> = {};
  for (const b of list) {
    try { results[b.slug] = await billBusiness(b, m); }
    catch (e) {
      results[b.slug] = `failed: ${(e as Error).message}`;
      await audit(b.id, "system", "billing", "invoice_error", m, { error: (e as Error).message });
      await sql`select os.alert(${b.id}, 'platform', 'invoice_error', ${b.name + ": monthly invoice failed"}, ${`The ${m} invoice for ${b.name} couldn't be created: ${(e as Error).message}`}, ${"inv:" + b.id + ":" + m})`;
    }
  }
  await audit(null, "system", "billing", "run_month", m, results);
  return results;
}

async function onEvent(ev: any) {
  const o = ev.data.object;
  if (ev.type === "checkout.session.completed" && o.mode === "setup") {
    const [b] = await sql`select * from os.businesses where id = ${o.client_reference_id ?? o.metadata?.business_id ?? null} and stripe_customer_id = ${o.customer}`;
    if (!b) return;
    const si = await stripe("GET", `setup_intents/${o.setup_intent}`);
    await stripe("POST", `customers/${o.customer}`, { invoice_settings: { default_payment_method: si.payment_method } });
    await audit(b.id, "system", "billing", "card_saved", o.customer);
    // A new card settles anything still open.
    const open = await stripe("GET", "invoices", { customer: o.customer, status: "open", limit: 10 });
    for (const inv of open.data ?? []) { try { await stripe("POST", `invoices/${inv.id}/pay`, { payment_method: si.payment_method }); } catch { /* the failure event follows */ } }
    if (!(open.data ?? []).length) await sql`update os.businesses set billing_status = 'active' where id = ${b.id}`;
    await post(b.id, "system", b.pay_to_start && !b.fee_paid_until
      ? "Card on file saved. To start your team, pay your first month on the Money tab."
      : "Card on file saved. Invoices will be charged to it automatically.", { status: "handled" });
    return;
  }
  // The first month, paid at sign-up (os-signup pay_start): covers 30 days of platform fee, saves the card, unlocks Start team.
  if (ev.type === "checkout.session.completed" && o.mode === "payment" && o.metadata?.kind === "first_month") {
    if (o.payment_status !== "paid") return;
    const [b] = await sql`select * from os.businesses where id = ${o.client_reference_id ?? o.metadata?.business_id ?? null} and stripe_customer_id = ${o.customer}`;
    if (!b) return;
    const pi = await stripe("GET", `payment_intents/${o.payment_intent}`);
    if (pi.payment_method) await stripe("POST", `customers/${o.customer}`, { invoice_settings: { default_payment_method: pi.payment_method } });
    const [upd] = await sql`update os.businesses set fee_paid_until = now() + interval '30 days', billing_status = 'active'
      where id = ${b.id} and fee_paid_until is null returning fee_paid_until`;
    if (!upd) return; // already recorded
    const paid = (o.amount_total ?? 0) / 100;
    await audit(b.id, "system", "billing", "first_month_paid", o.payment_intent, { usd: paid });
    await post(b.id, "system", `Payment received: $${paid.toFixed(2)} for your first 30 days. Your card is saved for the monthly invoices. Click Start team whenever you're ready.`, { status: "handled" });
    await sql`select os.alert(${b.id}, 'platform', 'first_payment', ${b.name + " paid their first month"}, ${`${b.name} paid $${paid.toFixed(2)} for their first 30 days. Their team can start now.`}, ${"paid1:" + b.id})`;
    return;
  }
  if (!ev.type.startsWith("invoice.")) return;
  await sql`update os.invoices set status = ${o.status}, amount_usd = ${o.total / 100}, hosted_url = ${o.hosted_invoice_url ?? null}, updated_at = now() where stripe_invoice_id = ${o.id}`;
  const [b] = await sql`select * from os.businesses where stripe_customer_id = ${o.customer}`;
  if (!b) return;
  if (ev.type === "invoice.paid") {
    await audit(b.id, "system", "billing", "invoice_paid", o.id, { total_usd: o.total / 100 });
    const [open] = await sql`select 1 from os.invoices where business_id = ${b.id} and status in ('open','uncollectible')`;
    if (!open && b.billing_status !== "active") {
      await sql`update os.businesses set billing_status = 'active' where id = ${b.id}`;
      if (b.billing_status === "past_due") await post(b.id, "system", "Payment received. The team is back to work.", { status: "handled" });
    }
  }
  if (ev.type === "invoice.payment_failed" || ev.type === "invoice.overdue") {
    await sql`update os.businesses set billing_status = 'past_due' where id = ${b.id}`;
    await audit(b.id, "system", "billing", ev.type, o.id, { total_usd: o.total / 100 });
    if (b.billing_status !== "past_due") await post(b.id, "system", `Payment of $${(o.total / 100).toFixed(2)} didn't go through. The team is on hold until it's paid: update the card on the Costs tab.`, { status: "handled" });
  }
}

Deno.serve(async (req) => {
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (sig) {
    if (!(await verifyWebhook(raw, sig))) return new Response("bad signature", { status: 400 });
    const ev = JSON.parse(raw);
    const [fresh] = await sql`insert into os.stripe_events (id, type) values (${ev.id}, ${ev.type}) on conflict do nothing returning id`;
    if (!fresh) return new Response("ok");
    try { await onEvent(ev); }
    catch (e) { await sql`delete from os.stripe_events where id = ${ev.id}`; return new Response((e as Error).message, { status: 500 }); } // Stripe retries
    return new Response("ok");
  }
  // Monthly run: only the database's cron job holds this key.
  const key = await secret("OS_INVOKE_KEY");
  if (!key || (req.headers.get("authorization") ?? "") !== `Bearer ${key}`) return new Response("forbidden", { status: 403 });
  const body = JSON.parse(raw || "{}");
  const out = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  if (body.action === "stripe_status") {
    try { return out(await stripeAccount()); } catch (e) { return out({ error: (e as Error).message }, 502); }
  }
  if (body.action === "setup_webhook") {
    // Creates this platform's webhook endpoint on the connected Stripe account and keeps its signing secret in the vault.
    // Refuses the JHP / Destiny Marketing Group account so the two billing systems never share events.
    const acct = await stripeAccount();
    if (FORBIDDEN_ACCOUNTS.includes(acct.id) || /destiny marketing group/i.test(acct.name)) return out({ error: `refusing: key belongs to ${acct.name} (${acct.id})` }, 409);
    const name = `OS_STRIPE_WEBHOOK_SECRET_${acct.mode}`;
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/os-billing`;
    const existing = (await stripe("GET", "webhook_endpoints", { limit: 100 })).data?.find((w: any) => w.url === url);
    const [have] = await sql`select id from vault.secrets where name = ${name}`;
    if (existing && have) return out({ ok: true, account: acct, endpoint: existing.id, note: "already set up" });
    if (existing) await stripe("POST", `webhook_endpoints/${existing.id}`, { disabled: true }); // secret unknown; replace it
    const we = await stripe("POST", "webhook_endpoints", { url, description: "Destiny OS billing", enabled_events: EVENTS }, `we-${acct.id}-${acct.mode}-${Date.now()}`);
    if (have) await sql`select vault.update_secret(${have.id}, ${we.secret})`;
    else await sql`select vault.create_secret(${we.secret}, ${name}, 'Stripe webhook signing secret for Destiny OS billing')`;
    await audit(null, "system", "billing", "setup_webhook", we.id, { account: acct.id, mode: acct.mode });
    return out({ ok: true, account: acct, endpoint: we.id, events: we.enabled_events });
  }
  if (body.action !== "run_month") return new Response("unknown action", { status: 400 });
  const results = await runMonth(body.month);
  return new Response(JSON.stringify(results), { headers: { "content-type": "application/json" } });
});
