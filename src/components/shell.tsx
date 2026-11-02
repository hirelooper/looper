import { after } from "next/server";
import { tickUser } from "@/lib/agent";
import { read } from "@/lib/db";
import { inboxItems, metricDelta, metricNow, trend } from "@/lib/inbox";
import { isDue } from "@/lib/schedule";
import { areaOf } from "@/lib/types";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { billingEnabled, creditsLeft, hasAccess, isComped, onPaidPlan, PLANS } from "@/lib/billing";
import { hasHostedCredits, ownModelConnected } from "@/lib/llm";
import { currentUser } from "@/lib/session";
import { isAdmin } from "@/lib/usage";
import { getUser, getWorkspace, workspacesOf } from "@/lib/workspace";
import { Notices } from "./activity";
import { CommandPalette } from "./command-palette";
import { Sidebar, type PlanState } from "./sidebar";
import { fmt } from "./ui";

const OPEN_WITHOUT_PLAN = ["/billing", "/invite/", "/workspace", "/login", "/auth/"];

/** Signed-in frame: the looper rail on the left, the page on the right. Signed out: just the page. */
export async function Shell({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) return <main className="min-h-dvh">{children}</main>;
  const all = await workspacesOf(user);
  const ws = all.find((w) => w.id === user.ws) ?? (await getWorkspace(user.ws));
  const owner = ws && ws.ownerId !== user.id ? await getUser(ws.ownerId) : user;
  // Hosted without a plan: only choosing one (and joining or switching workspaces) is open.
  if (!hasAccess(ws)) {
    const path = (await headers()).get("x-pathname") ?? "/";
    if (!OPEN_WITHOUT_PLAN.some((p) => path.startsWith(p))) redirect("/billing");
    return <main className="min-h-dvh">{children}</main>;
  }
  const db = await read(user.ws);
  // Hosted, the cron only fires daily, so opening the app starts anything that came due since.
  const due = db.loopers.some((l) => l.status === "active" && l.skills.some((s) => isDue(s)) && !db.runs.some((r) => r.looperId === l.id && r.status === "running"));
  if (due) after(() => tickUser(user.ws).catch((e) => console.error("[tick]", e)));

  const inbox = inboxItems(db);
  const loopers = db.loopers.map((l) => {
    const value = metricNow(l);
    const t = trend(l, metricDelta(l, 7));
    return {
      id: l.id,
      name: l.name,
      color: l.color,
      metricName: l.metric.name,
      area: areaOf(l),
      paused: l.status === "paused",
      metric: value === undefined ? "No reading yet" : `${fmt(value)} now · target ${fmt(l.metric.target)}`,
      trend: t.text,
      running: db.runs.some((r) => r.looperId === l.id && r.status === "running"),
      needsYou: inbox.filter((i) => i.looperId === l.id).length,
      skills: l.skills.map((s) => ({ id: s.id, name: s.name })),
    };
  });
  // Claude credits (signup once, then the paid plan's monthly ones); show what's left, and invite your own plan until one is connected.
  const granted = ws?.credits?.granted ?? 0;
  const credits = hasHostedCredits() && granted > 0 ? { left: creditsLeft(ws), granted, invite: !ownModelConnected(db.settings) } : undefined;
  // Where the workspace stands on billing, so the rail can offer Upgrade or Manage subscription.
  const plan: PlanState | undefined = !billingEnabled()
    ? undefined
    : onPaidPlan(ws) && ws?.billing
      ? { kind: "paid", name: PLANS[ws.billing.plan].name, pastDue: ws.billing.status === "past_due", cancelAt: ws.billing.cancelAt }
      : isComped(ws, owner?.email)
        ? { kind: "comped" }
        : { kind: "free" };
  const lastChief = db.chief.filter((m) => m.role === "assistant").at(-1)?.content.replace(/\s+/g, " ").slice(0, 120);
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row">
      <Sidebar
        loopers={loopers}
        chiefPreview={lastChief}
        inboxCount={inbox.length}
        account={{ email: user.email, name: user.name, avatar: user.avatar }}
        workspace={{ id: user.ws, name: ws?.name ?? "Personal", kind: ws?.kind ?? "personal", plan: onPaidPlan(ws) && ws?.billing ? `${PLANS[ws.billing.plan].name} plan` : ws?.comped ? "Complimentary" : billingEnabled() ? "Free plan" : undefined }}
        workspaces={all.map((w) => ({ id: w.id, name: w.name, kind: w.kind }))}
        billing={billingEnabled()}
        credits={credits}
        plan={plan}
        isOwner={ws?.ownerId === user.id}
        admin={isAdmin(user.email)}
      />
      <main className="min-w-0 flex-1 lg:h-dvh lg:overflow-y-auto">{children}</main>
      <CommandPalette loopers={loopers.map(({ id, name, color, skills }) => ({ id, name, color, skills }))} />
      <Notices loopers={loopers.map(({ id, color }) => ({ id, color }))} />
    </div>
  );
}
