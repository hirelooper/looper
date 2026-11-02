import "server-only";
import Stripe from "stripe";
import { loopsContact, loopsEvent } from "./loops";
import { getUser, getWorkspace, mutateWorkspace, type CreditGrant, type Interval, type Plan, type Workspace } from "./workspace";

// Hosted plans. Without STRIPE_SECRET_KEY (self-hosted) everything is open and nothing is metered.
//   Free $0: unlimited loopers; AI runs on your own ChatGPT or Grok plan, or an API key.
//   Individual $19/month: everything in Free plus $19 of Claude credits every month.
//   Team $99/month: everything in Individual plus $99 of Claude credits a month and unlimited collaborators.
// Plan credits reset each billing period and don't roll over. Each workspace may spend up to $5 a month on computers and storage.
// Billed monthly; older yearly subscriptions keep working and are managed in the Stripe portal.

export const PLANS: Record<Plan, { name: string; usd: number; credits: number; who: string; lines: string[] }> = {
  personal: { name: "Individual", usd: 19, credits: 19, who: "For you, with Claude included", lines: ["Everything in Free", "$19 of Claude credits every month", "Your own plan or key works alongside"] },
  team: { name: "Team", usd: 99, credits: 99, who: "For teams who work with loopers together", lines: ["Everything in Individual", "$99 of Claude credits every month", "Unlimited collaborators, invite links"] },
};

export const FREE_PLAN = { name: "Free", usd: 0, who: "Bring your own subscription", lines: ["Unlimited loopers", "Kanban, calendar, approvals, weekly retro", "AI runs on your ChatGPT or Grok, or your API key"] };

// Each Stripe price is found by its lookup key; an env var with the price id overrides it.
const PRICE_ENV: Record<Plan, Record<Interval, string>> = {
  personal: { month: "STRIPE_PRICE_PERSONAL", year: "STRIPE_PRICE_PERSONAL_YEARLY" },
  team: { month: "STRIPE_PRICE_TEAM", year: "STRIPE_PRICE_TEAM_YEARLY" },
};
export const lookupKey = (plan: Plan, interval: Interval) => `looper_${plan}_${interval === "year" ? "yearly" : "monthly"}`;

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

/** On a paid plan right now (active, trialing or past due). */
export const onPaidPlan = (ws: Workspace | undefined) => !!ws?.billing && ACTIVE.has(ws.billing.status);

/** Free hosted access: flagged on the workspace, or the owner is in COMP_EMAILS. */
export const isComped = (ws: Workspace | undefined, ownerEmail?: string) => !!ws?.comped || (!!ownerEmail && compedEmails().includes(ownerEmail.toLowerCase()));

/** Can this workspace use the hosted app? Always: without a paid plan it's on Free and AI runs on your own plan or key. */
export function hasAccess(ws: Workspace | undefined) {
  return !billingEnabled() || !!ws;
}

const month = () => new Date().toISOString().slice(0, 7);
export const infraSpent = (ws: Workspace | undefined) => (ws?.infra?.month === month() ? ws.infra.usd : 0);

// — Metering —

// Hosted model calls are priced from the model catalog (./models) and spent here.

export async function spendCredits(wsId: string, usd: number) {
  if (!(usd > 0)) return;
  await mutateWorkspace(wsId, (w) => {
    w.credits = { granted: w.credits?.granted ?? 0, used: (w.credits?.used ?? 0) + usd };
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

async function priceOf(plan: Plan, interval: Interval) {
  const id = process.env[PRICE_ENV[plan][interval]];
  if (id) return id;
  const { data } = await stripe().prices.list({ lookup_keys: [lookupKey(plan, interval)], active: true, limit: 1 });
  if (!data[0]) throw new Error(`No Stripe price for ${PLANS[plan].name} (${interval}ly). Give one the lookup key ${lookupKey(plan, interval)} or set ${PRICE_ENV[plan][interval]}.`);
  return data[0].id;
}

const PLAN_PRICES = (Object.keys(PLANS) as Plan[]).flatMap((plan) => (["month", "year"] as Interval[]).map((interval) => ({ plan, interval })));

function planOfPrice(price?: Stripe.Price) {
  if (!price) return undefined;
  return PLAN_PRICES.find(({ plan, interval }) => process.env[PRICE_ENV[plan][interval]] === price.id || lookupKey(plan, interval) === price.lookup_key);
}

const isActive = (ws: Workspace) => !!ws.billing?.subscriptionId && ACTIVE.has(ws.billing.status);

export async function checkoutUrl(ws: Workspace, plan: Plan, interval: Interval, email: string | undefined, origin: string, template?: string) {
  // Already subscribed: changes happen in the portal, never in a second subscription.
  if (isActive(ws)) return portalUrl(ws, origin);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: await priceOf(plan, interval), quantity: 1 }],
    client_reference_id: ws.id,
    metadata: { workspaceId: ws.id, plan, interval },
    subscription_data: { metadata: { workspaceId: ws.id, plan, interval } },
    ...(ws.billing?.customerId ? { customer: ws.billing.customerId } : { customer_email: email }),
    allow_promotion_codes: true,
    success_url: `${origin}/billing?welcome=1${template ? `&template=${encodeURIComponent(template)}` : ""}`,
    cancel_url: `${origin}/billing?plan=${plan}&interval=${interval}`,
  });
  return session.url!;
}

export async function portalUrl(ws: Workspace, origin: string) {
  if (!ws.billing?.customerId) throw new Error("No subscription yet.");
  const s = await stripe().billingPortal.sessions.create({ customer: ws.billing.customerId, return_url: `${origin}/billing` });
  return s.url;
}

/**
 * Credits for a billing period: each new period resets to the plan's monthly credits (no rollover).
 * Moving to a bigger plan mid-period tops up the difference. Leftover signup credits carry into the first period.
 */
function refillCredits(w: Workspace, plan: Plan, period: string) {
  const c = w.credits;
  const monthly = PLANS[plan].credits;
  if (c?.period === period && c.plan === plan) return;
  if (c?.period === period && c.plan) {
    w.credits = { ...c, plan, granted: c.granted + Math.max(0, monthly - PLANS[c.plan].credits) };
    return;
  }
  const carry = c && !c.plan ? Math.max(0, c.granted - c.used) : 0;
  w.credits = { granted: monthly + carry, used: 0, plan, period };
}

/** Keep the workspace's plan in step with its Stripe subscription, and its credits in step with the billing period. */
export async function syncSubscription(sub: Stripe.Subscription) {
  const wsId = sub.metadata?.workspaceId;
  if (!wsId) return;
  const item = sub.items.data[0];
  const known = planOfPrice(item?.price);
  const plan = known?.plan ?? (sub.metadata.plan as Plan | undefined);
  if (!plan || !PLANS[plan]) return;
  const interval: Interval = known?.interval ?? (item?.price.recurring?.interval === "year" ? "year" : "month");
  const periodEnd = item?.current_period_end;
  const cancelAt = sub.cancel_at ?? (sub.cancel_at_period_end ? periodEnd : null);
  const before = (await getWorkspace(wsId))?.billing?.status;
  const ws = await mutateWorkspace(wsId, (w) => {
    w.billing = {
      plan,
      interval,
      status: sub.status,
      customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      subscriptionId: sub.id,
      periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
      cancelAt: cancelAt && sub.status !== "canceled" ? new Date(cancelAt * 1000).toISOString() : undefined,
    };
    if (ACTIVE.has(sub.status)) {
      const grants = new Set<CreditGrant>(w.creditGrants ?? []);
      grants.add(plan);
      w.creditGrants = [...grants];
      refillCredits(w, plan, w.billing.periodEnd ?? new Date().toISOString().slice(0, 7));
    } else if (sub.status === "canceled" && w.credits?.plan) {
      // Back on Free: plan credits end with the period that was paid for.
      w.credits = { granted: w.credits.used, used: w.credits.used };
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
