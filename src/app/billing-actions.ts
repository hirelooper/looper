"use server";

import { headers } from "next/headers";
import { checkoutUrl, portalUrl } from "@/lib/billing";
import { requireSessionUser, setWorkspace } from "@/lib/session";
import { createTeamWorkspace, getWorkspace, type Interval, type Plan } from "@/lib/workspace";

async function origin() {
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
}

type Result = { ok: true; url: string } | { ok: false; error: string };
const fail = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

/**
 * Start checkout. Personal goes on your personal workspace; Team goes on the open team workspace
 * (a personal one turned into a team counts), or a new one named `teamName` when you're in your personal one.
 */
export async function startCheckout(plan: Plan, interval: Interval, teamName?: string, template?: string): Promise<Result> {
  try {
    const user = await requireSessionUser();
    let wsId = plan === "personal" ? user.id : user.ws;
    if (plan === "personal" && (await getWorkspace(wsId))?.kind === "team") throw new Error("Your personal workspace is a team now. Choose the Team plan.");
    if (plan === "team" && (await getWorkspace(wsId))?.kind !== "team") {
      wsId = (await createTeamWorkspace(user, teamName || "Team")).id;
      await setWorkspace(wsId);
    }
    const ws = await getWorkspace(wsId);
    if (!ws) throw new Error("Workspace not found.");
    if (ws.ownerId !== user.id) throw new Error("Only the workspace owner can change its plan.");
    return { ok: true, url: await checkoutUrl(ws, plan, interval === "year" ? "year" : "month", user.email, await origin(), template) };
  } catch (e) {
    return fail(e);
  }
}

export async function openBillingPortal(): Promise<Result> {
  try {
    const user = await requireSessionUser();
    const ws = await getWorkspace(user.ws);
    if (!ws || ws.ownerId !== user.id) throw new Error("Only the workspace owner can manage billing.");
    return { ok: true, url: await portalUrl(ws, await origin()) };
  } catch (e) {
    return fail(e);
  }
}
