"use server";

import { headers } from "next/headers";
import { requireSessionUser, setWorkspace } from "@/lib/session";
import { acceptInvite, createInvite, createTeamWorkspace, getWorkspace, makeTeam, removeMember, renameWorkspace, roleIn } from "@/lib/workspace";

async function origin() {
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
}

export async function switchWorkspace(id: string) {
  const user = await requireSessionUser();
  if (id !== user.id && !(await roleIn(id, user.id))) throw new Error("You're not a member of that workspace.");
  await setWorkspace(id);
  return { ok: true };
}

/** A new shared workspace; it opens right away. Billing (when on) asks for the Team plan next. */
export async function newTeamWorkspace(name: string) {
  const user = await requireSessionUser();
  const ws = await createTeamWorkspace(user, name);
  await setWorkspace(ws.id);
  return { id: ws.id };
}

/** Turn your personal workspace into a team and hand back a first invite link. */
export async function makePersonalTeam(name: string) {
  const user = await requireSessionUser();
  if (user.ws !== user.id) throw new Error("Open your personal workspace to turn it into a team.");
  const ws = await makeTeam(user, name);
  const invite = await createInvite(ws.id, user.id);
  return { url: `${await origin()}/invite/${invite.token}` };
}

export async function renameCurrentWorkspace(name: string) {
  const user = await requireSessionUser();
  if (user.role !== "owner") throw new Error("Only the owner can rename the workspace.");
  await renameWorkspace(user.ws, name);
  return { ok: true };
}

/** A link that lets anyone signed in join this workspace for 14 days. */
export async function inviteLink() {
  const user = await requireSessionUser();
  const ws = await getWorkspace(user.ws);
  if (!ws || ws.kind !== "team") throw new Error("Invite people from a team workspace. Create one first.");
  const invite = await createInvite(ws.id, user.id);
  return { url: `${await origin()}/invite/${invite.token}` };
}

export async function removeFromWorkspace(userId: string) {
  const user = await requireSessionUser();
  if (user.role !== "owner" && userId !== user.id) throw new Error("Only the owner can remove people.");
  await removeMember(user.ws, userId);
  if (userId === user.id) await setWorkspace(user.id);
  return { ok: true };
}

export async function joinWorkspace(token: string) {
  const user = await requireSessionUser();
  const ws = await acceptInvite(token, user);
  await setWorkspace(ws.id);
  return { id: ws.id, name: ws.name };
}
