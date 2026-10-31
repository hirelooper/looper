export type Provider = "openai" | "xai" | "anthropic";

export const PROVIDERS: { id: Provider; label: string; plan: string; keyHint: string }[] = [
  { id: "openai", label: "OpenAI", plan: "ChatGPT", keyHint: "sk-…" },
  { id: "xai", label: "xAI", plan: "Grok", keyHint: "xai-…" },
  { id: "anthropic", label: "Anthropic", plan: "Claude", keyHint: "sk-ant-…" },
];

/** A model to call. No model id means the provider's recommended (newest mid-priced) model. */
export interface ModelChoice {
  provider: Provider;
  model?: string;
}

/** USD per million tokens, at the provider's API list price. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The model picker for one conversation, or for the workspace default. */
export interface ModelMenu {
  options: ModelOption[];
  /** this conversation's pick; unset means the default */
  picked?: ModelChoice;
  /** what an unset pick runs on now */
  fallback?: ModelOption;
}

/** Who pays for a model call: us (included credits on our key), the user's own API key, or the user's plan (no per-call bill). */
export type Payer = "us" | "key" | "plan";

/** A model the workspace can pick right now, with how it's paid for. */
export interface ModelOption {
  provider: Provider;
  id: string;
  name: string;
  price?: ModelPrice;
  payer: Payer;
  /** the one the provider gets when no model is picked */
  recommended?: boolean;
}

export interface User {
  id: string;
  /** how they first signed in: a model provider (self-hosted) or "email"/"google"/"github" */
  provider: Provider | "email" | "google" | "github";
  email?: string;
  name?: string;
  avatar?: string;
  /** provider:subject pairs that sign in as this user */
  identities: string[];
  /** team workspaces they belong to (the personal one has their own id) */
  workspaces?: string[];
  createdAt: string;
  lastLoginAt: string;
}

export type IntegrationKind = "composio" | "zapier" | "pipedream" | "custom";

/** An MCP server. Hubs like Composio, Zapier and Pipedream each expose thousands of apps through one URL. */
export interface Integration {
  id: string;
  name: string;
  kind: IntegrationKind;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  /** catalog app this server provides, e.g. "bunq" */
  app?: string;
  /** tools never exposed to loopers, e.g. real-money payments */
  deniedTools?: string[];
  /** servers signed in to directly with OAuth: the client Looper registered and its tokens. Server-only. */
  oauth?: { redirectUrl: string; client: Record<string, unknown>; tokens?: Record<string, unknown> };
}

/** An app a looper needs. Composio apps connect with one click; MCP apps point at a server. */
export interface AppRef {
  slug: string;
  name: string;
  via: "composio" | "mcp";
  logo?: string;
}

/** OAuth tokens for a subscription sign-in. Server-only. */
export interface OAuthCredential {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
  /** epoch ms; ChatGPT refuses refreshes before this */
  earliestRefreshAt?: number;
  scopes: string[];
  email?: string;
  subject?: string;
  /** codex: ChatGPT signed in through the Codex CLI's login (unofficial), used on hosted servers */
  via?: "codex";
  /** ChatGPT account the Codex endpoint bills */
  accountId?: string;
}

/** credits: hosted Claude on the workspace's included credits (our server key). */
export type AuthMode = "key" | "oauth" | "credits";
/** Where Grok subscription tokens are sent: xAI's public API, or the Grok CLI's proxy (unofficial). */
export type GrokRoute = "api" | "cli-proxy";

export interface Settings {
  provider: Provider;
  apiKeys: Partial<Record<Provider, string>>;
  /** Default for runs and for chats with no model picked. Unset: `provider`'s recommended model. */
  defaultModel?: ModelChoice;
  integrations: Integration[];
  authMode: Partial<Record<Provider, AuthMode>>;
  oauth: { openai?: OAuthCredential; xai?: OAuthCredential; anthropic?: never };
  /** ChatGPT issues a client id per user on first sign-in; it survives sign-out. */
  chatgptClientId?: string;
  grokRoute: GrokRoute;
}

export type ScheduleType = "manual" | "hourly" | "daily" | "weekly";

export interface Schedule {
  type: ScheduleType;
  /** HH:MM, local server time */
  time: string;
  /** 0 = Sunday … 6 = Saturday, used by weekly */
  days: number[];
}

export interface Skill {
  id: string;
  name: string;
  instructions: string;
  schedule: Schedule;
  /** retro skills run a self-reflection instead of regular work */
  kind: "work" | "retro";
  lastRunAt?: string;
}

export interface MetricPoint {
  at: string;
  value: number;
  note?: string;
}

export interface Metric {
  name: string;
  unit: string;
  direction: "up" | "down";
  target: number;
  history: MetricPoint[];
}

export interface Looper {
  id: string;
  name: string;
  emoji: string;
  color: Accent;
  mission: string;
  metric: Metric;
  skills: Skill[];
  /** "all" or a list of integration ids */
  integrationIds: "all" | string[];
  /** apps this looper needs connected */
  apps?: AppRef[];
  /** short role tag shown next to the name, e.g. "Accounting" */
  role?: string;
  /** Sidebar group. Unset on older loopers; see areaOf. */
  area?: Area;
  status: "active" | "paused";
  createdAt: string;
}

/** Distribution loopers grow reach, traffic, leads or revenue; operations loopers keep the business running. */
export type Area = "distribution" | "operations";
export const AREAS: { id: Area; label: string }[] = [
  { id: "distribution", label: "Distribution" },
  { id: "operations", label: "Operations" },
];

const DISTRIBUTION = /\b(seo|geo|social|marketing|content|ads?|ppc|sales|growth|leads?|outreach|linkedin|newsletter|pr|brand|community|impressions|traffic|clicks|signups|revenue|roas|demos?)\b/i;

/** A looper's sidebar group: its own, or guessed from its role and business metric. */
export const areaOf = (l: Pick<Looper, "area" | "role" | "metric">): Area => l.area ?? (DISTRIBUTION.test(`${l.role ?? ""} ${l.metric.name}`) ? "distribution" : "operations");

export type Accent = "green" | "orange" | "lavender" | "blue" | "ink";
export const ACCENTS: Accent[] = ["green", "orange", "lavender", "blue", "ink"];

export type Column = "backlog" | "todo" | "doing" | "done";
export const COLUMNS: { id: Column; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "To do" },
  { id: "doing", label: "Doing" },
  { id: "done", label: "Done" },
];

export interface Card {
  id: string;
  looperId: string;
  title: string;
  description: string;
  column: Column;
  createdBy: "looper" | "user" | "chief";
  /** who has to do it: the looper itself, or the person (approve, connect, decide). Default looper. */
  assignee?: "looper" | "you";
  /** replies on the card: the owner's progress or opinion, the looper's answers */
  comments?: CardComment[];
  createdAt: string;
  updatedAt: string;
}

export interface CardComment {
  id: string;
  by: "you" | "looper";
  text: string;
  at: string;
  /** who wrote it, in a shared workspace */
  author?: ChiefMessage["by"];
}

export interface ToolCallLog {
  name: string;
  ok: boolean;
}

export interface Run {
  id: string;
  looperId: string;
  skillId: string;
  skillName: string;
  trigger: "schedule" | "manual" | "chief";
  status: "running" | "success" | "error";
  startedAt: string;
  finishedAt?: string;
  summary: string;
  toolCalls: ToolCallLog[];
  /** what the run changed, for the one-line run report */
  stats?: RunStats;
  /** the steps it took, as shown live while it worked */
  steps?: string[];
  /** hidden from the inbox after the owner dismissed the failure */
  dismissed?: boolean;
  /** a one-off job (collect, fill database, work cards): what it was asked, so a retry can run it again */
  adhoc?: { instructions: string; maxSteps: number };
  /** a collect job's round (1, 2, …) */
  round?: number;
  /** a later round of this job was started */
  continues?: boolean;
}

export interface RunStats {
  rows?: number;
  cards?: number;
  moved?: number;
  pins?: number;
  metric?: number;
  tools?: number;
}

/** A question or approval a looper puts to its owner; answered with one tap in chat or the inbox. */
export interface Ask {
  id: string;
  looperId: string;
  /** takeover: the owner takes over the looper's browser (to log in, or pass a bot check) */
  kind: "choice" | "approval" | "takeover";
  question: string;
  /** for takeover: the page to open */
  url?: string;
  /** for choice: the options to tap */
  options?: string[];
  /** for approval: what exactly will happen when approved */
  detail?: string;
  status: "open" | "answered" | "dismissed";
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}

export interface Retro {
  id: string;
  looperId: string;
  createdAt: string;
  periodStart: string;
  periodEnd: string;
  /** 1–5, self-assessed */
  effectiveness: number;
  metricStart?: number;
  metricEnd?: number;
  wentWell: string[];
  didntGoWell: string[];
  tryNext: string[];
}

export interface ChiefMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  actions?: string[];
  /** follow-up links, e.g. connecting a new looper's apps */
  links?: { label: string; href: string }[];
  /** a question or approval asked in this message */
  askId?: string;
  /** who wrote it, in a shared workspace */
  by?: { id: string; name: string };
  /** the steps taken to write this reply, as shown live */
  steps?: string[];
  /** images and files the owner attached */
  files?: Attachment[];
}

/** A file attached to a chat message; the bytes live at /api/files/<id>. */
export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: "image" | "pdf" | "text";
}

/** One user's private workspace. */
/** One metric Chief thinks this business should move first, from onboarding. */
export interface MetricSuggestion {
  metric: string;
  why: string;
  /** "grow organic signups from 40 to 100 a week": becomes "Hire a looper to …" */
  goal: string;
  /** a ready-made looper that fits, by slug */
  template?: string;
}

/** What Chief knows about the business, read from its website during onboarding. */
export interface BusinessProfile {
  url: string;
  name: string;
  summary: string;
  customers: string;
  suggestions: MetricSuggestion[];
  at: string;
}

export interface DB {
  settings: Settings;
  profile?: BusinessProfile;
  /** when the owner finished or skipped onboarding */
  onboarded?: string;
  loopers: Looper[];
  cards: Card[];
  runs: Run[];
  retros: Retro[];
  chief: ChiefMessage[];
  /** one conversation per looper */
  chats?: Record<string, ChiefMessage[]>;
  asks: Ask[];
  /** model picked per conversation: "chief" or a looper id */
  chatModels?: Record<string, ModelChoice>;
}

/** Settings with secrets masked, safe to send to the browser. */
export type PublicSettings = Omit<Settings, "apiKeys" | "integrations" | "oauth" | "chatgptClientId"> & {
  keysSet: Record<Provider, boolean>;
  /** connected subscription accounts, by email */
  subscriptions: { openai?: { email?: string; sharing: boolean; via?: "codex" }; xai?: { email?: string }; anthropic?: never };
  /** Hosted: USD of included Claude credits left (undefined when the server has no hosted credits). */
  creditsLeft?: number;
  /** true when the server runs on the user's machine (ChatGPT sign-in is only allowed there) */
  isLocal: boolean;
  integrations: (Omit<Integration, "headers" | "oauth"> & { headerNames: string[] })[];
};

export type PublicState = Omit<DB, "settings"> & { settings: PublicSettings; user: { email?: string; provider: User["provider"]; name?: string; avatar?: string } };

// — Looper database (Notion-style table; one row = one unit of the looper's work) —

export type DbColumnType = "text" | "number" | "currency" | "date" | "select" | "checkbox" | "url";
export const DB_COLUMN_TYPES: { id: DbColumnType; label: string; icon: string }[] = [
  { id: "text", label: "Text", icon: "Aa" },
  { id: "number", label: "Number", icon: "#" },
  { id: "currency", label: "Currency", icon: "€" },
  { id: "date", label: "Date", icon: "◷" },
  { id: "select", label: "Select", icon: "▾" },
  { id: "checkbox", label: "Checkbox", icon: "☑" },
  { id: "url", label: "URL", icon: "↗" },
];

export interface DbColumn {
  id: string;
  name: string;
  type: DbColumnType;
  /** select options, in order */
  options?: string[];
}

export type DbValue = string | number | boolean | null;

export interface DbRow {
  id: string;
  cells: Record<string, DbValue>;
  createdBy: "looper" | "user";
  createdAt: string;
  updatedAt: string;
}

export interface LooperDatabase {
  name: string;
  /** what one row represents, e.g. "bank transaction" */
  rowNoun: string;
  columns: DbColumn[];
  rows: DbRow[];
}

/** Who a card is for. Older Chief starter cards have no assignee; ones asking to review/confirm/connect are the owner's. */
export function cardAssignee(c: Pick<Card, "assignee" | "createdBy" | "title">): "looper" | "you" {
  if (c.assignee) return c.assignee;
  return c.createdBy === "chief" && /^(review|confirm|connect|approve|decide|check|provide|share)\b/i.test(c.title.trim()) ? "you" : "looper";
}

/** An item on a looper's infinite canvas. Coordinates are canvas units; the view pans and zooms over them. */
export type CanvasItemKind = "note" | "text" | "image" | "link" | "frame" | "arrow";
export interface CanvasItem {
  id: string;
  kind: CanvasItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** note/text body, image caption */
  text?: string;
  /** image source: an uploaded image (/api/canvas/…) or a web URL */
  src?: string;
  /** link target */
  url?: string;
  /** link title and preview image, when the page had them */
  title?: string;
  image?: string;
  /** arrow ends: item ids */
  from?: string;
  to?: string;
  by: "you" | "looper";
  at: string;
  /** the looper's source playbook note: which sources work for its data, kept by playbook_save */
  role?: "playbook";
}
export interface LooperCanvas {
  items: CanvasItem[];
}

/** Can loopers call this provider: a sign-in, a key, or included credits left. */
export function providerReady(s: PublicSettings, p: Provider) {
  const mode = s.authMode[p] ?? (s.subscriptions[p] ? "oauth" : "key");
  if (mode === "credits") return p === "anthropic" && (s.creditsLeft ?? 0) > 0;
  // ChatGPT plans only work when Looper runs on the user's own machine.
  if (mode === "oauth") return !!s.subscriptions[p] && (p !== "openai" || s.isLocal || s.subscriptions.openai?.via === "codex");
  return s.keysSet[p];
}

/** Runs on the workspace's own plan or key, not only on included credits. */
export const ownModelReady = (s: PublicSettings) => PROVIDERS.some((p) => (s.authMode[p.id] ?? (s.subscriptions[p.id] ? "oauth" : "key")) !== "credits" && providerReady(s, p.id));

/** Can loopers call any model with these settings. */
export const modelReady = (s: PublicSettings) => PROVIDERS.some((p) => providerReady(s, p.id));
