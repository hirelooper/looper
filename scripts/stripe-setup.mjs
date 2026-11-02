// Create (or update) the Looper plans and the webhook in Stripe. Safe to run again.
//   STRIPE_SECRET_KEY=sk_… APP_URL=https://app.hirelooper.com node scripts/stripe-setup.mjs
// Plans are monthly. A price whose amount changed gets a new price that takes over the lookup key;
// the old one is archived (existing subscribers keep it until they switch).
// Prints the env vars to set: STRIPE_WEBHOOK_SECRET on first run (prices are found by lookup key).
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
const app = process.env.APP_URL?.replace(/\/$/, "");
if (!key || !app) throw new Error("Set STRIPE_SECRET_KEY and APP_URL.");
const stripe = new Stripe(key);

const PLANS = [
  { plan: "personal", lookup: "looper_personal_monthly", product: "looper_personal", name: "Looper Individual", usd: 19, desc: "Unlimited loopers for you. 19 Claude credits a month, reset monthly." },
  { plan: "team", lookup: "looper_team_monthly", product: "looper_team", name: "Looper Team", usd: 99, desc: "Unlimited collaborators and loopers. 99 Claude credits a month, reset monthly." },
];

const out = {};
for (const p of PLANS) {
  let product = await stripe.products.retrieve(p.product).catch(() => null);
  if (!product) product = await stripe.products.create({ id: p.product, name: p.name, description: p.desc });
  else await stripe.products.update(p.product, { name: p.name, description: p.desc, active: true });
  const found = (await stripe.prices.list({ lookup_keys: [p.lookup], limit: 1 })).data[0];
  if (found?.active && found.unit_amount === p.usd * 100 && found.recurring?.interval === "month") {
    console.log(`${p.name}: ${found.id} ($${p.usd}/mo) already set`);
    continue;
  }
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: p.usd * 100,
    recurring: { interval: "month" },
    lookup_key: p.lookup,
    transfer_lookup_key: true,
    nickname: `${p.name.replace("Looper ", "")}, $${p.usd}/mo`,
    metadata: { plan: p.plan, interval: "month" },
  });
  await stripe.products.update(product.id, { default_price: price.id });
  if (found && found.id !== price.id) await stripe.prices.update(found.id, { active: false });
  console.log(`${p.name}: ${price.id} ($${p.usd}/mo) created`);
}

// Yearly prices aren't sold anymore.
for (const lookup of ["looper_personal_yearly", "looper_team_yearly"]) {
  const old = (await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 })).data[0];
  if (old) {
    await stripe.prices.update(old.id, { active: false });
    console.log(`Archived ${lookup} (${old.id})`);
  }
}

const url = `${app}/api/stripe/webhook`;
const events = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid"];
const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === url);
if (existing) {
  await stripe.webhookEndpoints.update(existing.id, { enabled_events: events, disabled: false });
  console.log(`Webhook ${existing.id} for ${url} listens to: ${events.join(", ")}`);
} else {
  const hook = await stripe.webhookEndpoints.create({ url, enabled_events: events, description: "Looper subscriptions and monthly credits" });
  out.STRIPE_WEBHOOK_SECRET = hook.secret;
}

// Let customers manage their subscription, card and invoices.
const configs = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
if (!configs.data.length)
  await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Looper billing" },
    features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: "at_period_end" } },
  });

if (Object.keys(out).length) {
  console.log("\nSet these in Vercel (Production):");
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
}
console.log("\nAlso set STRIPE_SECRET_KEY in Vercel (Production): without it the app runs as self-hosted, with nothing billed or metered.");
