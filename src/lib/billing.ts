import "server-only";
import Stripe from "stripe";
import { loopsContact, loopsEvent } from "./loops";
import { getUser, getWorkspace, mutateWorkspace, type CreditGrant, type Plan, type Workspace } from "./workspace";

// Hosted plans. Without STRIPE_SECRET_KEY (self-hosted) everything is open and nothing is metered.
//   Free: bring your own ChatGPT or Grok plan, or an API key. Nothing billed by us.
//   Individual $19/month: 19 credits a month for Claude on our key.
//   Team $99/month: unlimited collaborators, 99 credits a month.
// Credits reset each billing month and don't roll over. One credit is $1 of usage at our prices,
// which carry a 100% markup on the model's list price: $0.40 of Claude spends 0.8 credits.
// Each workspace may spend up to $5 a month on computers and storage.

export const PLANS: Record<Plan, { name: string; usd: number; credits: number; blurb: string }> = {
  personal: { name: "Individual", usd: 19, credits: 19, blurb: "Unlimited loopers, just you" },
  team: { name: "Team", usd: 99, credits: 99, blurb: "Unlimited collaborators and loopers" },
};

/** Credits spent per USD of model list price. */
export const CREDIT_MARKUP = 2;
export const creditsOf = (usd: number) => usd * CREDIT_MARKUP;

// Each Stripe price is found by its lookup key; an env var with the price id overrides it.
const PRICE_ENV: Record<Plan, string> = { personal: "STRIPE_PRICE_PERSONAL", team: "STRIPE_PRICE_TEAM" };
export const lookupKey = (plan: Plan) => `looper_${plan}_monthly`;

export const INFRA_CAP_USD = 5;

export const billingEnabled = () => !!process.env.STRIPE_SECRET_KEY;

let stripeClient: Stripe | null = null;
export function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Billing isn't configured.");
  stripeClient ??= new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

const ACTIVE = new Set(["active", "trialing", "past_due"]);
const compedEmails = () => (process.env.COMP_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export const creditsLeft = (ws: Workspace | undefined) => Math.max(0, (ws?.credits?.granted ?? 0) - (ws?.credits?.used ?? 0));

/** On a paid plan (or comped)? Everyone else is on Free: the app is open, AI runs on their own plan or key. */
export function onPaidPlan(ws: Workspace | undefined, ownerEmail?: string) {
  if (!ws) return false;
  if (ws.comped || (ownerEmail && compedEmails().includes(ownerEmail.toLowerCase()))) return true;
  return !!ws.billing && ACTIVE.has(ws.billing.status);
}

const month = () => new Date().toISOString().slice(0, 7);
export const infraSpent = (ws: Workspace | undefined) => (ws?.infra?.month === month() ? ws.infra.usd : 0);

// — Metering —

// Hosted model calls are priced from the model catalog (./models) at list price; credits are spent with the markup.

export async function spendCredits(wsId: string, usd: number) {
  if (!(usd > 0)) return;
  await mutateWorkspace(wsId, (w) => {
    w.credits = { ...w.credits, granted: w.credits?.granted ?? 0, used: (w.credits?.used ?? 0) + creditsOf(usd) };
  });
}

/** Machines and storage this month; refused past the monthly cap. */
export async function spendInfra(wsId: string, usd: number) {
  if (!billingEnabled() || !(usd > 0)) return;
  await mutateWorkspace(wsId, (w) => {
    const m = month();
    w.infra = { month: m, usd: (w.infra?.month === m ? w.infra.usd : 0) + usd };
  });
}

export async function assertInfraBudget(wsId: string) {
  if (!billingEnabled()) return;
  const ws = await getWorkspace(wsId);
  if (ws?.comped) return;
  if (infraSpent(ws) >= INFRA_CAP_USD)
    throw new Error(`This workspace used its $${INFRA_CAP_USD} of computer time for this month. The computer is back on the 1st; apps, boards and chat keep working.`);
}

// — Stripe —

async function priceOf(plan: Plan) {
  const id = process.env[PRICE_ENV[plan]];
  if (id) return id;
  const { data } = await stripe().prices.list({ lookup_keys: [lookupKey(plan)], active: true, limit: 1 });
  if (!data[0]) throw new Error(`No Stripe price for ${PLANS[plan].name}. Give one the lookup key ${lookupKey(plan)} or set ${PRICE_ENV[plan]}.`);
  return data[0].id;
}

function planOfPrice(price?: Stripe.Price) {
  if (!price) return undefined;
  return (Object.keys(PLANS) as Plan[]).find((plan) => process.env[PRICE_ENV[plan]] === price.id || lookupKey(plan) === price.lookup_key);
}

const isActive = (ws: Workspace) => !!ws.billing?.subscriptionId && ACTIVE.has(ws.billing.status);

export async function checkoutUrl(ws: Workspace, plan: Plan, email: string | undefined, origin: string, template?: string) {
  // Already subscribed: changes happen in the portal, never in a second subscription.
  if (isActive(ws)) return portalUrl(ws, origin);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: await priceOf(plan), quantity: 1 }],
    client_reference_id: ws.id,
    metadata: { workspaceId: ws.id, plan },
    subscription_data: { metadata: { workspaceId: ws.id, plan } },
    ...(ws.billing?.customerId ? { customer: ws.billing.customerId } : { customer_email: email }),
    allow_promotion_codes: true,
    success_url: `${origin}/billing?welcome=1${template ? `&template=${encodeURIComponent(template)}` : ""}`,
    cancel_url: `${origin}/billing?plan=${plan}`,
  });
  return session.url!;
}

export async function portalUrl(ws: Workspace, origin: string) {
  if (!ws.billing?.customerId) throw new Error("No subscription yet.");
  const s = await stripe().billingPortal.sessions.create({ customer: ws.billing.customerId, return_url: `${origin}/billing` });
  return s.url;
}

/**
 * Keep the workspace's plan in step with its Stripe subscription. Each billing month starts with the
 * plan's credits; what's left of the last month doesn't carry over. A subscription that ended has none.
 */
export async function syncSubscription(sub: Stripe.Subscription) {
  const wsId = sub.metadata?.workspaceId;
  if (!wsId) return;
  const item = sub.items.data[0];
  const plan = planOfPrice(item?.price) ?? (sub.metadata.plan as Plan | undefined);
  if (!plan || !PLANS[plan]) return;
  const periodStart = item?.current_period_start;
  const periodEnd = item?.current_period_end;
  const cancelAt = sub.cancel_at ?? (sub.cancel_at_period_end ? periodEnd : null);
  const before = (await getWorkspace(wsId))?.billing?.status;
  const ws = await mutateWorkspace(wsId, (w) => {
    // A late webhook for an older subscription must not overwrite the current one.
    if (w.billing?.subscriptionId && w.billing.subscriptionId !== sub.id && ACTIVE.has(w.billing.status) && !ACTIVE.has(sub.status)) return { ...w };
    w.billing = {
      plan,
      interval: "month",
      status: sub.status,
      customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      subscriptionId: sub.id,
      periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
      cancelAt: cancelAt && sub.status !== "canceled" ? new Date(cancelAt * 1000).toISOString() : undefined,
    };
    if (ACTIVE.has(sub.status)) {
      const period = periodStart ? new Date(periodStart * 1000).toISOString() : (w.credits?.period ?? new Date().toISOString());
      const c = w.credits;
      if (c?.period !== period) w.credits = { granted: PLANS[plan].credits, used: 0, period, plan };
      // Changed plan mid-month: the new allowance, minus what this month already used.
      else if (c.plan !== plan) w.credits = { ...c, granted: PLANS[plan].credits, plan };
      const grants = new Set<CreditGrant>(w.creditGrants ?? []);
      grants.add(plan);
      w.creditGrants = [...grants];
    } else if (w.credits?.plan) {
      // The paid month is over: its credits go with it.
      w.credits = { granted: 0, used: 0 };
    }
    return { ...w };
  });
  // Tell Loops when a plan starts or ends, so its loops can welcome or win back the owner.
  const owner = await getUser(ws.ownerId);
  if (!owner?.email) return;
  const active = ACTIVE.has(sub.status);
  if (active !== (before !== undefined && ACTIVE.has(before))) {
    loopsContact(owner, { plan: active ? plan : "none" });
    loopsEvent(owner.email, active ? "subscribed" : "subscription_ended", { plan });
  }
}
