"use client";

import { useState, useTransition } from "react";
import { openBillingPortal, startCheckout } from "@/app/billing-actions";
import { Bot, Button, cx } from "@/components/ui";

type Plan = "personal" | "team";
type Current = Plan | "free" | "comped";
type PlanInfo = { id: Plan; name: string; usd: number; credits: number; who: string; lines: string[] };

const money = (n: number) => `$${n.toFixed(2)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

export function BillingView(props: {
  workspace: { name: string; kind: "personal" | "team"; isOwner: boolean };
  current: Current;
  subscription: { plan: Plan; interval: "month" | "year"; status: string; periodEnd?: string; cancelAt?: string } | null;
  hasCustomer: boolean;
  credits: { left: number; granted: number; monthly: boolean };
  infra: { spent: number; cap: number };
  free: { name: string; usd: number; who: string; lines: string[] };
  plans: PlanInfo[];
  want?: Plan;
  welcome: boolean;
  template?: string;
}) {
  const { subscription: sub, workspace, current } = props;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const go = (fn: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>, key: string) =>
    start(async () => {
      setError(null);
      setBusy(key);
      const r = await fn();
      if (r.ok) window.location.assign(r.url);
      else {
        setError(r.error);
        setBusy(null);
      }
    });

  const plan = sub ? props.plans.find((p) => p.id === sub.plan) : undefined;
  const onFree = current === "free";
  const portal = (label: string) => (
    <Button variant="soft" disabled={pending || !workspace.isOwner} onClick={() => go(openBillingPortal, "portal")}>
      {busy === "portal" ? "Opening Stripe…" : label}
    </Button>
  );

  return (
    <div className="mx-auto max-w-[960px] px-4 py-8 sm:px-6">
      {props.welcome && (
        <div className="fade-up tile mb-6 flex items-center gap-4 p-5">
          <Bot dark seed="chief" size={48} className="looping" />
          <div>
            <div className="text-[1.0625rem] font-semibold">You&apos;re on {plan?.name ?? "your new plan"}. Thanks.</div>
            <p className="text-[0.875rem] text-mute">Your Claude credits are ready and refill every month.</p>
          </div>
          <a href={props.template ? `/hire?template=${encodeURIComponent(props.template)}` : "/"} className="ml-auto shrink-0 rounded-full bg-ink px-4 py-2 text-[0.875rem] font-medium text-page hover:bg-ink-2">
            {props.template ? "Hire a looper" : "Back to work"}
          </a>
        </div>
      )}

      <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">{onFree ? "Upgrade your plan" : "Plan & billing"}</h1>
      <p className="mt-1 text-[0.9375rem] text-mute">
        {workspace.kind === "team" ? `${workspace.name} · team workspace` : "Your personal workspace"}
        {" · "}
        {current === "comped" ? "Complimentary" : plan ? `${plan.name} plan` : "Free plan"}
      </p>

      {/* Subscribed: what you pay, when it renews, and the one button that manages it. */}
      {sub && plan && (
        <section className="tile mt-6 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[0.75rem] text-mute">Your subscription</div>
              <div className="mt-1 text-[1.375rem] font-semibold tracking-[-0.02em]">
                {plan.name} <span className="text-[1rem] font-normal text-mute">· {sub.interval === "year" ? "billed yearly" : `$${plan.usd}/month`}</span>
              </div>
              <div className={cx("mt-1 text-[0.875rem]", sub.status === "past_due" ? "text-red" : "text-mute")}>{statusNote(sub)}</div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {props.hasCustomer && portal(sub.status === "past_due" ? "Update card" : "Manage subscription")}
            </div>
          </div>
          <p className="mt-4 text-[0.8125rem] text-mute">
            {workspace.isOwner
              ? "Manage subscription opens Stripe: switch plans, update your card, download invoices or cancel. If you cancel, you keep your plan until the end of the month you paid for, then drop back to Free."
              : "Only the workspace owner can change the plan or the card."}
          </p>
        </section>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Stat
          label={props.credits.monthly ? "Claude credits this month" : "Claude credits left"}
          value={money(props.credits.left)}
          note={
            props.credits.monthly
              ? `of ${money(props.credits.granted)}${sub?.periodEnd && !sub.cancelAt ? ` · refills ${day(sub.periodEnd)}` : ""}`
              : props.credits.granted
                ? `of ${money(props.credits.granted)} starter credits · use your own ChatGPT, Grok or key for free`
                : "AI runs on your own ChatGPT, Grok or key"
          }
          bar={props.credits.granted ? props.credits.left / props.credits.granted : undefined}
        />
        <Stat label="Computer time this month" value={money(props.infra.spent)} note={`of $${props.infra.cap} included on every plan`} bar={props.infra.spent / props.infra.cap} />
      </div>

      {/* Plans: always visible, with the current one marked, so upgrading is one click. */}
      {current !== "comped" && (
        <>
          <h2 className="mt-10 text-[1.125rem] font-semibold">{onFree ? "Plans" : "All plans"}</h2>
          <p className="mt-1 text-[0.875rem] text-mute">Unlimited loopers on every plan. You pay for the workspace, not headcount.</p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <PlanCard name={props.free.name} usd={0} who={props.free.who} lines={props.free.lines} current={onFree}>
              {onFree ? <Badge>Current plan</Badge> : <p className="text-[0.8125rem] text-mute">Cancel in Manage subscription to move back to Free.</p>}
            </PlanCard>
            {props.plans.map((p) => {
              const isCurrent = current === p.id;
              const teamNeedsName = p.id === "team" && workspace.kind === "personal";
              const wrongWorkspace = p.id === "personal" && workspace.kind === "team";
              const featured = !sub && (props.want ?? (workspace.kind === "team" ? "team" : "personal")) === p.id;
              return (
                <PlanCard key={p.id} name={p.name} usd={p.usd} who={p.who} lines={p.lines} current={isCurrent} featured={featured}>
                  {isCurrent ? (
                    <Badge>Current plan</Badge>
                  ) : sub && !teamNeedsName ? (
                    // Already paying in this workspace: plan changes go through Stripe, never a second subscription.
                    <Button variant="soft" className="w-full" disabled={pending || !workspace.isOwner || !props.hasCustomer} onClick={() => go(openBillingPortal, p.id)}>
                      {busy === p.id ? "Opening Stripe…" : `Switch to ${p.name}`}
                    </Button>
                  ) : wrongWorkspace ? (
                    <p className="text-[0.8125rem] text-mute">Individual is for your personal workspace. Switch to it to subscribe.</p>
                  ) : (
                    <>
                      {teamNeedsName && (
                        <input
                          value={teamName}
                          onChange={(e) => setTeamName(e.target.value)}
                          placeholder="Team name, e.g. Acme"
                          aria-label="Team name"
                          className="mb-2 h-10 w-full rounded-full bg-ink/[0.05] px-4 text-[0.875rem] outline-none focus:bg-ink/[0.08]"
                        />
                      )}
                      <Button
                        variant={featured ? "primary" : "soft"}
                        className="w-full"
                        disabled={pending || !workspace.isOwner}
                        onClick={() => go(() => startCheckout(p.id, teamName.trim() || undefined, props.template), p.id)}
                      >
                        {busy === p.id ? "Opening checkout…" : teamNeedsName ? "Create team & subscribe" : `Upgrade to ${p.name}`}
                      </Button>
                      {teamNeedsName && <p className="mt-2 text-[0.75rem] text-mute">Team gets its own workspace you invite people to. Your personal one stays as it is.</p>}
                    </>
                  )}
                </PlanCard>
              );
            })}
          </div>
        </>
      )}

      {!sub && props.hasCustomer && workspace.isOwner && <div className="mt-4">{portal("Past invoices and card")}</div>}
      {!workspace.isOwner && onFree && <p className="mt-4 text-[0.875rem] text-mute">Only the owner of this workspace can choose its plan. Ask them to upgrade.</p>}
      {error && <p className="mt-4 text-[0.875rem] text-red">{error}</p>}

      <p className="mt-8 text-[0.8125rem] leading-relaxed text-mute">
        Connect your ChatGPT or Grok subscription, or an API key, in{" "}
        <a href="/settings" className="underline hover:text-ink">
          Settings
        </a>{" "}
        and AI costs you nothing here. Paid plans add Claude, no subscription needed: credits are spent as your loopers work, reset every month and don&apos;t roll over. Every workspace includes up to ${props.infra.cap} of computer time a month.
      </p>
    </div>
  );
}

function statusNote(s: { status: string; periodEnd?: string; cancelAt?: string }) {
  if (s.status === "past_due") return "Last payment failed. Update your card to keep your plan.";
  if (s.cancelAt) return `Cancelled. Your plan stays until ${day(s.cancelAt)}, then moves to Free.`;
  return s.periodEnd ? `Renews ${day(s.periodEnd)}` : "Active";
}

function Badge({ children }: { children: React.ReactNode }) {
  return <div className="flex h-10 w-full items-center justify-center rounded-full border border-ink/[0.12] text-[0.875rem] font-medium text-mute">{children}</div>;
}

function PlanCard(props: { name: string; usd: number; who: string; lines: string[]; current: boolean; featured?: boolean; children: React.ReactNode }) {
  return (
    <div className={cx("tile flex flex-col p-6", (props.current || props.featured) && "ring-2 ring-ink/80")}>
      <div className="text-[1.0625rem] font-semibold">{props.name}</div>
      <div className="mt-0.5 text-[0.8125rem] text-mute">{props.who}</div>
      <div className="mt-4">
        <span className="text-[2rem] font-semibold tracking-[-0.03em]">${props.usd}</span>
        <span className="text-[0.875rem] text-mute"> /month</span>
      </div>
      <ul className="mt-4 flex flex-1 flex-col gap-1.5 border-t border-ink/[0.06] pt-4 text-[0.875rem]">
        {props.lines.map((f) => (
          <li key={f} className="flex gap-2">
            <span className="text-mute">✓</span>
            {f}
          </li>
        ))}
      </ul>
      <div className="mt-5">{props.children}</div>
    </div>
  );
}

function Stat({ label, value, note, bar }: { label: string; value: string; note?: string; bar?: number }) {
  return (
    <div className="tile p-4">
      <div className="text-[0.75rem] text-mute">{label}</div>
      <div className="mt-1 text-[1.375rem] font-semibold tracking-[-0.02em]">{value}</div>
      {bar !== undefined && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink/[0.08]">
          <div className="h-full rounded-full bg-ink" style={{ width: `${Math.min(100, Math.max(0, bar) * 100)}%` }} />
        </div>
      )}
      {note && <div className="mt-1 text-[0.75rem] text-mute">{note}</div>}
    </div>
  );
}
