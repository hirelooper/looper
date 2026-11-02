import "server-only";
import { Output } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { callModel, CHIEF_INSTRUCTIONS, hireLooper, proposeLooper, type LooperSpec } from "./agent";
import { deleteCanvas } from "./canvas";
import { coerce, deleteDatabase, mutateDatabase, readDatabase } from "./database";
import { mutate, read } from "./db";
import { kv } from "./kv";
import { hasCredentials, workspaceCredits } from "./llm";
import { LOOPER_TEMPLATES, templateBySlug } from "./looper-templates";
import { normalizeUrl, readSite, type SitePage } from "./site";
import type { BusinessProfile, DbValue, FirstRowsPlan, MetricSuggestion } from "./types";
import { webFetch, webSearch, type SearchHit } from "./web";
import { getWorkspace, renameWorkspace } from "./workspace";

// Onboarding in one go: read the business, pick the one metric worth moving first, hire the looper
// that owns it and fill its table from public sources, so the owner sees real rows within a minute.
// Runs on the server (started on sign-in or from /welcome); the page polls /api/onboarding.

export type OnboardStatus = "reading" | "needs-site" | "hiring" | "filling" | "done" | "failed";

export interface OnboardState {
  /** this attempt; a newer attempt (another metric) makes older steps stop writing */
  run: string;
  status: OnboardStatus;
  startedAt: string;
  updatedAt: string;
  /** the website being read, without https:// */
  site?: string;
  /** which of the profile's suggestions this attempt hires for */
  pick: number;
  looper?: { id: string; name: string };
  table?: { name: string; rowNoun: string };
  /** rows found so far (written once the looper exists) */
  found: number;
  /** fill jobs finished / started */
  jobs: { done: number; total: number };
  /** a line for the owner: what went wrong or what's next */
  note?: string;
}

const KEY = (uid: string) => `onboard:${uid}`;
const now = () => new Date().toISOString();
const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");

export const readOnboarding = (uid: string) => kv.get<OnboardState>(KEY(uid));

/** Apply a change to this attempt's state; false when a newer attempt took over. */
function patch(uid: string, run: string, fn: (s: OnboardState) => void) {
  return kv.update<OnboardState | null, boolean>(KEY(uid), () => null, (s) => {
    if (!s || s.run !== run) return false;
    fn(s);
    s.updatedAt = now();
    return true;
  });
}

// ——— Reading the website ———

const BOT_WALL = /verify you are human|cf-chl|challenges\.cloudflare\.com|captcha-delivery\.com|attention required|unusual traffic|access denied/i;
const siteKey = (h: string) => `site:${h}`;

/**
 * The business's homepage, read the sturdy way: a plain fetch, then a rendering reader for
 * JavaScript sites and bot walls, then what search engines know about the domain. Cached for a few
 * hours so reading it at sign-in makes onboarding instant. Null when nothing worked.
 */
export async function readBusinessSite(input: string): Promise<SitePage | null> {
  const url = normalizeUrl(input);
  const h = url.hostname.replace(/^www\./, "");
  const cached = await kv.get<SitePage>(siteKey(h));
  if (cached) return cached;
  const page = await readUncached(url.toString(), h);
  if (page) await kv.set(siteKey(h), page, 6 * 3600);
  return page;
}

async function readUncached(url: string, h: string): Promise<SitePage | null> {
  const plain = await readSite(url).catch(() => null);
  if (plain && plain.text.length >= 300 && !BOT_WALL.test(plain.text.slice(0, 3000))) return plain;
  const rendered = await webFetch(url, { render: true }).catch(() => null);
  if (rendered && "text" in rendered && rendered.text && rendered.text.length >= 300 && !BOT_WALL.test(rendered.text.slice(0, 3000))) {
    const title = rendered.text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? plain?.title ?? h;
    return { url, title, description: plain?.description ?? "", text: rendered.text.replace(/^(Title|URL Source|Published Time):.*$/gm, "").trim().slice(0, 6000) };
  }
  // Last resort: what search results say about the domain.
  const found = await webSearch(`site:${h}`, 8).catch(() => null);
  if (found?.hits.length)
    return { url, title: plain?.title || found.hits[0].title, description: plain?.description ?? "", text: found.hits.map((x) => `${x.title}: ${x.snippet}`).join("\n").slice(0, 6000) };
  return plain?.title ? plain : null;
}

/** Start reading a company's site while its owner types the sign-in code. */
export async function prefetchSite(domain: string) {
  await readBusinessSite(domain).catch(() => undefined);
}

// ——— The business profile and the first metric ———

// Every field required and no size limits in the schema: models keep to them unevenly (Claude's
// structured output drops min/max, OpenAI's strict mode refuses optional fields), so sizes are
// asked for in the descriptions and trimmed in code.
const firstColumn = z.object({
  name: z.string(),
  type: z.enum(["text", "number", "currency", "date", "select", "checkbox", "url"]),
  options: z.array(z.string()).describe("choices for a select column, else empty"),
});

const tableSpec = z.object({
  name: z.string().describe("the table's name, e.g. 'Search opportunities'"),
  rowNoun: z.string().describe("what one row is, e.g. 'opportunity'"),
  columns: z.array(firstColumn).describe("3 to 9 columns: a title column first; columns web search results can fill today, plus up to 2 the looper fills later from its apps"),
});

const plan = z.object({
  queries: z.array(z.string()).describe("3 to 6 web searches whose results give real rows for this table today, before any app is connected; specific to this business, its market, competitors and customers"),
  table: tableSpec,
});

const profileSchema = z.object({
  name: z.string().describe("the business or product name"),
  summary: z.string().describe("2 short sentences: what it sells and how it makes money, in plain words"),
  customers: z.string().describe("who buys, in one short line, e.g. 'Dutch freelancers and small agencies'"),
  suggestions: z
    .array(
      z.object({
        metric: z.string().describe("the metric, short, e.g. 'Organic signups per week'"),
        why: z.string().describe("one short sentence on why this one, for this business"),
        goal: z.string().describe("lowercase phrase that completes 'Hire a looper to …', e.g. 'grow organic signups from search to 100 a week'"),
        template: z.enum(["none", ...LOOPER_TEMPLATES.map((t) => t.slug)]).describe("a ready-made looper that fits exactly, else 'none'"),
      }),
    )
    .describe("exactly 3, best first: the one that brings revenue or customers soonest"),
  firstRows: plan.describe("for the FIRST suggestion only: its table and the searches that fill it today"),
});

const TABLE_RULES = `The table is what the owner sees first, filled within a minute from public web search results only (no apps are connected yet). Pick rows that are useful on their own, e.g. for SEO: queries where competitors rank or get cited by AI and this business doesn't; for sales: companies that match the customers; for support: questions people ask about the product in public; for partnerships: lists and directories that name competitors but not this business. Never a table that only an app can fill (tickets, invoices, own analytics).`;

const templateTables = () =>
  LOOPER_TEMPLATES.map((t) => `- ${t.slug}: ${t.title}, owns "${t.spec.metric.name}". ${t.pitch} Its table "${t.spec.database?.name}": ${t.spec.database?.columns.map((c) => c.name).join(", ")}`).join("\n");

/** Chief reads the business (its site, or the owner's own words) and suggests three metrics, best first. */
async function profileBusiness(uid: string, input: { site?: SitePage | null; url?: string; about?: string }): Promise<BusinessProfile> {
  const db = await read(uid);
  const url = input.site?.url ?? (input.url ? normalizeUrl(input.url).toString() : "");
  const fallbackName = input.site?.title.split(/\s[|–—-]\s|[|:]/)[0].trim() || (url ? host(url) : "Your business");
  const out = await callModel(
    uid,
    db.settings,
    {
      model: db.chatModels?.chief,
      usage: { source: "chief", kind: "chat" },
      included: true,
      instructions: `${CHIEF_INSTRUCTIONS}\n\nA new owner just joined. Say what the business is, then pick the three business metrics a looper should move first, best first. Prefer numbers that bring revenue or customers and that a looper can move with everyday apps (Gmail, Search Console, social, CRM, docs). Make the three different from each other. Use a ready-made looper when one fits exactly:\n${templateTables()}\n\nFor the first suggestion, also design its table and the web searches that fill it. If it uses a ready-made looper, use that looper's table and columns exactly. ${TABLE_RULES}`,
      prompt: [
        input.site ? `Website: ${input.site.url}\nTitle: ${input.site.title}\nDescription: ${input.site.description}\n\n${input.site.text}` : url ? `Website: ${url} (it couldn't be opened)` : "",
        input.about ? `The owner describes the business: ${input.about}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      maxSteps: 1,
    },
    Output.object({ schema: profileSchema }),
  ).then((r) => r.output as Promise<z.infer<typeof profileSchema>>);
  const suggestions: MetricSuggestion[] = out.suggestions.slice(0, 3).map((s) => ({ metric: s.metric, why: s.why, goal: s.goal, ...(s.template !== "none" ? { template: s.template } : {}) }));
  if (!suggestions.length) throw new Error("Chief suggested no metrics");
  suggestions[0].firstRows = tidyPlan(out.firstRows);
  return { url, name: out.name || fallbackName, summary: out.summary, customers: out.customers, suggestions, at: now() };
}

/** The table and searches for a suggestion that didn't get them with the profile (the owner picked another metric). */
async function planFirstRows(uid: string, profile: BusinessProfile, s: MetricSuggestion): Promise<FirstRowsPlan> {
  const db = await read(uid);
  const t = templateBySlug(s.template);
  const r = await callModel(
    uid,
    db.settings,
    {
      model: db.chatModels?.chief,
      usage: { source: "chief", kind: "chat" },
      included: true,
      fast: true,
      instructions: `${CHIEF_INSTRUCTIONS}\n\nDesign the first table for a new looper and the web searches that fill it. ${TABLE_RULES}${t?.spec.database ? `\nUse this table and its columns exactly: "${t.spec.database.name}": ${t.spec.database.columns.map((c) => `${c.name} (${c.type})`).join(", ")}` : ""}`,
      prompt: `The business: ${profile.name} (${profile.url || "no website"}). ${profile.summary} Customers: ${profile.customers}\n\nThe looper will move: ${s.metric}. Goal: ${s.goal}.`,
      maxSteps: 1,
    },
    Output.object({ schema: plan }),
  );
  return tidyPlan((await r.output) as FirstRowsPlan);
}

/** Sizes the schema only asks for: 3–9 columns, up to 6 searches, select options only on select columns. */
function tidyPlan(p: FirstRowsPlan): FirstRowsPlan {
  const columns = p.table.columns
    .filter((c) => c.name?.trim())
    .slice(0, 9)
    .map((c) => (c.type === "select" ? c : { name: c.name, type: c.type }));
  return { queries: p.queries.filter((q) => q?.trim()).slice(0, 6), table: { ...p.table, columns } };
}

// ——— Filling the table ———

const rowsSchema = z.object({
  rows: z.array(z.array(z.string()).describe("one value per column, in column order; empty string when the results don't say")).describe("up to 8"),
});

/** Rows for the table from one batch of search results. Only facts the results state; every row cites its source. */
async function rowsFrom(uid: string, profile: BusinessProfile, table: FirstRowsPlan["table"], source: string, hits: (SearchHit & { query: string })[]) {
  if (!hits.length) return [];
  const db = await read(uid);
  const r = await callModel(
    uid,
    db.settings,
    {
      model: db.chatModels?.chief,
      usage: { source: "chief", kind: "run" },
      included: true,
      fast: true,
      instructions: `You fill the first rows of a looper's table for ${profile.name} (${profile.url || "no website"}): ${profile.summary} Customers: ${profile.customers}\n\nTable "${table.name}", one row = one ${table.rowNoun}. Columns in order: ${table.columns.map((c) => `${c.name} (${c.type}${c.options?.length ? `: ${c.options.join(" / ")}` : ""})`).join(", ")}.\n\nRules: use only facts in the search results below. Put the result's URL in "${source}". Leave a value empty when the results don't state it; never estimate numbers (impressions, clicks, revenue), because the looper fills those later from its apps. For a status column use its first option. Skip results that aren't useful to this business. Better 4 sharp rows than 8 vague ones.`,
      prompt: hits.map((x, i) => `[${i + 1}] search "${x.query}"\n${x.title}\n${x.url}\n${x.snippet}`).join("\n\n"),
      maxSteps: 1,
    },
    Output.object({ schema: rowsSchema }),
  );
  return ((await r.output) as z.infer<typeof rowsSchema>).rows.slice(0, 8);
}

/** A table always has somewhere to cite where a row came from. */
function withSource(table: FirstRowsPlan["table"]): { table: FirstRowsPlan["table"]; source: string } {
  const existing = table.columns.find((c) => c.type === "url" && /source|link|url/i.test(c.name));
  if (existing) return { table, source: existing.name };
  return { table: { ...table, columns: [...table.columns, { name: "Source", type: "url" }] }, source: "Source" };
}

// ——— The whole flow ———

const NAMES = ["Sage", "Ivy", "Nova", "Remy", "Juno", "Otto", "Mila", "Theo"];

interface Input {
  url?: string;
  about?: string;
  /** a team still called "Team" takes the business's name (owner only) */
  renameTeam?: boolean;
}

/** Start onboarding from a website or the owner's own description; replaces any earlier attempt. */
export async function startOnboarding(uid: string, input: Input) {
  const run = nanoid(8);
  const site = input.url ? host(normalizeUrl(input.url).toString()) : undefined;
  await kv.set(KEY(uid), { run, status: "reading", startedAt: now(), updatedAt: now(), site, pick: 0, found: 0, jobs: { done: 0, total: 0 } } satisfies OnboardState);
  return { run, done: profileAndHire(uid, run, input) };
}

async function profileAndHire(uid: string, run: string, input: Input) {
  try {
    const [db, credits] = await Promise.all([read(uid), workspaceCredits(uid)]);
    if (!hasCredentials(db.settings, credits)) {
      await patch(uid, run, (s) => ((s.status = "failed"), (s.note = "Loopers need a model to work. Connect your Grok or ChatGPT plan, or add an API key in Settings.")));
      return;
    }
    const page = input.url ? await readBusinessSite(input.url).catch(() => null) : null;
    if (input.url && !page && !input.about) {
      await patch(uid, run, (s) => ((s.status = "needs-site"), (s.note = `Couldn't open ${s.site}. Check the address, or describe what you do in a sentence.`)));
      return;
    }
    const profile = await profileBusiness(uid, { site: page, url: input.url, about: input.about });
    await mutate(uid, (d) => void (d.profile = profile));
    if (input.renameTeam) {
      const ws = await getWorkspace(uid);
      if (ws?.kind === "team" && ws.name === "Team" && profile.name) await renameWorkspace(uid, profile.name);
    }
    await hireAndFill(uid, run, 0);
  } catch (e) {
    console.error("[onboarding]", e);
    await patch(uid, run, (s) => ((s.status = "failed"), (s.note = "Chief couldn't finish reading your business. Try again, or describe what you do in a sentence.")));
  }
}

/** Switch to another of the suggested metrics: the looper hired for the old one goes, a new one is hired and filled. */
export async function switchOnboarding(uid: string, pick: number) {
  const prev = await readOnboarding(uid);
  const profile = (await read(uid)).profile;
  if (!profile?.suggestions[pick]) throw new Error("Pick one of the suggested metrics.");
  if (prev && !["done", "failed"].includes(prev.status)) throw new Error("Chief is still working. Try again in a moment.");
  if (prev?.looper) await removeLooper(uid, prev.looper.id);
  const run = nanoid(8);
  await kv.set(KEY(uid), { run, status: "hiring", startedAt: now(), updatedAt: now(), site: profile.url ? host(profile.url) : undefined, pick, found: 0, jobs: { done: 0, total: 0 } } satisfies OnboardState);
  return {
    run,
    done: hireAndFill(uid, run, pick).catch(async (e) => {
      console.error("[onboarding] switch", e);
      await patch(uid, run, (s) => ((s.status = "failed"), (s.note = "Chief couldn't set up that looper. Try again or pick another number.")));
    }),
  };
}

async function removeLooper(uid: string, id: string) {
  await Promise.all([deleteDatabase(uid, id), deleteCanvas(uid, id)]);
  await mutate(uid, (db) => {
    db.loopers = db.loopers.filter((x) => x.id !== id);
    db.cards = db.cards.filter((x) => x.looperId !== id);
    db.runs = db.runs.filter((x) => x.looperId !== id);
  });
}

/**
 * Hire the looper for one suggestion and fill its table. The searches and the row writing start
 * right away, in parallel with drafting the looper, so rows land as soon as the looper exists.
 */
async function hireAndFill(uid: string, run: string, pick: number) {
  const db = await read(uid);
  const profile = db.profile!;
  const s = profile.suggestions[pick];
  const template = templateBySlug(s.template);
  const firstRows = s.firstRows ?? (await planFirstRows(uid, profile, s));
  const { table, source } = withSource(template?.spec.database ?? firstRows.table);
  if (!(await patch(uid, run, (st) => ((st.status = "hiring"), (st.table = { name: table.name, rowNoun: table.rowNoun }))))) return;

  // Draft (or take the ready-made looper) while the searches run.
  const taken = new Set(db.loopers.map((l) => l.name.toLowerCase()));
  const drafting: Promise<LooperSpec> = template
    ? Promise.resolve(structuredClone(template.spec))
    : proposeLooper(uid, `${s.goal}. Why: ${s.why}`, { included: true });
  const looperReady = drafting.then(async (spec) => {
    if (taken.has(spec.name.toLowerCase())) spec.name = NAMES.find((n) => !taken.has(n.toLowerCase())) ?? `${spec.name} 2`;
    spec.database = table;
    if ((await readOnboarding(uid))?.run !== run) return null;
    const hired = await hireLooper(uid, spec);
    await patch(uid, run, (st) => ((st.looper = { id: hired.id, name: hired.name }), (st.status = "filling")));
    return hired.id;
  });

  // Two searches per job, every job writing its rows as soon as it has them.
  const queries = firstRows.queries.slice(0, 6);
  const groups = Array.from({ length: Math.ceil(queries.length / 2) }, (_, i) => queries.slice(i * 2, i * 2 + 2));
  await patch(uid, run, (st) => void (st.jobs.total = groups.length));
  const seen = new Set<string>();
  const fill = groups.map(async (group) => {
    try {
      const results = await Promise.all(group.map((q) => webSearch(q, 6).then((r) => r.hits.map((h) => ({ ...h, query: q })))));
      const hits = results.flat().filter((h) => !seen.has(h.url) && (seen.add(h.url), true));
      const rows = await rowsFrom(uid, profile, table, source, hits);
      const id = await looperReady;
      if (id && rows.length) {
        const added = await addRows(uid, id, rows);
        await patch(uid, run, (st) => void (st.found += added));
      }
    } catch (e) {
      console.error("[onboarding] fill", e);
    } finally {
      await patch(uid, run, (st) => void (st.jobs.done += 1));
    }
  });
  const [id] = await Promise.all([looperReady, ...fill]);
  await patch(uid, run, (st) => {
    st.status = id ? "done" : "failed";
    if (!id) st.note = "Chief couldn't set up the looper. Try again.";
    else if (!st.found) st.note = `Public sources had nothing solid for ${st.table?.name ?? "this table"} yet. Connect ${st.looper?.name ?? "the looper"}'s apps and it fills the table on its first run.`;
  });
}

/** Append rows (values in column order), skipping ones whose title is already in the table. */
async function addRows(uid: string, looperId: string, rows: string[][]) {
  return mutateDatabase(uid, looperId, (box) => {
    const table = box.db;
    if (!table) return 0;
    const titleCol = table.columns[0];
    const titles = new Set(table.rows.map((r) => String(r.cells[titleCol.id] ?? "").toLowerCase()));
    let added = 0;
    const at = now();
    for (const values of rows) {
      const title = (values[0] ?? "").trim();
      if (!title || titles.has(title.toLowerCase())) continue;
      titles.add(title.toLowerCase());
      const cells: Record<string, DbValue> = {};
      table.columns.forEach((col, i) => (cells[col.id] = coerce(col, values[i] ?? "")));
      table.rows.push({ id: nanoid(8), cells, createdBy: "looper", createdAt: at, updatedAt: at });
      added++;
    }
    return added;
  });
}

/** What the welcome page shows while onboarding runs: the state, Chief's read and the first rows. */
export async function onboardingView(uid: string) {
  const [state, db] = await Promise.all([readOnboarding(uid), read(uid)]);
  if (!state) return null;
  const looper = state.looper && db.loopers.find((l) => l.id === state.looper!.id);
  const table = looper ? await readDatabase(uid, looper.id) : null;
  // The title and a few more columns, plus where each row came from.
  const all = table?.columns ?? [];
  const src = all.find((c) => c.type === "url" && /source|link|url/i.test(c.name));
  const columns = [...all.filter((c) => c !== src).slice(0, 4), ...(src ? [src] : [])];
  return {
    state,
    profile: db.profile ? { name: db.profile.name, summary: db.profile.summary, suggestions: db.profile.suggestions.map((s) => ({ metric: s.metric, why: s.why })) } : null,
    looper: looper ? { id: looper.id, name: looper.name, color: looper.color, metric: looper.metric.name, apps: (looper.apps ?? []).map((a) => a.name) } : null,
    table: table
      ? {
          columns: columns.map((c) => ({ name: c.name, type: c.type })),
          rows: table.rows.slice(0, 12).map((r) => ({ id: r.id, cells: columns.map((c) => r.cells[c.id] ?? null) })),
          total: table.rows.length,
        }
      : null,
  };
}
export type OnboardingView = NonNullable<Awaited<ReturnType<typeof onboardingView>>>;
