"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { mutate } from "@/lib/db";
import { startOnboarding, switchOnboarding } from "@/lib/onboarding";
import { requireSessionUser, requireUid } from "@/lib/session";
import { getWorkspace } from "@/lib/workspace";

// Onboarding for a new workspace: Chief reads the business, picks the first metric, hires the
// looper for it and fills its table. The work runs after the response; /welcome polls /api/onboarding.

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Start from the website, or from the owner's own words when there's no site. */
export async function beginOnboarding(input: { url?: string; about?: string }) {
  return attempt(async () => {
    const user = await requireSessionUser();
    const url = input.url?.trim() || undefined;
    const about = input.about?.trim().slice(0, 600) || undefined;
    if (!url && (!about || about.length < 12)) throw new Error("Add your website, or say what you do in a sentence.");
    const ws = await getWorkspace(user.ws);
    const { done } = await startOnboarding(user.ws, { url, about, renameTeam: ws?.kind === "team" && ws.ownerId === user.id });
    after(() => done);
    return true as const;
  });
}

/** Hire for another of the suggested metrics instead. */
export async function switchMetric(pick: number) {
  return attempt(async () => {
    const uid = await requireUid();
    const { done } = await switchOnboarding(uid, pick);
    after(() => done);
    return true as const;
  });
}

/** Done or skipped: Chief stops sending this workspace to onboarding. */
export async function finishOnboarding() {
  return attempt(async () => {
    const uid = await requireUid();
    await mutate(uid, (db) => void (db.onboarded ??= new Date().toISOString()));
    revalidatePath("/", "layout");
    return true as const;
  });
}
