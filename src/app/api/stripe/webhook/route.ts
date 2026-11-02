import type Stripe from "stripe";
import { stripe, syncSubscription } from "@/lib/billing";

const subId = (s: string | { id: string } | null | undefined) => (typeof s === "string" ? s : s?.id);

/** Stripe tells us about subscriptions here; the signature proves it's Stripe. */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook not configured", { status: 501 });
  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(await request.text(), request.headers.get("stripe-signature") ?? "", secret);
  } catch {
    return new Response("Bad signature", { status: 400 });
  }
  switch (event.type) {
    case "checkout.session.completed": {
      const id = subId(event.data.object.subscription);
      if (id) await syncSubscription(await stripe().subscriptions.retrieve(id));
      break;
    }
    // Each paid month starts a new credit period; re-read the subscription so the reset never waits on another event.
    case "invoice.paid": {
      const id = subId(event.data.object.parent?.subscription_details?.subscription);
      if (id) await syncSubscription(await stripe().subscriptions.retrieve(id));
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object);
      break;
  }
  return Response.json({ received: true });
}
