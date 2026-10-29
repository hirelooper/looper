"use server";

import { after } from "next/server";
import { beginLooperReply } from "@/lib/agent";
import { finishTakeover, pingTakeover, startTakeover, takeoverOpen, wipeComputer } from "@/lib/computer";
import { mutate, read } from "@/lib/db";
import { requireSessionUser, requireUid } from "@/lib/session";
import { authorIn } from "@/lib/workspace";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function ownLooper(looperId: string) {
  const uid = await requireUid();
  const looper = (await read(uid)).loopers.find((l) => l.id === looperId);
  if (!looper) throw new Error("Looper not found");
  return { uid, looper };
}

export async function resetComputer(looperId: string) {
  const { uid } = await ownLooper(looperId);
  await wipeComputer(uid, looperId);
  return { ok: true };
}

/** Take over the looper's browser: returns the live view's address (and reuses a take-over already running). */
export async function beginTakeover(looperId: string, askId?: string) {
  return attempt(async () => {
    const { uid } = await ownLooper(looperId);
    const ask = askId ? (await read(uid)).asks.find((a) => a.id === askId && a.looperId === looperId) : undefined;
    const t = await startTakeover(uid, looperId, { askId: ask?.id, url: ask?.url });
    return { ws: t.ws, expiresAt: t.expiresAt, question: ask?.question };
  });
}

/** The take-over view is still open. False once the take-over has ended. */
export async function keepTakeover(looperId: string) {
  return attempt(async () => {
    const { uid } = await ownLooper(looperId);
    return pingTakeover(uid, looperId);
  });
}

export async function openInTakeover(looperId: string, url: string) {
  return attempt(async () => {
    const { uid } = await ownLooper(looperId);
    await takeoverOpen(uid, looperId, url);
    return true as const;
  });
}

/** Hand the browser back; the looper hears about it in chat and carries on. */
export async function endTakeover(looperId: string, note?: string) {
  return attempt(async () => {
    const { uid, looper } = await ownLooper(looperId);
    const { askId, url } = await finishTakeover(uid, looperId);
    const ask = askId
      ? await mutate(uid, (db) => {
          const a = db.asks.find((x) => x.id === askId);
          if (a && a.status === "open") Object.assign(a, { status: "answered", answer: "Done", answeredAt: new Date().toISOString() });
          return a;
        })
      : undefined;
    const user = await requireSessionUser();
    const text = [
      ask ? `${ask.question}\n→ Done: I used your browser and handed it back.` : `I used your browser and handed it back${url ? ` (last page: ${url})` : ""}.`,
      note?.trim(),
      "Logins I made there are saved in your browser now. Carry on from where you stopped.",
    ]
      .filter(Boolean)
      .join("\n");
    // In a shared workspace, say which teammate it was.
    const reply = await beginLooperReply(uid, looper.id, text, await authorIn(user.ws, user));
    after(reply);
    return { since: reply.since };
  });
}
