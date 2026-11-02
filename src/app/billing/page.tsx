import { redirect } from "next/navigation";
import { billingEnabled, creditsLeft, INFRA_CAP_USD, infraSpent, onPaidPlan, PLANS } from "@/lib/billing";
import { requireUser } from "@/lib/session";
import { PROVIDERS, providerReady } from "@/lib/types";
import { getState } from "../actions";
import { getUser, getWorkspace } from "@/lib/workspace";
import { BillingView } from "./view";

export default async function BillingPage({ searchParams }: PageProps<"/billing">) {
  const user = await requireUser();
  if (!billingEnabled()) redirect("/settings");
  const { plan, welcome, template } = await searchParams;
  const ws = await getWorkspace(user.ws);
  const owner = ws ? await getUser(ws.ownerId) : undefined;
  const { settings } = await getState();
  // The AI this workspace already runs on outside included credits, e.g. ["Grok", "ChatGPT"].
  const ownAI = PROVIDERS.filter((p) => (settings.authMode[p.id] ?? (settings.subscriptions[p.id] ? "oauth" : "key")) !== "credits" && providerReady(settings, p.id)).map((p) =>
    settings.subscriptions[p.id] && (settings.authMode[p.id] ?? "oauth") === "oauth" ? p.plan : `${p.label} key`,
  );
  return (
    <BillingView
      workspace={{ name: ws?.name ?? "Personal", kind: ws?.kind ?? "personal", isOwner: ws?.ownerId === user.id }}
      billing={
        ws?.billing
          ? { plan: ws.billing.plan, status: ws.billing.status, periodEnd: ws.billing.periodEnd, cancelAt: ws.billing.cancelAt, hasCustomer: !!ws.billing.customerId }
          : null
      }
      paid={onPaidPlan(ws, owner?.email)}
      comped={!!ws?.comped}
      credits={{ left: creditsLeft(ws), granted: ws?.credits?.granted ?? 0, monthly: !!ws?.credits?.plan }}
      infra={{ spent: infraSpent(ws), cap: INFRA_CAP_USD }}
      ownAI={ownAI}
      plans={Object.entries(PLANS).map(([id, p]) => ({ id: id as keyof typeof PLANS, name: p.name, usd: p.usd, credits: p.credits, blurb: p.blurb }))}
      want={plan === "team" || plan === "personal" ? plan : undefined}
      welcome={welcome === "1"}
      template={typeof template === "string" ? template : undefined}
    />
  );
}
