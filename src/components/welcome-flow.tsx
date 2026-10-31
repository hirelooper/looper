"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { finishOnboarding, readBusiness, updateProfile } from "@/app/onboarding-actions";
import { confirmHire, draftHire, startSkill } from "@/app/team-actions";
import type { LooperSpec } from "@/lib/agent";
import { templateBySlug } from "@/lib/looper-templates";
import type { Accent, BusinessProfile, MetricSuggestion } from "@/lib/types";
import { AppsPanel } from "./apps-panel";
import { ReviewChat } from "./hire-flow";
import { Bot, Button, cx } from "./ui";

type Hired = { id: string; name: string; color?: Accent; firstSkillId?: string; firstSkillName?: string };
type Step = "business" | "reading" | "metric" | "drafting" | "review" | "start";

const READING = ["Opening your website…", "Reading what you sell…", "Working out who buys…", "Picking three numbers worth moving…"];
const DRAFTING = ["Choosing the business metric to own…", "Picking the apps it needs…", "Designing its database…", "Scheduling its skills…"];

/** New workspace: 1) your business, 2) one metric and the looper that owns it, 3) connect and start. */
export function WelcomeFlow(props: {
  profile?: BusinessProfile;
  workspace: { name: string; team: boolean; canRename: boolean };
  ready: boolean;
  /** USD of free Claude credits the first runs will use, when no plan or key is connected */
  freeCredits?: number;
  resume?: Hired;
  notice?: string;
  taken: string[];
  nextColor: Accent;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(props.resume ? "start" : props.profile ? "metric" : "business");
  const [url, setUrl] = useState(props.profile?.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") ?? "");
  const [wsName, setWsName] = useState(props.workspace.name === "Team" ? "" : props.workspace.name);
  const [profile, setProfile] = useState(props.profile);
  const [goal, setGoal] = useState("");
  const [spec, setSpec] = useState<LooperSpec | null>(null);
  const [hired, setHired] = useState<Hired | null>(props.resume ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (step !== "reading" && step !== "drafting") return;
    const t = setInterval(() => setTick((n) => n + 1), 2200);
    return () => clearInterval(t);
  }, [step]);

  const read = () => {
    setError(null);
    setTick(0);
    setStep("reading");
    start(async () => {
      const r = await readBusiness(url, props.workspace.canRename ? wsName : undefined);
      if (!r.ok) {
        setError(r.error);
        return setStep("business");
      }
      setProfile(r.value);
      setStep("metric");
      router.refresh();
    });
  };

  const pick = (s: MetricSuggestion) => {
    const t = templateBySlug(s.template);
    if (t) {
      setError(null);
      setSpec(structuredClone(t.spec));
      return setStep("review");
    }
    draft(s.goal);
  };

  const draft = (text: string) => {
    setGoal(text);
    setError(null);
    setTick(0);
    setStep("drafting");
    start(async () => {
      const r = await draftHire(text);
      if (r.ok) {
        setSpec(r.value);
        setStep("review");
      } else {
        setError(r.error);
        setStep("metric");
      }
    });
  };

  const hire = () =>
    start(async () => {
      if (!spec) return;
      setError(null);
      const r = await confirmHire(spec);
      if (!r.ok) return setError(r.error);
      setHired({ ...r.value, color: props.nextColor });
      setStep("start");
      router.refresh();
    });

  const finish = (href: string, run?: boolean) =>
    start(async () => {
      setError(null);
      if (run && hired?.firstSkillId) {
        const r = await startSkill(hired.id, hired.firstSkillId);
        if (!r.ok) return setError(r.error);
      }
      await finishOnboarding();
      router.push(href);
      router.refresh();
    });

  const skip = step !== "start" && (
    <button onClick={() => finish("/chief")} disabled={busy} className="shrink-0 whitespace-nowrap text-[0.8125rem] text-mute hover:text-ink">
      Skip setup
    </button>
  );

  return (
    <div className="mx-auto max-w-[760px] px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <Steps step={step} />
        {skip}
      </div>

      {step === "business" && (
        <div className="fade-up mt-8">
          <h1 className="text-[2rem] font-semibold tracking-[-0.03em]">What&apos;s your business?</h1>
          <p className="mt-1 text-[1rem] text-mute">Add your website. Chief reads it and suggests the first numbers worth hiring a looper for.</p>
          <form
            className="tile mt-6 flex flex-col gap-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) read();
            }}
          >
            <label className="flex flex-col gap-1.5 text-[0.8125rem] font-medium text-ink-2">
              Website
              <input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="acme.com"
                className="h-11 rounded-[12px] bg-ink/[0.05] px-4 text-[1rem] font-normal text-ink outline-none placeholder:text-faint focus:bg-ink/[0.08]"
              />
            </label>
            {props.workspace.canRename && (
              <label className="flex flex-col gap-1.5 text-[0.8125rem] font-medium text-ink-2">
                Workspace name
                <input
                  value={wsName}
                  onChange={(e) => setWsName(e.target.value)}
                  placeholder="Taken from your website if you leave it empty"
                  className="h-11 rounded-[12px] bg-ink/[0.05] px-4 text-[1rem] font-normal text-ink outline-none placeholder:text-faint focus:bg-ink/[0.08]"
                />
              </label>
            )}
            <div className="flex justify-end">
              <Button disabled={!url.trim() || busy}>Continue</Button>
            </div>
          </form>
          {error && <p className="mt-3 text-[0.875rem] text-red">{error}</p>}
        </div>
      )}

      {(step === "reading" || step === "drafting") && (
        <div className="fade-up mt-24 flex flex-col items-center gap-5 text-center">
          <Bot dark seed="chief" size={88} className="looping" />
          <div className="text-[1.25rem] font-semibold tracking-[-0.02em]">{step === "reading" ? `Chief is reading ${url.replace(/^https?:\/\//, "")}` : "Chief is drafting your looper"}</div>
          {(() => {
            const lines = step === "reading" ? READING : DRAFTING;
            return (
              <div key={tick} className="fade-up text-[0.9375rem] text-mute">
                {lines[Math.min(tick, lines.length - 1)]}
              </div>
            );
          })()}
          {step === "drafting" && <p className="max-w-[48ch] text-[0.8125rem] text-faint">“{goal}”</p>}
        </div>
      )}

      {step === "metric" && profile && (
        <div className="fade-up mt-8">
          <h1 className="text-[2rem] font-semibold tracking-[-0.03em]">Pick one number to move</h1>
          <p className="mt-1 text-[1rem] text-mute">Each looper owns exactly one business metric. Start with the one that matters most this quarter.</p>
          <ProfileCard profile={profile} onChange={setProfile} onEditSite={() => setStep("business")} />
          <div className="mt-6 flex flex-col gap-2.5">
            {profile.suggestions.map((s, i) => {
              const t = templateBySlug(s.template);
              const needsModel = !t && !props.ready;
              return (
                <button
                  key={s.metric}
                  disabled={busy || needsModel}
                  onClick={() => pick(s)}
                  className="tile group flex items-start gap-4 p-4 text-left transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-ink/[0.06] text-[0.75rem] font-semibold text-mute">{String.fromCharCode(65 + i)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[1rem] font-medium">{s.metric}</span>
                    <span className="mt-0.5 block text-[0.875rem] leading-snug text-mute">{s.why}</span>
                    {t && <span className="mt-2 inline-block rounded-full bg-ink/[0.05] px-2.5 py-0.5 text-[0.75rem] text-ink-2">Ready-made: {t.title}</span>}
                    {needsModel && <span className="mt-2 block text-[0.75rem] text-faint">Connect a model in Settings so Chief can draft this one.</span>}
                  </span>
                  <span className="self-center text-mute transition-transform group-hover:translate-x-0.5">→</span>
                </button>
              );
            })}
          </div>
          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (goal.trim()) draft(goal);
            }}
          >
            <div className="eyebrow">Something else</div>
            <div className="mt-2 flex gap-2 rounded-[20px] border border-ink/[0.08] bg-panel p-2 focus-within:border-ink/25">
              <input
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. Get overdue invoices paid within 30 days"
                className="min-w-0 flex-1 bg-transparent px-3 text-[0.9375rem] outline-none placeholder:text-faint"
              />
              <Button disabled={!goal.trim() || busy || !props.ready}>Draft with Chief</Button>
            </div>
          </form>
          {error && <p className="mt-3 text-[0.875rem] text-red">{error}</p>}
        </div>
      )}

      {step === "review" && spec && (
        <div className="fade-up mt-8">
          <h1 className="text-[2rem] font-semibold tracking-[-0.03em]">Meet {spec.name || "your looper"}</h1>
          <p className="mt-1 text-[1rem] text-mute">Set where the number is today and where you want it, and tell Chief what to change. Nothing runs until you hire.</p>
          <ReviewChat spec={spec} onChange={setSpec} taken={props.taken} color={props.nextColor} canChat={props.ready} />
          {error && <p className="mt-3 text-[0.875rem] text-red">{error}</p>}
          <div className="mt-6 flex items-center justify-between gap-3">
            <button onClick={() => setStep("metric")} className="text-[0.875rem] text-mute hover:text-ink">
              ← Other metrics
            </button>
            <Button onClick={hire} disabled={busy || !spec.name.trim() || props.taken.some((n) => n.toLowerCase() === spec.name.trim().toLowerCase())}>
              {busy ? "Hiring…" : `Hire ${spec.name || "looper"}`}
            </Button>
          </div>
        </div>
      )}

      {step === "start" && hired && (
        <div className="fade-up mt-8">
          <div className="flex items-center gap-4">
            <Bot size={56} color={hired.color} seed={hired.id} />
            <div>
              <h1 className="text-[2rem] font-semibold tracking-[-0.03em]">{hired.name} is on the team</h1>
              <p className="text-[1rem] text-mute">Connect what {hired.name} needs, then watch the first run live.</p>
            </div>
          </div>
          {props.notice && <div className="mt-5 rounded-[12px] bg-ink/[0.05] px-4 py-3 text-[0.875rem]">{props.notice}</div>}
          {!props.ready && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-orange/10 px-4 py-3 text-[0.875rem]">
              <span>Loopers need a model to work. Sign in with your Grok or ChatGPT plan, or add an API key.</span>
              <Link href="/settings" className="shrink-0 font-medium text-ink hover:underline">
                Open Settings →
              </Link>
            </div>
          )}
          {props.ready && props.freeCredits !== undefined && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-ink/[0.05] px-4 py-3 text-[0.875rem]">
              <span>
                {hired.name} starts on ${props.freeCredits.toFixed(2)} of Claude credits from us. Connect your ChatGPT or Grok plan so your loopers keep running after that.
              </span>
              <Link href="/settings" className="shrink-0 font-medium text-ink hover:underline">
                Connect a plan →
              </Link>
            </div>
          )}
          <div className="mt-6">
            <AppsPanel looperId={hired.id} looperName={hired.name} returnTo="welcome" />
          </div>
          {props.workspace.team && <p className="mt-4 text-[0.8125rem] text-mute">Once {hired.name} has a first result, invite your team from the workspace menu.</p>}
          {error && <p className="mt-3 text-[0.875rem] text-red">{error}</p>}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <button onClick={() => finish(`/loopers/${hired.id}`)} disabled={busy} className="text-[0.875rem] text-mute hover:text-ink">
              Skip for now
            </button>
            <Button onClick={() => finish(`/loopers/${hired.id}?tab=chat`, true)} disabled={busy || !props.ready}>
              {busy ? "Starting…" : hired.firstSkillName ? `Start ${hired.firstSkillName} →` : `Open ${hired.name} →`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Steps({ step }: { step: Step }) {
  const order = ["Business", "Metric", "Start"];
  const at = step === "business" || step === "reading" ? 0 : step === "start" ? 2 : 1;
  return (
    <div className="flex items-center gap-2 text-[0.8125rem]">
      {order.map((s, i) => (
        <span key={s} className="flex items-center gap-2">
          <span className={cx("flex h-5 w-5 items-center justify-center rounded-full text-[0.6875rem] font-semibold", i < at ? "bg-ink text-page" : i === at ? "bg-ink/[0.1] text-ink" : "bg-ink/[0.04] text-faint")}>
            {i < at ? "✓" : i + 1}
          </span>
          <span className={i === at ? "font-medium" : "text-mute"}>{s}</span>
          {i < order.length - 1 && <span className="mx-1 h-px w-6 bg-line" />}
        </span>
      ))}
    </div>
  );
}

/** Chief's read of the business, editable in place; saved when a field loses focus. */
function ProfileCard({ profile, onChange, onEditSite }: { profile: BusinessProfile; onChange: (p: BusinessProfile) => void; onEditSite: () => void }) {
  const save = () => void updateProfile({ summary: profile.summary, customers: profile.customers });
  return (
    <div className="tile mt-6 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="eyebrow">Chief&apos;s read of {profile.name}</div>
        <button onClick={onEditSite} className="shrink-0 text-[0.8125rem] text-mute hover:text-ink">
          {profile.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")} · change
        </button>
      </div>
      <textarea
        value={profile.summary}
        onChange={(e) => onChange({ ...profile, summary: e.target.value })}
        onBlur={save}
        rows={3}
        aria-label="What the business does"
        placeholder="What you sell and how you make money"
        className="mt-2 w-full resize-none rounded-[8px] bg-transparent text-[0.9375rem] leading-relaxed text-ink-2 outline-none placeholder:text-faint hover:bg-ink/[0.03] focus:bg-ink/[0.03]"
      />
      <label className="mt-1 flex items-center gap-2 text-[0.8125rem] text-mute">
        Customers
        <input
          value={profile.customers}
          onChange={(e) => onChange({ ...profile, customers: e.target.value })}
          onBlur={save}
          placeholder="Who buys"
          className="min-w-0 flex-1 rounded-[6px] bg-transparent text-[0.875rem] text-ink-2 outline-none placeholder:text-faint hover:bg-ink/[0.03] focus:bg-ink/[0.03]"
        />
      </label>
    </div>
  );
}
