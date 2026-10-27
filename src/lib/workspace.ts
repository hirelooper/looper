import "server-only";
import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { kv } from "./kv";
import { loopsContact, loopsEvent } from "./loops";
import type { User } from "./types";

// People and the workspaces they share. A workspace holds everything (loopers, boards, apps,
// settings); its data lives under the workspace id, which for your personal workspace is your
// user id, so personal data written before teams existed stays where it is. A personal workspace
// can become a team (kind "team") and keeps that id.

const userKey = (id: string) => `user:${id}`;
const identityKey = (identity: string) => `identity:${identity}`;
const emailKey = (email: string) => `email:${email.toLowerCase()}`;
const wsMetaKey = (id: string) => `team:${id}`;
const inviteKey = (token: string) => `invite:${token}`;
const LEGACY_USERS = "users";

export type Role = "owner" | "member";
export type Plan = "personal" | "team";
export type Interval = "month" | "year";

export interface Billing {
  plan: Plan;
  /** Billed monthly or yearly; older records without it are monthly. */
  interval?: Interval;
  /** Stripe subscription status: active, trialing, past_due, canceled, … */
  status: string;
  customerId?: string;
  subscriptionId?: string;
  periodEnd?: string;
  /** Set when the owner cancelled: access ends then. */
  cancelAt?: string;
}

export interface Workspace {
  id: string;
  name: string;
  kind: "personal" | "team";
  ownerId: string;
  members: { userId: string; role: Role; joinedAt: string }[];
  billing?: Billing;
  /** One-time AI credits in USD: granted with the first paid plan, spent by hosted model calls. */
  credits?: { granted: number; used: number };
  /** Plans whose one-time credits were already given (so renewals and re-subscribing don't repeat them). */
  creditGrants?: Plan[];
  /** Machines and storage spent this month, in USD, against the monthly cap. */
  infra?: { month: string; usd: number };
  /** Free hosted access (the owner, friends, press). */
  comped?: boolean;
  createdAt: string;
}

export interface Invite {
  token: string;
  workspaceId: string;
  role: Role;
  by: string;
  createdAt: string;
}

const now = () => new Date().toISOString();

// — Users —

/** Users from before per-user keys lived in one list; read it once to move them over. */
async function legacyUser(match: (u: User) => boolean): Promise<User | undefined> {
  const list = (await kv.get<{ users: User[] }>(LEGACY_USERS))?.users ?? [];
  const u = list.find(match);
  if (!u) return undefined;
  await saveUser(u);
  return u;
}

async function saveUser(u: User) {
  await kv.set(userKey(u.id), u);
  await Promise.all([...u.identities.map((i) => kv.set(identityKey(i), { userId: u.id })), u.email ? kv.set(emailKey(u.email), { userId: u.id }) : undefined]);
}

export async function getUser(id: string): Promise<User | undefined> {
  return (await kv.get<User>(userKey(id))) ?? (await legacyUser((u) => u.id === id));
}

/** Every workspace id that has data, for the scheduler. */
export async function allWorkspaceIds(): Promise<string[]> {
  return (await kv.keys("ws:")).map((k) => k.slice(3));
}

/**
 * Sign in: find the user behind an identity (e.g. "email:<address>", "xai:<sub>"), else one with the
 * same verified email (so a new sign-in method lands in the same account), else create one.
 * `linkTo` attaches the identity to that signed-in user instead.
 */
export async function upsertUser(input: { identity: string; email?: string; name?: string; avatar?: string; provider?: string }, linkTo?: string): Promise<User> {
  const email = input.email?.toLowerCase();
  const found =
    (linkTo && (await getUser(linkTo))) ||
    (await kv.get<{ userId: string }>(identityKey(input.identity)).then((r) => (r ? getUser(r.userId) : undefined))) ||
    (await legacyUser((u) => u.identities.includes(input.identity))) ||
    (email && ((await kv.get<{ userId: string }>(emailKey(email)).then((r) => (r ? getUser(r.userId) : undefined))) || (await legacyUser((u) => u.email?.toLowerCase() === email)))) ||
    undefined;
  const at = now();
  const user: User = found ?? { id: nanoid(12), provider: (input.provider ?? "email") as User["provider"], email, identities: [], createdAt: at, lastLoginAt: at };
  if (!user.identities.includes(input.identity)) user.identities.push(input.identity);
  user.email ??= email;
  user.name ??= input.name;
  if (input.avatar) user.avatar = input.avatar;
  user.lastLoginAt = at;
  await saveUser(user);
  await ensurePersonal(user);
  // New people join the Loops audience (updates, onboarding); "signup" can start a welcome loop.
  if (!found) {
    loopsContact(user, { plan: "none" });
    loopsEvent(user.email, "signup", { provider: user.provider });
  }
  return user;
}

export const displayName = (u: Pick<User, "name" | "email">) => u.name || u.email?.split("@")[0] || "Someone";

// — Workspaces —

export async function getWorkspace(id: string): Promise<Workspace | undefined> {
  return kv.get<Workspace>(wsMetaKey(id));
}

export function mutateWorkspace<T>(id: string, fn: (w: Workspace) => T | Promise<T>): Promise<T> {
  return kv.update<Workspace, T>(wsMetaKey(id), () => ({ id, name: "Workspace", kind: "team", ownerId: "", members: [], createdAt: now() }), fn);
}

/** Your personal workspace has your user id, so data from before teams stays in place. */
async function ensurePersonal(user: User) {
  if (await getWorkspace(user.id)) return;
  await mutateWorkspace(user.id, (w) => {
    Object.assign(w, { name: "Personal", kind: "personal", ownerId: user.id });
    if (!w.members.some((m) => m.userId === user.id)) w.members.push({ userId: user.id, role: "owner", joinedAt: now() });
  });
  await addWorkspaceToUser(user.id, user.id);
}

async function addWorkspaceToUser(userId: string, wsId: string) {
  const u = await getUser(userId);
  if (!u) return;
  u.workspaces = [...new Set([...(u.workspaces ?? []), wsId])];
  await kv.set(userKey(u.id), u);
}

/** The workspaces a user belongs to, personal first. */
export async function workspacesOf(user: User): Promise<Workspace[]> {
  // Accounts from before workspaces existed get their personal one on first look.
  await ensurePersonal(user);
  const ids = [...new Set([user.id, ...(user.workspaces ?? [])])];
  const all = await Promise.all(ids.map(getWorkspace));
  return all.filter((w): w is Workspace => !!w && w.members.some((m) => m.userId === user.id));
}

export async function roleIn(wsId: string, userId: string): Promise<Role | null> {
  if (wsId === userId) return "owner";
  const w = await getWorkspace(wsId);
  return w?.members.find((m) => m.userId === userId)?.role ?? null;
}

export async function createTeamWorkspace(owner: User, name: string): Promise<Workspace> {
  const id = `t${nanoid(11)}`;
  const ws = await mutateWorkspace(id, (w) => {
    Object.assign(w, { name: name.trim().slice(0, 60) || "Team", kind: "team", ownerId: owner.id, members: [{ userId: owner.id, role: "owner", joinedAt: now() }] });
    return { ...w };
  });
  await addWorkspaceToUser(owner.id, id);
  return ws;
}

/**
 * Turn your personal workspace into a team one so you can add people. It keeps its id (your user id),
 * so loopers, boards and billing stay where they are; from then on it behaves like any team.
 */
export async function makeTeam(owner: User, name: string): Promise<Workspace> {
  await ensurePersonal(owner);
  return mutateWorkspace(owner.id, (w) => {
    if (w.ownerId !== owner.id) throw new Error("Only the owner can turn this workspace into a team.");
    if (w.kind === "team") throw new Error("This workspace is already a team.");
    Object.assign(w, { name: name.trim().slice(0, 60) || "Team", kind: "team" });
    return { ...w };
  });
}

/** Who wrote a message: named in a team workspace, where several people share the chats. */
export async function authorIn(wsId: string, user: User) {
  return (await getWorkspace(wsId))?.kind === "team" ? { id: user.id, name: displayName(user) } : undefined;
}

export async function renameWorkspace(id: string, name: string) {
  await mutateWorkspace(id, (w) => void (w.name = name.trim().slice(0, 60) || w.name));
}

/** People in a workspace with their names, for the members list and chat authors. */
export async function membersOf(ws: Workspace) {
  const users = await Promise.all(ws.members.map((m) => getUser(m.userId)));
  return ws.members.map((m, i) => ({ ...m, email: users[i]?.email, name: users[i] ? displayName(users[i]!) : "Former member", avatar: users[i]?.avatar }));
}

export async function removeMember(wsId: string, userId: string) {
  await mutateWorkspace(wsId, (w) => {
    if (w.ownerId === userId) throw new Error("The owner can't be removed.");
    w.members = w.members.filter((m) => m.userId !== userId);
  });
  const u = await getUser(userId);
  if (u) {
    u.workspaces = (u.workspaces ?? []).filter((id) => id !== wsId);
    await kv.set(userKey(u.id), u);
  }
}

// — Invites: a link anyone signed in can open to join, valid for 14 days —

const INVITE_TTL = 14 * 86400;

export async function createInvite(wsId: string, by: string, role: Role = "member"): Promise<Invite> {
  const invite: Invite = { token: randomBytes(18).toString("base64url"), workspaceId: wsId, role, by, createdAt: now() };
  await kv.set(inviteKey(invite.token), invite, INVITE_TTL);
  return invite;
}

export const readInvite = (token: string) => kv.get<Invite>(inviteKey(token));

export async function acceptInvite(token: string, user: User): Promise<Workspace> {
  const invite = await readInvite(token);
  if (!invite) throw new Error("This invite link expired or was already used up. Ask for a new one.");
  const ws = await mutateWorkspace(invite.workspaceId, (w) => {
    if (!w.members.some((m) => m.userId === user.id)) w.members.push({ userId: user.id, role: invite.role, joinedAt: now() });
    return { ...w };
  });
  await addWorkspaceToUser(user.id, ws.id);
  return ws;
}
