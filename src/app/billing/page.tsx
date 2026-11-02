import { redirect } from "next/navigation";
import { billingEnabled, creditsLeft, FREE_PLAN, INFRA_CAP_USD, infraSpent, isComped, onPaidPlan, PLANS } from "@/lib/billing";
import { requireUser } from "@/lib/session";
import { getUser, getWorkspace } from "@/lib/workspace";
import { BillingView } from "./view";

export default async function BillingPage({ searchParams }: PageProps<"/billing">) {
  const user = await requireUser();
  if (!billingEnabled()) redirect("/settings");
  const { plan, welcome, template } = await searchParams;
  const ws = await getWorkspace(user.ws);
  const owner = ws ? await getUser(ws.ownerId) : undefined;
  const paid = onPaidPlan(ws) && ws?.billing ? ws.billing : undefined;
  return (
    <BillingView
      workspace={{ name: ws?.name ?? "Personal", kind: ws?.kind ?? "personal", isOwner: ws?.ownerId === user.id }}
      current={paid ? paid.plan : isComped(ws, owner?.email) ? "comped" : "free"}
      subscription={
        paid
          ? { plan: paid.plan, interval: paid.interval ?? "month", status: paid.status, periodEnd: paid.periodEnd, cancelAt: paid.cancelAt }
          : null
      }
      hasCustomer={!!ws?.billing?.customerId}
      credits={{ left: creditsLeft(ws), granted: ws?.credits?.granted ?? 0, monthly: !!paid && !!ws?.credits?.plan }}
      infra={{ spent: infraSpent(ws), cap: INFRA_CAP_USD }}
      free={FREE_PLAN}
      plans={(Object.keys(PLANS) as (keyof typeof PLANS)[]).map((id) => ({ id, ...PLANS[id] }))}
      want={plan === "team" || plan === "personal" ? plan : undefined}
      welcome={welcome === "1"}
      template={typeof template === "string" ? template : undefined}
    />
  );
}
