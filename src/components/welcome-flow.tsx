"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { beginOnboarding, finishOnboarding, switchMetric } from "@/app/onboarding-actions";
import type { OnboardingView } from "@/lib/onboarding";
import { Bot, Button, cx, fmt } from "./ui";

const WORKING = new Set(["reading", "hiring", "filling"]);

/**
 * New workspace: Chief reads the business, picks the one metric to move first, hires the looper
 * that owns it and fills its table from public sources while the owner watches. With a work email
 * none of it needs typing; otherwise one field: the website, or a sentence about the business.
 */
export function WelcomeFlow(props: { initial: OnboardingView | null; site: string; ready: boolean; freeCredits?: number; team: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<OnboardingView | null>(props.initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const status = view?.state.status;
  const working = !!status && WORKING.has(status);

  // Follow the server while Chief works; stop once it's done.
  useEffect(() => {
    if (!working) return;
    let alive = true;
    const t = setInterval(async () => {
      const next: OnboardingView | null = await fetch("/api/onboarding", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (alive && next) setView(next);
    }, 1500);
    return () => ((alive = false), clearInterval(t));
  }, [working]);

  const refresh = () =>
    fetch("/api/onboarding", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => v && setView(v));

  const begin = (input: { url?: string; about?: string }) =>
    start(async () => {
      setError(null);
      const r = await beginOnboarding(input);
      if (!r.ok) return setError(r.error);
      await refresh();
    });

  const other = (pick: number) =>
    start(async () => {
      setError(null);
      const r = await switchMetric(pick);
      if (!r.ok) return setError(r.error);
      await refresh();
    });

  const finish = (href: string) =>
    start(async () => {
      await finishOnboarding();
      router.push(href);
      router.refresh();
    });

  const showForm = !view || status === "needs-site" || (status === "failed" && !view.looper);

  return (
    <div className="mx-auto max-w-[820px] px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Bot dark seed="chief" size={36} className={working ? "looping" : undefined} />
          <span className="text-[0.875rem] font-medium">Chief</span>
        </div>
        {!(status === "done" && view?.looper) && (
          <button onClick={() => finish("/chief")} disabled={busy} className="text-[0.8125rem] text-mute hover:text-ink">
            Skip setup
          </button>
        )}
      </div>

      {!props.ready && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-orange/10 px-4 py-3 text-[0.875rem]">
          <span>Loopers need a model to work. Sign in with your Grok or ChatGPT plan, or add an API key.</span>
          <Link href="/settings" className="shrink-0 font-medium text-ink hover:underline">
            Open Settings →
          </Link>
        </div>
      )}

      {showForm ? (
        <Start site={props.site} note={view?.state.note} busy={busy} ready={props.ready} onStart={begin} />
      ) : (
        view && <Live view={view} busy={busy} onOther={other} onOpen={finish} freeCredits={props.freeCredits} team={props.team} />
      )}
      {error && <p className="mt-3 text-[0.875rem] text-red">{error}</p>}
    </div>
  );
}

/** One field: the website, or a sentence about the business when there's no site. */
function Start({ site, note, busy, ready, onStart }: { site: string; note?: string; busy: boolean; ready: boolean; onStart: (i: { url?: string; about?: string }) => void }) {
  const [url, setUrl] = useState(site);
  const [about, setAbout] = useState("");
  const [noSite, setNoSite] = useState(false);
  const field = "h-12 w-full rounded-[12px] bg-ink/[0.05] px-4 text-[1rem] text-ink outline-none placeholder:text-faint focus:bg-ink/[0.08]";
  return (
    <div className="fade-up mt-10">
      <h1 className="text-[1.75rem] font-semibold leading-[1.1] sm:text-[2.25rem] tracking-[-0.03em]">
        What&apos;s your business? <span className="text-faint">Chief reads it, picks the one number worth moving first, and hires a looper that starts on it in under a minute.</span>
      </h1>
      {note && <div className="mt-6 rounded-[12px] bg-ink/[0.05] px-4 py-3 text-[0.875rem]">{note}</div>}
      <form
        className="mt-8 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (noSite ? about.trim() : url.trim()) onStart(noSite ? { about } : { url, about: about.trim() || undefined });
        }}
      >
        {noSite ? (
          <textarea
            autoFocus
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            rows={3}
            placeholder="e.g. I run a bookkeeping practice for Dutch freelancers, mostly referrals."
            className="w-full resize-none rounded-[12px] bg-ink/[0.05] px-4 py-3 text-[1rem] leading-relaxed text-ink outline-none placeholder:text-faint focus:bg-ink/[0.08]"
          />
        ) : (
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="acme.com" aria-label="Website" className={field} />
        )}
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={() => setNoSite(!noSite)} className="text-[0.875rem] text-mute hover:text-ink">
            {noSite ? "I have a website" : "No website yet? Describe what you do"}
          </button>
          <Button disabled={busy || !ready || !(noSite ? about.trim() : url.trim())}>{busy ? "Starting…" : "Start"}</Button>
        </div>
      </form>
    </div>
  );
}

const STEPS = [
  { at: "reading", label: (v: OnboardingView) => (v.state.site ? `Reading ${v.state.site}` : "Reading about your business") },
  { at: "hiring", label: (v: OnboardingView) => (v.state.table ? `Hiring a looper for ${v.profile?.suggestions[v.state.pick]?.metric ?? "your first metric"}` : "Picking the number to move first") },
  { at: "filling", label: (v: OnboardingView) => `Filling ${v.state.table?.name ?? "its table"} from public sources` },
] as const;
const ORDER = ["reading", "hiring", "filling", "done"];

/** Chief at work: what it read, the metric it picked and the table filling in. */
function Live({ view, busy, onOther, onOpen, freeCredits, team }: { view: OnboardingView; busy: boolean; onOther: (i: number) => void; onOpen: (href: string) => void; freeCredits?: number; team: boolean }) {
  const { state, profile, looper, table } = view;
  const done = state.status === "done";
  const at = ORDER.indexOf(state.status === "failed" ? "done" : state.status);
  const pick = profile?.suggestions[state.pick];
  const rows = table?.total ?? 0;
  return (
    <div className="fade-up mt-10">
      <h1 className="text-[1.75rem] font-semibold leading-[1.1] sm:text-[2.25rem] tracking-[-0.03em]">
        {done && looper ? (
          <>
            {looper.name} found {rows} {plural(state.table?.rowNoun ?? "row", rows)}.{" "}
            <span className="text-faint">Each one is a place to move {looper.metric.toLowerCase()}, with the source it came from.</span>
          </>
        ) : profile ? (
          <>
            {profile.name}. <span className="text-faint">{profile.summary}</span>
          </>
        ) : (
          <>
            One moment. <span className="text-faint">Chief is reading {state.site ?? "about your business"}.</span>
          </>
        )}
      </h1>

      {!done && (
        <ol className="mt-8 flex flex-col gap-2.5 text-[0.9375rem]">
          {STEPS.map((s, i) => (
            <li key={s.at} className={cx("flex items-center gap-3", i > at && "text-faint")}>
              <span className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold", i < at ? "bg-ink text-page" : i === at ? "bg-ink/[0.1]" : "bg-ink/[0.04]")}>
                {i < at ? "✓" : i + 1}
              </span>
              <span className={i === at ? "font-medium" : undefined}>{s.label(view)}</span>
              {s.at === "filling" && i === at && <span className="tabular-nums text-mute">{rows} so far</span>}
            </li>
          ))}
        </ol>
      )}

      {pick && (
        <div className="tile mt-8 flex items-start gap-4 p-5">
          {looper ? <Bot size={44} color={looper.color} seed={looper.id} /> : <Bot dark seed="chief" size={44} className="looping" />}
          <div className="min-w-0 flex-1">
            <div className="text-[0.8125rem] text-mute">{looper ? `${looper.name} owns one number` : "The number to move first"}</div>
            <div className="mt-0.5 text-[1.125rem] font-semibold tracking-[-0.01em]">{pick.metric}</div>
            <p className="mt-1 text-[0.9375rem] leading-snug text-mute">{pick.why}</p>
          </div>
        </div>
      )}

      {table && (table.rows.length > 0 || done) && <FirstRows table={table} />}

      {state.note && <div className="mt-5 rounded-[12px] bg-ink/[0.05] px-4 py-3 text-[0.875rem]">{state.note}</div>}

      {done && looper && (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <button onClick={() => onOpen(`/loopers/${looper.id}?tab=apps`)} disabled={busy} className="text-left text-[0.875rem] text-mute hover:text-ink">
              {looper.apps.length ? `Connect ${looper.apps.join(" and ")} to fill the rest →` : "Connect apps →"}
            </button>
            <Button onClick={() => onOpen(`/loopers/${looper.id}?tab=database`)} disabled={busy}>
              Open {looper.name}&apos;s table →
            </Button>
          </div>
          {profile && profile.suggestions.length > 1 && (
            <div className="mt-10">
              <div className="text-[0.8125rem] text-mute">Rather start on another number?</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {profile.suggestions.map((s, i) =>
                  i === state.pick ? null : (
                    <button key={s.metric} onClick={() => onOther(i)} disabled={busy} title={s.why} className="rounded-full bg-ink/[0.05] px-3.5 py-1.5 text-[0.875rem] hover:bg-ink/[0.09] disabled:opacity-50">
                      {s.metric}
                    </button>
                  ),
                )}
              </div>
            </div>
          )}
          {freeCredits !== undefined && (
            <p className="mt-6 text-[0.8125rem] text-mute">
              {looper.name} runs on ${freeCredits.toFixed(2)} of Claude credits from us.{" "}
              <Link href="/settings" className="text-ink hover:underline">
                Connect your ChatGPT or Grok plan
              </Link>{" "}
              to keep it running after that.
            </p>
          )}
          {team && <p className="mt-2 text-[0.8125rem] text-mute">Invite your team from the workspace menu when you&apos;re ready.</p>}
        </>
      )}
    </div>
  );
}

/** "opportunity" → "opportunities", "lead" → "leads". */
const plural = (noun: string, n: number) => (n === 1 ? noun : /[^aeiou]y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : /(s|x|ch|sh)$/i.test(noun) ? `${noun}es` : `${noun}s`);

type Cell = string | number | boolean | null;

/** The looper's first rows, newest at the bottom, as they land. */
function FirstRows({ table }: { table: NonNullable<OnboardingView["table"]> }) {
  const show = (v: Cell, type: string) => {
    if (v === null || v === "") return <span className="text-faint">·</span>;
    if (type === "url" && typeof v === "string")
      return (
        <a href={v} target="_blank" rel="noopener noreferrer" className="text-mute hover:text-ink hover:underline">
          {v.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "")}
        </a>
      );
    if (typeof v === "boolean") return v ? "✓" : "";
    if (typeof v === "number") return <span className="tabular-nums">{fmt(v)}</span>;
    return v;
  };
  return (
    <div className="tile mt-4 overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-[0.875rem]">
        <thead>
          <tr className="border-b border-line text-[0.75rem] text-mute">
            {table.columns.map((c) => (
              <th key={c.name} className="px-4 py-2.5 font-medium">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.id} className="fade-up border-b border-line last:border-0">
              {r.cells.map((v, i) => (
                <td key={i} className={cx("px-4 py-2.5 align-top", i === 0 ? "font-medium" : "text-ink-2")}>
                  {show(v as Cell, table.columns[i].type)}
                </td>
              ))}
            </tr>
          ))}
          {!table.rows.length && (
            <tr>
              <td colSpan={table.columns.length} className="px-4 py-6 text-center text-mute">
                No rows yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {table.total > table.rows.length && <div className="px-4 py-2.5 text-[0.8125rem] text-mute">and {table.total - table.rows.length} more in the table</div>}
    </div>
  );
}
