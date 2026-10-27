"use server";

import { creditsLeft } from "@/lib/billing";
import { hasHostedCredits } from "@/lib/llm";
import { authorIn, getWorkspace } from "@/lib/workspace";

import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { after } from "next/server";
import { beginChiefReply, beginLooperReply, defaultRetroSkill, runRetro, runSkill, workCards } from "@/lib/agent";
import { getUser, isLocalServer, mutate, read, toPublic } from "@/lib/db";
import { appFromName, MCP_APPS } from "@/lib/apps";
import * as composioApi from "@/lib/composio";
import { kv } from "@/lib/kv";
import { findMcpServer, keyHeader, startOAuth } from "@/lib/mcp-connect";
import { cleanAttachments, deleteFiles } from "@/lib/attachments";
import { deleteCanvas } from "@/lib/canvas";
import { wipeComputer } from "@/lib/computer";
import { deleteDatabase } from "@/lib/database";
import { saveAppServer, testIntegration } from "@/lib/integrations";
import * as chatgpt from "@/lib/oauth/chatgpt";
import * as codex from "@/lib/oauth/codex";
import * as grok from "@/lib/oauth/grok";
import { clearSession, currentUser, requireSessionUser, requireUid, requireUser, setSession } from "@/lib/session";
import type { AppRef, Attachment, AuthMode, Card, Column, GrokRoute, Integration, IntegrationKind, Looper, ModelChoice, Provider, Skill } from "@/lib/types";
import { ACCENTS } from "@/lib/types";

const now = () => new Date().toISOString();
const done = <T,>(v: T) => {
  revalidatePath("/", "layout");
  return v;
};

export async function getState() {
  const user = await requireUser();
  const [db, ws] = await Promise.all([read(user.ws), getWorkspace(user.ws)]);
  const state = toPublic(db, user);
  if (hasHostedCredits()) state.settings.creditsLeft = creditsLeft(ws);
  return state;
}

// — Sign-in —

/** Not a secret: remembers which user last signed in on this browser so ChatGPT reuses their app registration. */
const HINT_COOKIE = "cl_hint";

/** Production hides thrown server-action messages; actions the UI explains return them instead. */
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function startChatGPTLogin() {
  return attempt(startChatGPTLoginInner);
}

async function startChatGPTLoginInner() {
  if (!isLocalServer()) throw new Error("OpenAI only allows ChatGPT sign-in for apps running on your own machine. Use Grok here, or run Looper locally.");
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${host}`;
  const port = host.split(":")[1] ?? "80";
  const signedIn = await currentUser();
  const hintUid = signedIn?.id ?? (await cookies()).get(HINT_COOKIE)?.value;
  const known = hintUid ? await getUser(hintUid) : undefined;
  const clientId = known ? (await read(known.id)).settings.chatgptClientId : undefined;
  return chatgpt.startSignIn({ port, origin, linkUid: signedIn?.id, linkWs: signedIn?.ws, clientId, loginHint: known?.email });
}

export async function startGrokLogin() {
  return attempt(async () => {
    const u = await currentUser();
    return grok.startDevice(u?.id, u?.ws);
  });
}

export async function pollGrokLogin(flowId: string) {
  const r = await grok.pollDevice(flowId);
  if (r.status !== "connected") return { status: r.status };
  if (!r.linked) {
    await setSession(r.uid);
    (await cookies()).set(HINT_COOKIE, r.uid, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 86400 });
  }
  return done({ status: "connected" as const });
}

export async function startCodexLogin() {
  return attempt(async () => {
    const u = await currentUser();
    return codex.startDevice(u?.id, u?.ws);
  });
}

export async function pollCodexLogin(flowId: string) {
  const r = await codex.pollDevice(flowId);
  if (r.status !== "connected") return { status: r.status };
  if (!r.linked) {
    await setSession(r.uid);
    (await cookies()).set(HINT_COOKIE, r.uid, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 86400 });
  }
  return done({ status: "connected" as const });
}

export async function signOutApp() {
  await clearSession();
  return true;
}

export async function disconnectSubscription(provider: Provider) {
  const uid = await requireUid();
  if (provider === "openai") {
    if ((await read(uid)).settings.oauth.openai?.via === "codex") await codex.signOut(uid);
    else await chatgpt.signOut(uid);
  }
  else await grok.signOut(uid);
  return done(true);
}

// — Model settings —

/** How loopers reach a provider: its included credits, the signed-in plan, or the saved API key. */
export async function setConnection(provider: Provider, mode: AuthMode) {
  const uid = await requireUid();
  if (mode === "credits" && (provider !== "anthropic" || !hasHostedCredits())) throw new Error("Included credits aren't available here.");
  await mutate(uid, (db) => {
    if (mode === "key" && !db.settings.apiKeys[provider]) throw new Error("Add an API key first.");
    if (mode === "oauth" && !db.settings.oauth[provider]) throw new Error("Sign in first.");
    db.settings.authMode[provider] = mode;
  });
  return done(true);
}

export async function saveApiKey(provider: Provider, apiKey: string) {
  const uid = await requireUid();
  if (!apiKey.trim()) throw new Error("Paste an API key.");
  await mutate(uid, (db) => {
    db.settings.apiKeys[provider] = apiKey.trim();
    db.settings.authMode[provider] = "key";
  });
  return done(true);
}

/** The model for scheduled runs and for chats with no model picked. */
export async function setDefaultModel(choice: ModelChoice) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    db.settings.provider = choice.provider;
    db.settings.defaultModel = { provider: choice.provider, model: choice.model };
  });
  return done(true);
}

/** Pick the model for one conversation: "chief" or a looper id (a looper's runs use it too). null goes back to the default. */
export async function setChatModel(target: string, choice: ModelChoice | null) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    if (target !== "chief" && !db.loopers.some((l) => l.id === target)) throw new Error("Looper not found");
    db.chatModels ??= {};
    if (choice) db.chatModels[target] = { provider: choice.provider, model: choice.model };
    else delete db.chatModels[target];
  });
  return done(true);
}

export async function removeKey(provider: Provider) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    delete db.settings.apiKeys[provider];
    if (db.settings.oauth[provider]) db.settings.authMode[provider] = "oauth";
    else if (provider === "anthropic" && hasHostedCredits()) db.settings.authMode.anthropic = "credits";
  });
  return done(true);
}

export async function setGrokRoute(route: GrokRoute) {
  const uid = await requireUid();
  await mutate(uid, (db) => void (db.settings.grokRoute = route));
  return done(true);
}

// — Chief —
// Replies run in the background: the request returns once the message is saved, and the chat
// follows the reply through /api/progress. (Server actions run one at a time per tab, so a long one
// would hold up every other click.)
/** In a team workspace, messages carry who wrote them. */
async function author() {
  const user = await requireSessionUser();
  return { uid: user.ws, by: await authorIn(user.ws, user) };
}

export async function askChief(text: string, files?: Attachment[]) {
  const { uid, by } = await author();
  const reply = await beginChiefReply(uid, text, by, cleanAttachments(files));
  after(reply);
  return done({ since: reply.since });
}

export async function askLooper(looperId: string, text: string, files?: Attachment[]) {
  const { uid, by } = await author();
  const reply = await beginLooperReply(uid, looperId, text, by, cleanAttachments(files));
  after(reply);
  return done({ since: reply.since });
}

export async function clearLooperChat(looperId: string) {
  const uid = await requireUid();
  const cleared = await mutate(uid, (db) => {
    const old = db.chats?.[looperId] ?? [];
    (db.chats ??= {})[looperId] = [];
    return old;
  });
  await deleteFiles(uid, cleared);
  return done(true);
}

export async function clearChief() {
  const uid = await requireUid();
  const cleared = await mutate(uid, (db) => {
    const old = db.chief;
    db.chief = [];
    return old;
  });
  await deleteFiles(uid, cleared);
  return done(true);
}

// — Integrations —

export async function addIntegration(input: { name: string; kind: IntegrationKind; url: string; headerName?: string; headerValue?: string }) {
  const uid = await requireUid();
  const url = new URL(input.url.trim());
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("Use an https:// MCP URL");
  const integration: Integration = {
    id: nanoid(8),
    name: input.name.trim() || input.kind,
    kind: input.kind,
    url: url.toString(),
    headers: input.headerName?.trim() && input.headerValue?.trim() ? { [input.headerName.trim()]: input.headerValue.trim() } : {},
    enabled: true,
  };
  await mutate(uid, (db) => void db.settings.integrations.push(integration));
  return done(integration.id);
}

export async function toggleIntegration(id: string) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    const i = db.settings.integrations.find((x) => x.id === id);
    if (i) i.enabled = !i.enabled;
  });
  return done(true);
}

export async function removeIntegration(id: string) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    db.settings.integrations = db.settings.integrations.filter((x) => x.id !== id);
    for (const l of db.loopers) if (Array.isArray(l.integrationIds)) l.integrationIds = l.integrationIds.filter((x) => x !== id);
  });
  return done(true);
}

export async function checkIntegration(id: string) {
  const uid = await requireUid();
  const i = (await read(uid)).settings.integrations.find((x) => x.id === id);
  if (!i) return { ok: false as const, error: "Not found" };
  return testIntegration(i, uid);
}

// — Loopers —
export async function createLooper(input: { name: string; emoji: string; mission: string; metricName: string; unit: string; direction: "up" | "down"; target: number; current?: number; apps?: string[] }) {
  const uid = await requireUid();
  const apps = await composioApi.resolveApps((input.apps ?? []).map(appFromName));
  const id = await mutate(uid, (db) => {
    const looper: Looper = {
      id: nanoid(8),
      name: input.name.trim(),
      emoji: input.emoji || "◎",
      color: ACCENTS[db.loopers.length % ACCENTS.length],
      mission: input.mission.trim(),
      metric: {
        name: input.metricName.trim(),
        unit: input.unit.trim(),
        direction: input.direction,
        target: input.target,
        history: input.current === undefined || Number.isNaN(input.current) ? [] : [{ at: now(), value: input.current, note: "baseline" }],
      },
      skills: [defaultRetroSkill()],
      integrationIds: "all",
      apps: apps.filter((a, i, all) => all.findIndex((b) => b.slug === a.slug) === i),
      status: "active",
      createdAt: now(),
    };
    db.loopers.push(looper);
    return looper.id;
  });
  return done(id);
}

export async function updateLooper(id: string, patch: Partial<Pick<Looper, "name" | "emoji" | "mission" | "status" | "integrationIds" | "color">> & { target?: number }) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    const l = db.loopers.find((x) => x.id === id);
    if (!l) return;
    const { target, ...rest } = patch;
    Object.assign(l, rest);
    if (target !== undefined) l.metric.target = target;
  });
  return done(true);
}

export async function deleteLooper(id: string) {
  const uid = await requireUid();
  await Promise.all([deleteDatabase(uid, id), deleteCanvas(uid, id), wipeComputer(uid, id).catch(() => undefined)]);
  await mutate(uid, (db) => {
    db.loopers = db.loopers.filter((x) => x.id !== id);
    db.cards = db.cards.filter((x) => x.looperId !== id);
    db.runs = db.runs.filter((x) => x.looperId !== id);
    db.retros = db.retros.filter((x) => x.looperId !== id);
  });
  return done(true);
}

export async function recordMetric(id: string, value: number, note?: string) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    db.loopers.find((x) => x.id === id)?.metric.history.push({ at: now(), value, note: note || "manual entry" });
  });
  return done(true);
}

export async function saveSkill(looperId: string, skill: Omit<Skill, "id"> & { id?: string }) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    const l = db.loopers.find((x) => x.id === looperId);
    if (!l) return;
    const existing = skill.id && l.skills.find((s) => s.id === skill.id);
    if (existing) Object.assign(existing, skill);
    else l.skills.push({ ...skill, id: nanoid(8) });
  });
  return done(true);
}

export async function deleteSkill(looperId: string, skillId: string) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    const l = db.loopers.find((x) => x.id === looperId);
    if (l) l.skills = l.skills.filter((s) => s.id !== skillId);
  });
  return done(true);
}

/** Start a skill in the background; the looper's chat and the Working tray follow it. */
export async function runLooperSkill(looperId: string, skillId: string) {
  const uid = await requireUid();
  after(() => runSkill(uid, looperId, skillId, "manual").then(() => undefined).catch(() => undefined));
  return done(true);
}

/** A run still marked running after this long was killed mid-way (e.g. by the function timeout). */
const STALE_RUN_MS = 15 * 60_000;

/** Have the looper work its "To do" cards now, or one card. False when it's already mid-run. */
export async function workOnCards(looperId: string, cardId?: string) {
  const uid = await requireUid();
  const db = await read(uid);
  const busy = db.runs.some((r) => r.looperId === looperId && r.status === "running" && Date.now() - Date.parse(r.startedAt) < STALE_RUN_MS);
  if (busy) return done(false);
  after(() => workCards(uid, looperId, cardId, "manual").then(() => undefined).catch(() => undefined));
  return done(true);
}

export async function holdRetro(looperId: string) {
  const uid = await requireUid();
  after(() => runRetro(uid, looperId, "manual").then(() => undefined).catch(() => undefined));
  return done(true);
}

// — Kanban —
export async function addCard(looperId: string, title: string, column: Column = "todo", assignee: "looper" | "you" = "looper") {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    const card: Card = { id: nanoid(8), looperId, title: title.trim(), description: "", column, assignee, createdBy: "user", createdAt: now(), updatedAt: now() };
    db.cards.push(card);
  });
  return done(true);
}

export async function moveCard(cardId: string, column: Column) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    const c = db.cards.find((x) => x.id === cardId);
    if (c) Object.assign(c, { column, updatedAt: now() });
  });
  return done(true);
}

export async function editCard(cardId: string, patch: { title?: string; description?: string; assignee?: "looper" | "you" }) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    const c = db.cards.find((x) => x.id === cardId);
    if (c) Object.assign(c, patch, { updatedAt: now() });
  });
  return done(true);
}

/** Reply on a card (progress, an opinion). The looper reads it and answers on the card. */
export async function replyToCard(cardId: string, text: string) {
  const { uid, by } = await author();
  const body = text.trim();
  if (!body) return done(null);
  const card = await mutate(uid, (db) => {
    const c = db.cards.find((x) => x.id === cardId);
    if (!c) throw new Error("Card not found");
    (c.comments ??= []).push({ id: nanoid(8), by: "you", text: body, at: now(), ...(by ? { author: by } : {}) });
    c.updatedAt = now();
    return { looperId: c.looperId, title: c.title };
  });
  const reply = await beginLooperReply(uid, card.looperId, `Reply on card "${card.title}" (${cardId}): ${body}`, by);
  after(reply);
  return done({ since: reply.since });
}

export async function deleteCard(cardId: string) {
  const uid = await requireUid();
  await mutate(uid, (db) => void (db.cards = db.cards.filter((x) => x.id !== cardId)));
  return done(true);
}

// — Apps (per looper) —

type AppState = "connected" | "not_connected" | "unavailable";
interface AppRow extends AppRef {
  state: AppState;
  detail: string;
  setup?: string[];
  /** how Connect works: Composio's hosted page, the app's own MCP server, or a server on the owner's machine */
  route?: "composio" | "mcp" | "local";
  /** the app's own MCP server: sign in on the vendor's page, paste a key, or nothing to enter */
  auth?: "oauth" | "key" | "none";
  /** connected accounts of this app, e.g. several Stripe accounts; ids starting "mcp:" are its own server */
  accounts?: { id: string; label: string }[];
  /** more than one account can be connected (Composio only) */
  multi?: boolean;
}

const NO_CONNECTION = (name: string) =>
  `${name} has no Composio app or MCP server Looper can use. Connect it through a Zapier or Pipedream hub in Settings, or your looper can work in ${name} through the browser once you sign in there.`;

export async function looperAppStatus(looperId: string): Promise<{ composio: boolean; apps: AppRow[] }> {
  const uid = await requireUid();
  const db = await read(uid);
  const looper = db.loopers.find((l) => l.id === looperId);
  if (!looper) throw new Error("Looper not found");
  const composio = composioApi.hasComposio();
  // The Apps tab must show a connection made a moment ago, so skip the short cache here.
  const accounts = composio ? await composioApi.activeAccounts(uid, true).catch(() => new Map<string, composioApi.Account[]>()) : new Map<string, composioApi.Account[]>();
  const local = isLocalServer();
  const repairs = new Map<string, { slug: string; name: string; logo?: string }>();

  const apps = await Promise.all(
    (looper.apps ?? []).map(async (original): Promise<AppRow> => {
      let app = original;
      if (app.via === "mcp") {
        const preset = MCP_APPS[app.slug];
        const integration = db.settings.integrations.find((i) => i.app === app.slug && i.enabled);
        if (preset?.localOnly && !local)
          return { ...app, route: "local", state: "unavailable", detail: `${app.name} runs on your own machine. Open Looper locally to connect it.` };
        if (integration) return { ...app, route: "local", state: "connected", detail: `Read-only via ${integration.url.replace(/^https?:\/\//, "")}` };
        return { ...app, route: "local", state: "not_connected", detail: "Runs on your machine through a small MCP server. Payments are blocked.", setup: preset?.setup };
      }
      let tk = composio ? await composioApi.getToolkit(app.slug).catch(() => null) : null;
      if (composio && !tk) {
        // Older loopers stored a guessed slug ("googlesearchconsole"); look the name up in the catalog.
        const found = await composioApi.resolveToolkit(app.name).catch(() => null);
        if (found) {
          tk = await composioApi.getToolkit(found.slug).catch(() => null);
          if (tk) repairs.set(app.slug, { slug: tk.slug, name: tk.name, logo: found.logo });
          app = { ...app, slug: found.slug };
        }
      }
      const name = tk?.name ?? app.name;
      const logo = app.logo ?? tk?.meta?.logo;

      // Connected through the app's own MCP server (Composio couldn't connect it).
      const own = db.settings.integrations.find((i) => i.app === app.slug && i.enabled);
      if (own)
        return {
          ...app,
          name,
          logo,
          route: "mcp",
          state: "connected",
          accounts: [{ id: `mcp:${own.id}`, label: own.url.replace(/^https?:\/\//, "").replace(/\/$/, "") }],
          detail: `Connected through ${name}'s own MCP server`,
        };

      const list = (accounts.get(app.slug) ?? []).map((a) => ({ id: a.id, label: composioApi.accountLabel(a) }));
      if (list.length)
        return {
          ...app,
          name,
          logo,
          route: "composio",
          multi: true,
          state: "connected",
          accounts: list,
          detail: list.length === 1 ? `Connected as ${list[0].label}` : `${list.length} accounts connected`,
        };

      // 1. Composio, unless it can't connect this app or failed to before.
      const how = tk ? composioApi.composioAuth(tk) : null;
      if (how && !(await kv.get(`composio-broken:${app.slug}`).catch(() => undefined)))
        return { ...app, name, logo, route: "composio", state: "not_connected", detail: how.managed ? `Sign in with ${name}` : `Paste your ${name} key on a secure Composio page` };

      // 2. The app's own MCP server.
      const server = await findMcpServer({ slug: app.slug, name }).catch(() => null);
      if (server)
        return {
          ...app,
          name,
          logo,
          route: "mcp",
          auth: server.auth,
          state: "not_connected",
          detail: server.auth === "oauth" ? `Sign in with ${name}` : server.auth === "key" ? (server.hint ?? `Paste your ${name} API key`) : `Connect ${name}'s MCP server`,
        };

      // 3. Nothing to connect to: point at hubs and the browser.
      if (!tk && !composio) return { ...app, state: "not_connected", detail: "Needs Composio on the server" };
      return { ...app, name, logo, state: "unavailable", detail: NO_CONNECTION(name) };
    }),
  );

  // Remember fixed slugs, logos and canonical names so runs, Chief and tiles use them.
  const known = new Map(apps.map((a) => [a.slug, a]));
  if (repairs.size || apps.some((a) => a.logo && !looper.apps?.find((x) => x.slug === a.slug)?.logo))
    await mutate(uid, (d) => {
      const l = d.loopers.find((x) => x.id === looperId);
      if (!l?.apps) return;
      l.apps = l.apps.map((a) => {
        const fixed = repairs.get(a.slug);
        const slug = fixed?.slug ?? a.slug;
        return { ...a, slug, name: fixed?.name ?? known.get(slug)?.name ?? a.name, logo: fixed?.logo ?? known.get(slug)?.logo ?? a.logo };
      });
      l.apps = l.apps.filter((a, i, all) => all.findIndex((b) => b.slug === a.slug) === i);
    });
  return { composio, apps };
}

/** Start Composio's hosted connect page for one app; returns the URL to open.
 * `another` adds a further account of an app that's already connected (e.g. a second Stripe). */
export async function connectApp(looperId: string, slug: string, another = false, returnTo?: "hire" | "welcome") {
  return attempt(() => connectAppInner(looperId, slug, another, returnTo));
}

async function connectAppInner(looperId: string, slug: string, another: boolean, returnTo?: "hire" | "welcome") {
  const uid = await requireUid();
  try {
    return await composioLink(uid, looperId, slug, another, returnTo);
  } catch (e) {
    // Composio can't connect it: fall back to the app's own MCP server, and remember for the Apps tab.
    const tk = await composioApi.getToolkit(slug).catch(() => null);
    const server = await findMcpServer({ slug, name: tk?.name ?? slug }).catch(() => null);
    if (!server) throw e instanceof composioApi.NoComposioAuth ? new Error(NO_CONNECTION(tk?.name ?? slug)) : e;
    await kv.set(`composio-broken:${slug}`, true, 24 * 3600);
    const name = tk?.name ?? slug;
    if (server.auth === "oauth") return startOAuth({ uid, looperId, slug, name, url: server.url, returnTo, redirectUrl: `${await origin()}/connect/mcp` }, server.scope);
    throw new Error(`Composio couldn't connect ${name}. Connect it through ${name}'s own server below instead.`);
  }
}

async function origin() {
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

async function composioLink(uid: string, looperId: string, slug: string, another: boolean, returnTo?: "hire" | "welcome") {
  let alias: string | undefined;
  if (another) {
    const existing = (await composioApi.activeAccounts(uid)).get(slug) ?? [];
    const taken = new Set(existing.map((a) => a.alias).filter(Boolean));
    let n = existing.length + 1;
    while (taken.has(`${slug}-${n}`)) n++;
    alias = `${slug}-${n}`;
  }
  const callback = `${await origin()}/connect/callback?looper=${encodeURIComponent(looperId)}&app=${encodeURIComponent(slug)}${returnTo === "hire" || returnTo === "welcome" ? `&return=${returnTo}` : ""}`;
  const link = await composioApi.linkAccount(uid, slug, callback, alias);
  // The callback's query string isn't proof: remember which account we started for whom.
  await kv.set(`composio-link:${link.connected_account_id}`, { uid, looperId, slug }, 3600);
  return link.redirect_url;
}

/** Connect an MCP-based app (e.g. bunq): check the server answers, then save it with payment tools blocked. */
export async function connectMcpApp(looperId: string, slug: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const uid = await requireUid();
  const preset = MCP_APPS[slug];
  if (!preset) return { ok: false, error: "Unknown app" };
  if (preset.localOnly && !isLocalServer()) return { ok: false, error: `${preset.name} only works when Looper runs on your machine.` };
  const probe: Integration = { id: "probe", name: preset.name, kind: "custom", url: preset.url, headers: {}, enabled: true, app: slug, deniedTools: preset.deniedTools };
  const test = await testIntegration(probe);
  if (!test.ok) return { ok: false, error: `Couldn't reach ${preset.name} at ${preset.url}. Is bunq-mcp running? (${test.error})` };
  await mutate(uid, (db) => {
    const existing = db.settings.integrations.find((i) => i.app === slug);
    if (existing) Object.assign(existing, { url: preset.url, deniedTools: preset.deniedTools, enabled: true });
    else db.settings.integrations.push({ ...probe, id: nanoid(8) });
  });
  return done({ ok: true });
}

/** Connect an app through its own MCP server (Composio can't): returns the vendor's sign-in page to open,
 * or null when it's connected already (a pasted key, or a server that needs nothing). */
export async function connectAppServer(looperId: string, slug: string, name: string, key?: string, returnTo?: "hire" | "welcome") {
  return attempt(async () => {
    const uid = await requireUid();
    const server = await findMcpServer({ slug, name });
    if (!server) throw new Error(NO_CONNECTION(name));
    if (server.auth === "oauth") return startOAuth({ uid, looperId, slug, name, url: server.url, returnTo, redirectUrl: `${await origin()}/connect/mcp` }, server.scope);
    if (server.auth === "key" && !key?.trim()) throw new Error(`Paste your ${name} API key first.`);
    const integration: Integration = {
      id: nanoid(8),
      name,
      kind: "custom",
      url: server.url,
      headers: server.auth === "key" ? keyHeader(server, key!.trim()) : {},
      enabled: true,
      app: slug,
    };
    const test = await testIntegration(integration);
    if (!test.ok) throw new Error(`${name} didn't accept that: ${test.error}`);
    await saveAppServer(uid, integration);
    return done(null);
  });
}

export async function searchApps(q: string): Promise<AppRef[]> {
  await requireUid();
  const query = q.trim().toLowerCase();
  const mcp = Object.entries(MCP_APPS)
    .filter(([slug, a]) => slug.includes(query) || a.name.toLowerCase().includes(query))
    .map(([slug, a]) => ({ slug, name: a.name, via: "mcp" as const, logo: a.logo }));
  if (!composioApi.hasComposio()) return mcp.length ? mcp : [appFromName(q)];
  const found = await composioApi.searchToolkits(q).catch(() => []);
  return [...mcp, ...found.map((t) => ({ slug: t.slug, name: t.name, logo: t.logo, via: "composio" as const }))];
}

export async function addLooperApp(looperId: string, app: AppRef) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    const l = db.loopers.find((x) => x.id === looperId);
    if (l && !l.apps?.some((a) => a.slug === app.slug)) l.apps = [...(l.apps ?? []), app];
  });
  return done(true);
}

export async function removeLooperApp(looperId: string, slug: string) {
  const uid = await requireUid();
  await mutate(uid, (db) => {
    const l = db.loopers.find((x) => x.id === looperId);
    if (l?.apps) l.apps = l.apps.filter((a) => a.slug !== slug);
  });
  return done(true);
}

/** Disconnect one account of an app (it stops working for every looper). */
export async function disconnectAccount(accountId: string) {
  const uid = await requireUid();
  if (accountId.startsWith("mcp:")) return removeIntegration(accountId.slice(4));
  // Only the signed-in user's own accounts can be removed.
  const mine = (await composioApi.listAccounts(uid)).some((a) => a.id === accountId);
  if (!mine) throw new Error("That connection isn't yours.");
  await composioApi.deleteAccount(accountId);
  composioApi.forgetAccounts(uid);
  return done(true);
}
