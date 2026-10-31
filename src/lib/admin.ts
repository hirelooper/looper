import "server-only";
import { notFound } from "next/navigation";
import { billingEnabled, hasAccess, PLANS } from "./billing";
import { kv } from "./kv";
import { appUrl } from "./loops";
import { currentUser } from "./session";
import type { DB, User } from "./types";
import { summarize, thisMonth, isAdmin, type UsageRow } from "./usage";
import { displayName, signupBudget, type Workspace } from "./workspace";

// The operators' view of every workspace: the onboarding funnel, what each one costs us, who is
// most active and who needs a nudge. Built from what the app already stores, read in one pass
// per key prefix. It carries metadata and run summaries only: never chats, settings or secrets.
// Hidden unless the signed-in email is in ADMIN_EMAILS.

/** For pages: the signed-in operator, or a 404 so the page doesn't show it exists. */
export async function requireAdmin() {
  const user = await currentUser();
  if (!user || !isAdmin(user.email)) notFound();
  return user;
}

const DAY = 86_400_000;
const since = (iso: string | undefined, now: number) => (iso ? now - Date.parse(iso) : Infinity);
const latest = (...isos: (string | undefined)[]) => isos.filter(Boolean).sort().at(-1);
const earliest = (...isos: (string | undefined)[]) => isos.filter(Boolean).sort()[0];
const prevMonth = (m: string) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

// — The funnel —

export type Step = "signup" | "plan" | "profile" | "hire" | "run" | "active";
const ALL_STEPS: { id: Step; label: string }[] = [
  { id: "signup", label: "Signed up" },
  { id: "plan", label: "Chose a plan" },
  { id: "profile", label: "Website read" },
  { id: "hire", label: "Hired a looper" },
  { id: "run", label: "First successful run" },
  { id: "active", label: "Ran this week" },
];
/** Self-hosted there is no plan to choose. */
export const steps = () => ALL_STEPS.filter((s) => s.id !== "plan" || billingEnabled());

// — Nudges: a reason this workspace is stuck, and a first draft of the note to its owner —

export type Reason = "past-due" | "asks-waiting" | "credits-low" | "failing" | "no-success" | "no-hire" | "no-profile" | "no-plan" | "gone-quiet";

/** In the order they are worth your time. */
export const REASONS: Record<Reason, string> = {
  "past-due": "Payment failed",
  "asks-waiting": "Approvals waiting 2+ days",
  "credits-low": "Credits run out within a week",
  failing: "Last runs all failed",
  "no-success": "Hired, no successful run",
  "no-hire": "Website read, nobody hired",
  "no-profile": "Has access, website not read",
  "no-plan": "Signed up, no plan",
  "gone-quiet": "Paying, not seen for a week",
};

export interface Nudge {
  reason: Reason;
  label: string;
  /** how long it has been true, when known */
  since?: string;
  subject: string;
  body: string;
  /** when an operator last sent this reason to this workspace */
  sentAt?: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  kind: Workspace["kind"];
  /** kept out of the funnel and nudges: an operator's own, or an unused personal one whose owner works in a team */
  excluded?: "operator" | "team";
  owner: { id: string; email?: string; name: string };
  members: number;
  createdAt: string;
  /** last sign-in, chat message or answered ask by anyone in it */
  lastSeen?: string;
  plan?: string;
  status?: string;
  comped: boolean;
  /** USD a month while the subscription is active */
  mrr: number;
  reached: Record<Step, boolean>;
  at: { signup: string; profile?: string; hire?: string; run?: string };
  site?: string;
  loopers: { id: string; name: string; metric: string; paused: boolean; runs7: number; lastRun?: { at: string; status: string } }[];
  runs7: number;
  runsOk7: number;
  runsFailed7: number;
  lastRunAt?: string;
  messages7: number;
  openAsks: number;
  oldestAsk?: string;
  /** this month, USD: on our key, and everything (keys and plans at API prices) */
  spendUs: number;
  spendAll: number;
  /** our spend over the last 7 days, for how long credits last */
  spendUs7: number;
  credits?: { granted: number; used: number };
  infra: number;
  nudges: Nudge[];
}

type Raw = { meta: Workspace; db: Partial<DB>; usage: UsageRow[]; users: Map<string, User>; nudged: Record<string, string>; teamOnly: boolean };

const ACTIVE_BILLING = new Set(["active", "past_due"]);
const usd = (n: number) => `$${n.toFixed(2)}`;
const days = (ms: number) => Math.max(1, Math.floor(ms / DAY));
const agoText = (iso: string, now: number) => {
  const d = Math.floor((now - Date.parse(iso)) / DAY);
  return d < 1 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

function build({ meta, db, usage, users, nudged, teamOnly }: Raw, now: number, signer: string): WorkspaceRow {
  const owner = users.get(meta.ownerId);
  const excluded = isAdmin(owner?.email) ? "operator" : teamOnly ? "team" : undefined;
  const loopers = db.loopers ?? [];
  const runs = [...(db.runs ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const asks = (db.asks ?? []).filter((a) => a.status === "open");
  const recent = runs.filter((r) => since(r.startedAt, now) < 7 * DAY);
  const ok = runs.filter((r) => r.status === "success");
  const month = thisMonth();
  const mine = usage.filter((r) => r.day.startsWith(month));
  const sum = (rows: UsageRow[]) => rows.reduce((t, r) => t + r.usd, 0);
  const weekAgo = new Date(now - 7 * DAY).toISOString().slice(0, 10);
  const spendUs7 = sum(usage.filter((r) => r.payer === "us" && r.day >= weekAgo));

  // People's own messages and answers say they were here; their content stays out of this page.
  const messages = [...(db.chief ?? []), ...Object.values(db.chats ?? {}).flat()].filter((m) => m.role === "user");
  const messages7 = messages.filter((m) => since(m.at, now) < 7 * DAY).length;
  const lastSeen = latest(...meta.members.map((m) => users.get(m.userId)?.lastLoginAt), ...messages.map((m) => m.at), ...(db.asks ?? []).map((a) => a.answeredAt));

  const signup = meta.createdAt || owner?.createdAt || new Date(now).toISOString();
  const hire = earliest(...loopers.map((l) => l.createdAt));
  const firstOk = earliest(...ok.map((r) => r.startedAt));
  const plan = meta.billing && ACTIVE_BILLING.has(meta.billing.status) ? meta.billing.plan : undefined;
  const reached: Record<Step, boolean> = {
    signup: true,
    // The signup credits open the app for a while; they don't count as choosing a plan.
    plan: !billingEnabled() || !!meta.comped || !!meta.creditGrants?.some((g) => g !== "signup") || hasAccess({ ...meta, creditGrants: [] }, owner?.email),
    profile: !!db.profile,
    hire: loopers.length > 0,
    run: !!firstOk,
    active: recent.some((r) => r.status === "success"),
  };

  const first = owner?.name?.split(" ")[0] || "there";
  const url = appUrl();
  const sign = `\n\n${signer}`;
  const nudges: Omit<Nudge, "label" | "sentAt">[] = [];
  const add = (reason: Reason, at: string | undefined, subject: string, body: string) => nudges.push({ reason, since: at, subject, body: `Hi ${first},\n\n${body}${sign}` });

  if (!excluded) {
    const access = hasAccess(meta, owner?.email);
    if (meta.billing?.status === "past_due")
      add("past-due", undefined, "Your Looper payment didn't go through", `The last payment for ${meta.kind === "team" ? meta.name : "your workspace"} didn't go through, and your loopers stop when the retries run out. Update your card here: ${url}/billing`);
    const oldAsk = asks.filter((a) => since(a.createdAt, now) > 2 * DAY).map((a) => a.createdAt).sort()[0];
    if (oldAsk)
      add(
        "asks-waiting",
        oldAsk,
        `${asks.length} ${asks.length === 1 ? "thing is" : "things are"} waiting for you in Looper`,
        `Your loopers are waiting on ${asks.length === 1 ? "one question" : `${asks.length} questions and approvals`}, the oldest from ${agoText(oldAsk, now)}. They can't continue until you answer, and each one takes a tap: ${url}/inbox`,
      );
    const left = (meta.credits?.granted ?? 0) - (meta.credits?.used ?? 0);
    const perDay = spendUs7 / 7;
    if ((meta.credits?.granted ?? 0) > 0 && perDay > 0 && left / perDay < 7)
      add(
        "credits-low",
        new Date(now).toISOString(),
        "Your included AI credits are almost used",
        `Your workspace has ${usd(Math.max(0, left))} of included Claude credits left, about ${Math.max(0, Math.floor(left / perDay))} days at this week's pace. To keep your loopers running after that, add your own API key or connect a ChatGPT or Grok plan in Settings: ${url}/settings`,
      );
    const finished = recent.filter((r) => r.status !== "running");
    const lastThree = finished.slice(-3);
    if (lastThree.length === 3 && lastThree.every((r) => r.status === "error")) {
      const l = loopers.find((x) => x.id === lastThree[2].looperId);
      add(
        "failing",
        lastThree[0].startedAt,
        `${l?.name ?? "Your looper"} keeps hitting errors`,
        `The last few runs of ${l?.name ?? "your looper"} ended in errors. I'm looking at it on our side. Meanwhile, check that its apps are still connected: ${url}/loopers/${l?.id ?? ""}?tab=apps`,
      );
    }
    if (hire && !firstOk && since(hire, now) > DAY) {
      const l = loopers[0];
      add(
        "no-success",
        hire,
        `${l.name} hasn't finished a run yet`,
        `${l.name} is hired but hasn't completed a run yet. Usually an app still needs connecting, or a question is waiting in your inbox. Check here: ${url}/loopers/${l.id}\n\nIf it's stuck on something else, reply and I'll look into it.`,
      );
    }
    if (db.profile && !hire && since(db.profile.at, now) > DAY)
      add(
        "no-hire",
        db.profile.at,
        "Which metric should your first looper own?",
        `Chief read ${db.profile.url.replace(/^https?:\/\//, "")} and suggested a few metrics to start with, but no looper is hired yet. Pick one and Chief drafts the looper for you: ${url}/welcome\n\nNot sure which? Reply with your goal for this quarter and I'll suggest one.`,
      );
    if (access && reached.plan && !db.profile && since(signup, now) > DAY)
      add(
        "no-profile",
        signup,
        "One step to your first looper",
        `Your Looper workspace is ready, but Chief hasn't read your website yet. It takes a minute, and then Chief suggests the one metric worth moving first. Start here: ${url}/welcome\n\nIf something got in the way, reply and tell me what.`,
      );
    if (!reached.plan && since(signup, now) > DAY)
      add(
        "no-plan",
        signup,
        "Your Looper workspace is waiting",
        `You signed up for Looper ${agoText(signup, now)} but haven't picked a plan, so your workspace hasn't started. If something about the plans or the price is unclear, reply and I'll sort it out. Plans are here: ${url}/billing`,
      );
    if (plan && since(lastSeen, now) > 7 * DAY)
      add(
        "gone-quiet",
        lastSeen ?? signup,
        "How are your loopers doing?",
        `You haven't opened Looper for ${days(since(lastSeen, now))} days. Your loopers kept going: ${recent.length} runs this week. Is it doing what you hoped? Reply with one thing that would make it more useful and I'll read it myself.`,
      );
  }

  const order = Object.keys(REASONS) as Reason[];
  return {
    id: meta.id,
    name: meta.kind === "team" ? meta.name : `${owner ? displayName(owner) : "Someone"} (personal)`,
    kind: meta.kind,
    excluded,
    owner: { id: meta.ownerId, email: owner?.email, name: owner ? displayName(owner) : "Unknown" },
    members: meta.members.length,
    createdAt: signup,
    lastSeen,
    plan: meta.billing ? `${PLANS[meta.billing.plan]?.name}${meta.billing.interval === "year" ? " yearly" : ""}` : undefined,
    status: meta.billing?.status,
    comped: !!meta.comped,
    // Yearly plans count as a twelfth of their price each month.
    mrr: plan && meta.billing?.status === "active" && !meta.comped ? (meta.billing.interval === "year" ? PLANS[plan].usd.year / 12 : PLANS[plan].usd.month) : 0,
    reached,
    at: { signup, profile: db.profile?.at, hire, run: firstOk },
    site: db.profile?.url,
    loopers: loopers.map((l) => {
      const last = runs.filter((r) => r.looperId === l.id).at(-1);
      return {
        id: l.id,
        name: l.name,
        metric: l.metric.name,
        paused: l.status === "paused",
        runs7: recent.filter((r) => r.looperId === l.id).length,
        lastRun: last && { at: last.startedAt, status: last.status },
      };
    }),
    runs7: recent.length,
    runsOk7: recent.filter((r) => r.status === "success").length,
    runsFailed7: recent.filter((r) => r.status === "error").length,
    lastRunAt: runs.at(-1)?.startedAt,
    messages7,
    openAsks: asks.length,
    oldestAsk: asks.map((a) => a.createdAt).sort()[0],
    spendUs: sum(mine.filter((r) => r.payer === "us")),
    spendAll: sum(mine),
    spendUs7,
    credits: meta.credits,
    infra: meta.infra?.month === month ? meta.infra.usd : 0,
    nudges: nudges
      .map((n) => ({ ...n, label: REASONS[n.reason], sentAt: nudged[n.reason] }))
      .sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason)),
  };
}

// — Reading it all —

const nudgedKey = (wsId: string) => `admin:nudged:${wsId}`;
const LOG_KEY = "admin:log";

export interface LogEntry {
  at: string;
  by: string;
  action: "nudge";
  workspaceId: string;
  detail: string;
}

export async function logNudge(wsId: string, reason: Reason, by: string, to: string) {
  const at = new Date().toISOString();
  await kv.update<Record<string, string>, void>(nudgedKey(wsId), () => ({}), (m) => void (m[reason] = at));
  await kv.update<{ entries: LogEntry[] }, void>(LOG_KEY, () => ({ entries: [] }), (log) => {
    log.entries.push({ at, by, action: "nudge", workspaceId: wsId, detail: `${REASONS[reason]} → ${to}` });
    if (log.entries.length > 500) log.entries.splice(0, log.entries.length - 500);
  });
}

export async function adminLog(wsId?: string) {
  const entries = (await kv.get<{ entries: LogEntry[] }>(LOG_KEY))?.entries ?? [];
  return entries.filter((e) => !wsId || e.workspaceId === wsId).reverse();
}

/** A personal workspace nobody used, whose owner works in a team workspace instead. */
function isTeamOnly(meta: Workspace, db: Partial<DB> | undefined, teamsOf: (uid: string) => boolean) {
  return meta.kind === "personal" && !db?.profile && !db?.loopers?.length && teamsOf(meta.ownerId);
}

const idOf = (key: string, prefix: string) => key.slice(prefix.length);
const signerOf = (u: User) => displayName(u).split(" ")[0];

/** Every workspace, one pass per key prefix. */
export async function overview(operator: User) {
  const now = Date.now();
  const month = thisMonth();
  const months = [month, prevMonth(month)];
  const [metas, userList, dbs, usage, nudged, signup] = await Promise.all([
    kv.entries<Workspace>("team:"),
    kv.entries<User>("user:"),
    kv.entries<Partial<DB>>("ws:"),
    kv.entries<{ rows: Record<string, UsageRow> }>("usage:"),
    kv.entries<Record<string, string>>("admin:nudged:"),
    signupBudget(),
  ]);
  const users = new Map(userList.map(([, u]) => [u.id, u]));
  const dbOf = new Map(dbs.map(([k, v]) => [idOf(k, "ws:"), v]));
  const nudgedOf = new Map(nudged.map(([k, v]) => [idOf(k, "admin:nudged:"), v]));
  const usageOf = new Map<string, UsageRow[]>();
  const allRows: UsageRow[] = [];
  for (const [k, v] of usage) {
    const [, ws, m] = k.split(":");
    if (!months.includes(m)) continue;
    const rows = Object.values(v?.rows ?? {});
    usageOf.set(ws, [...(usageOf.get(ws) ?? []), ...rows]);
    if (m === month) allRows.push(...rows);
  }
  const teamMembers = new Set(metas.flatMap(([, w]) => (w.kind === "team" ? w.members.map((m) => m.userId) : [])));
  const signer = signerOf(operator);
  const rows = metas.map(([, meta]) =>
    build(
      { meta, db: dbOf.get(meta.id) ?? {}, usage: usageOf.get(meta.id) ?? [], users, nudged: nudgedOf.get(meta.id) ?? {}, teamOnly: isTeamOnly(meta, dbOf.get(meta.id), (uid) => teamMembers.has(uid)) },
      now,
      signer,
    ),
  );
  const runs = [...dbOf.values()].flatMap((d) => d.runs ?? []).filter((r) => since(r.startedAt, now) < DAY);
  const signups = [...users.values()].map((u) => u.createdAt);
  return {
    rows,
    usage: summarize(allRows, month),
    signup,
    pulse: {
      signups7: signups.filter((s) => since(s, now) < 7 * DAY).length,
      signups30: signups.filter((s) => since(s, now) < 30 * DAY).length,
      users: users.size,
      paying: rows.filter((r) => r.mrr > 0).length,
      mrr: rows.reduce((t, r) => t + r.mrr, 0),
      spendUs: rows.reduce((t, r) => t + r.spendUs, 0),
      infra: rows.reduce((t, r) => t + r.infra, 0),
      runs24: runs.length,
      failed24: runs.filter((r) => r.status === "error").length,
    },
  };
}

/** One workspace in full: its row plus the last runs' summaries (never chats). */
export async function workspaceDetail(id: string, operator: User) {
  const meta = await kv.get<Workspace>(`team:${id}`);
  if (!meta) return undefined;
  const month = thisMonth();
  const [db, cur, prev, nudged, people, teams] = await Promise.all([
    kv.get<Partial<DB>>(`ws:${id}`),
    kv.get<{ rows: Record<string, UsageRow> }>(`usage:${id}:${month}`),
    kv.get<{ rows: Record<string, UsageRow> }>(`usage:${id}:${prevMonth(month)}`),
    kv.get<Record<string, string>>(nudgedKey(id)),
    Promise.all(meta.members.map((m) => kv.get<User>(`user:${m.userId}`))),
    meta.kind === "personal" ? kv.get<User>(`user:${meta.ownerId}`).then((u) => (u?.workspaces ?? []).filter((w) => w !== id)) : Promise.resolve([]),
  ]);
  const users = new Map(people.filter((u): u is User => !!u).map((u) => [u.id, u]));
  const usage = [...Object.values(prev?.rows ?? {}), ...Object.values(cur?.rows ?? {})];
  const row = build({ meta, db: db ?? {}, usage, users, nudged: nudged ?? {}, teamOnly: isTeamOnly(meta, db, () => teams.length > 0) }, Date.now(), signerOf(operator));
  const names = new Map((db?.loopers ?? []).map((l) => [l.id, l.name]));
  const runs = [...(db?.runs ?? [])]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(-25)
    .reverse()
    .map((r) => ({ id: r.id, at: r.startedAt, looper: names.get(r.looperId) ?? "Removed looper", skill: r.skillName, status: r.status, trigger: r.trigger, summary: r.summary.slice(0, 400) }));
  const members = meta.members.map((m) => {
    const u = users.get(m.userId);
    return { id: m.userId, role: m.role, email: u?.email, name: u ? displayName(u) : "Former member", lastLoginAt: u?.lastLoginAt };
  });
  return { row, runs, members, usage: summarize(usage.filter((r) => r.day.startsWith(month)), month), log: await adminLog(id) };
}

// — Rollups for the overview —

const weekOf = (iso: string) => {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/** Signup weeks, newest first, with how many reached each step. */
export function cohorts(rows: WorkspaceRow[], weeks = 8) {
  const by = new Map<string, WorkspaceRow[]>();
  for (const r of rows) if (!r.excluded) by.set(weekOf(r.createdAt), [...(by.get(weekOf(r.createdAt)) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, weeks)
    .map(([week, list]) => ({ week, size: list.length, reached: Object.fromEntries(steps().map((s) => [s.id, list.filter((r) => r.reached[s.id]).length])) as Record<Step, number> }));
}

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Median hours between steps, for workspaces that made it. */
export function stepTimes(rows: WorkspaceRow[]) {
  const live = rows.filter((r) => !r.excluded);
  const gap = (from: (r: WorkspaceRow) => string | undefined, to: (r: WorkspaceRow) => string | undefined) =>
    median(live.flatMap((r) => (from(r) && to(r) ? [(Date.parse(to(r)!) - Date.parse(from(r)!)) / 3_600_000] : [])));
  return [
    { label: "Signup to website read", hours: gap((r) => r.at.signup, (r) => r.at.profile) },
    { label: "Website read to hire", hours: gap((r) => r.at.profile, (r) => r.at.hire) },
    { label: "Hire to first successful run", hours: gap((r) => r.at.hire, (r) => r.at.run) },
  ];
}
