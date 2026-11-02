import { redirect } from "next/navigation";
import { billingEnabled, CREDIT_MARKUP, creditsLeft, INFRA_CAP_USD, infraSpent, onPaidPlan, PLANS } from "@/lib/billing";
import { requireUser } from "@/lib/session";
import { getUser, getWorkspace } from "@/lib/workspace";
import { BillingView } from "./view";

export default async function BillingPage({ searchParams }: PageProps<"/billing">) {
  const user = await requireUser();
  if (!billingEnabled()) redirect("/settings");
  const { plan, welcome, template } = await searchParams;
  const ws = await getWorkspace(user.ws);
  const owner = ws ? await getUser(ws.ownerId) : undefined;
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
      markup={CREDIT_MARKUP}
      infra={{ spent: infraSpent(ws), cap: INFRA_CAP_USD }}
      plans={Object.entries(PLANS).map(([id, p]) => ({ id: id as keyof typeof PLANS, name: p.name, usd: p.usd, credits: p.credits, blurb: p.blurb }))}
      want={plan === "team" || plan === "personal" ? plan : undefined}
      welcome={welcome === "1"}
      template={typeof template === "string" ? template : undefined}
    />
  );
}
