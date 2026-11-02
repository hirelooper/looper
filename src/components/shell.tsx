import { after } from "next/server";
import { tickUser } from "@/lib/agent";
import { read } from "@/lib/db";
import { inboxItems, metricDelta, metricNow, trend } from "@/lib/inbox";
import { isDue } from "@/lib/schedule";
import { areaOf } from "@/lib/types";
import { billingEnabled, creditsLeft } from "@/lib/billing";
import { hasHostedCredits, ownModelConnected } from "@/lib/llm";
import { currentUser } from "@/lib/session";
import { isAdmin } from "@/lib/usage";
import { getWorkspace, workspacesOf } from "@/lib/workspace";
import { Notices } from "./activity";
import { CommandPalette } from "./command-palette";
import { CrispChat } from "./crisp-chat";
import { Sidebar } from "./sidebar";
import { fmt } from "./ui";

/** Signed-in frame: the looper rail on the left, the page on the right. Signed out: just the page. */
export async function Shell({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const crispId = "430b1519-2896-4e80-bc81-bbad92f0c968"; // hirelooper.com Crisp workspace
  if (!user)
    return (
      <>
        <main className="min-h-dvh">{children}</main>
        <CrispChat websiteId={crispId} />
      </>
    );
  const all = await workspacesOf(user);
  const ws = all.find((w) => w.id === user.ws) ?? (await getWorkspace(user.ws));
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
  // Included Claude credits (signup, then each paid month); show what's left, and invite a plan until one is connected.
  const granted = ws?.credits?.granted ?? 0;
  const credits = hasHostedCredits() && granted > 0 ? { left: creditsLeft(ws), granted, invite: !ownModelConnected(db.settings) } : undefined;
  const lastChief = db.chief.filter((m) => m.role === "assistant").at(-1)?.content.replace(/\s+/g, " ").slice(0, 120);
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row">
      <Sidebar
        loopers={loopers}
        chiefPreview={lastChief}
        inboxCount={inbox.length}
        account={{ email: user.email, name: user.name, avatar: user.avatar }}
        workspace={{ id: user.ws, name: ws?.name ?? "Personal", kind: ws?.kind ?? "personal", plan: ws?.billing && ws.billing.status !== "canceled" ? (ws.billing.plan === "team" ? "Team plan" : "Individual plan") : ws?.comped ? "Complimentary" : billingEnabled() ? "Free plan" : undefined }}
        workspaces={all.map((w) => ({ id: w.id, name: w.name, kind: w.kind }))}
        billing={billingEnabled()}
        credits={credits}
        admin={isAdmin(user.email)}
      />
      <main className="min-w-0 flex-1 lg:h-dvh lg:overflow-y-auto">{children}</main>
      <CommandPalette loopers={loopers.map(({ id, name, color, skills }) => ({ id, name, color, skills }))} />
      <Notices loopers={loopers.map(({ id, color }) => ({ id, color }))} />
      <CrispChat websiteId={crispId} user={{ email: user.email, name: user.name, avatar: user.avatar, workspace: ws?.name }} />
    </div>
  );
}
