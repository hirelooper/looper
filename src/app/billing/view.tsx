"use client";

import { useState, useTransition } from "react";
import { openBillingPortal, startCheckout } from "@/app/billing-actions";
import { Bot, Button, cx } from "@/components/ui";

type Plan = "personal" | "team";

const num = (n: number) => n.toFixed(2);
const FEATURES: Record<"free" | Plan, string[]> = {
  free: ["Unlimited loopers", "AI on your ChatGPT or Grok plan, or your API key", "Approvals before anything goes out", "Apps, boards, database, canvas, retros"],
  personal: ["Everything in Free", "Claude included, no subscription needed", "Credits reset every month", "Your own plan or key still works alongside"],
  team: ["Everything in Individual", "Unlimited collaborators", "Shared loopers, chats and approvals", "Invite links and roles"],
};

export function BillingView(props: {
  workspace: { name: string; kind: "personal" | "team"; isOwner: boolean };
  billing: { plan: Plan; status: string; periodEnd?: string; cancelAt?: string; hasCustomer: boolean } | null;
  paid: boolean;
  comped: boolean;
  credits: { left: number; granted: number; monthly: boolean };
  markup: number;
  infra: { spent: number; cap: number };
  plans: { id: Plan; name: string; usd: number; credits: number; blurb: string }[];
  want?: Plan;
  welcome: boolean;
  template?: string;
}) {
  const { billing, workspace } = props;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const current = props.paid && billing && billing.status !== "canceled" ? billing.plan : undefined;
  const planName = props.comped ? "Complimentary" : current ? props.plans.find((p) => p.id === current)?.name ?? "Paid" : "Free";

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

  return (
    <div className="mx-auto max-w-[960px] px-4 py-8 sm:px-6">
      {props.welcome && (
        <div className="fade-up tile mb-6 flex items-center gap-4 p-5">
          <Bot dark seed="chief" size={48} className="looping" />
          <div>
            <div className="text-[1.0625rem] font-semibold">You&apos;re in. Welcome to Looper.</div>
            <p className="text-[0.875rem] text-mute">Your credits for this month are ready. Tell Chief about your business and hire your first looper in three steps.</p>
          </div>
          <a href={props.template ? `/hire?template=${encodeURIComponent(props.template)}` : "/welcome"} className="ml-auto shrink-0 rounded-full bg-ink px-4 py-2 text-[0.875rem] font-medium text-page hover:bg-ink-2">
            {props.template ? "Hire a looper" : "Get started"}
          </a>
        </div>
      )}

      <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">Plan & credits</h1>
      <p className="mt-1 text-[0.9375rem] text-mute">{workspace.kind === "team" ? `${workspace.name} · team workspace` : "Your personal workspace"}</p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Plan" value={planName} note={billing && current ? statusNote(billing) : props.comped ? "On the house" : billing?.status === "past_due" ? statusNote(billing) : "AI on your own plan or key"} />
        <Stat
          label="Claude credits left"
          value={num(props.credits.left)}
          note={props.credits.granted ? `of ${Math.round(props.credits.granted)}${props.credits.monthly ? " this month" : " to try Looper"}` : "Use your own Grok, ChatGPT or key"}
          bar={props.credits.granted ? props.credits.left / props.credits.granted : undefined}
        />
        <Stat label="Computers this month" value={`$${num(props.infra.spent)}`} note={`of $${props.infra.cap} included`} bar={props.infra.spent / props.infra.cap} />
      </div>

      {billing?.hasCustomer && workspace.isOwner && (
        <div className="mt-4">
          <Button variant="soft" size="sm" disabled={pending} onClick={() => go(openBillingPortal, "portal")}>
            {busy === "portal" ? "Opening…" : current ? "Manage subscription, invoices and card" : "Past invoices and card"}
          </Button>
        </div>
      )}

      {!props.comped && (
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className={cx("tile flex flex-col p-6", !current && !props.want && "ring-2 ring-ink")}>
            <PlanHead name="Free" price="$0" />
            <p className="mt-1 text-[0.875rem] text-mute">Bring your own subscription</p>
            <div className="mt-4 rounded-[12px] bg-ink/[0.05] px-3.5 py-2.5 text-[0.875rem]">
              <span className="font-semibold">Nothing billed by us</span>
            </div>
            <Features list={FEATURES.free} />
            <a href="/settings" className={cx("mt-4 block rounded-full px-4 py-2.5 text-center text-[0.875rem] font-medium", current ? "bg-ink/[0.05] text-mute hover:text-ink" : "bg-ink/[0.05] hover:bg-ink/[0.08]")}>
              {current ? "Connect your plan in Settings" : "Current plan · connect your AI"}
            </a>
          </div>
          {props.plans.map((p) => {
            const isCurrent = current === p.id;
            const teamNeedsName = p.id === "team" && workspace.kind === "personal";
            const wrongWorkspace = p.id === "personal" && workspace.kind === "team";
            const disabled = pending || wrongWorkspace || !workspace.isOwner;
            return (
              <div key={p.id} className={cx("tile flex flex-col p-6", (isCurrent || (!current && props.want === p.id)) && "ring-2 ring-ink")}>
                <PlanHead name={p.name} price={`$${p.usd}`} />
                <p className="mt-1 text-[0.875rem] text-mute">{p.blurb}</p>
                <div className="mt-4 rounded-[12px] bg-ink/[0.05] px-3.5 py-2.5 text-[0.875rem]">
                  <span className="font-semibold">{p.credits} Claude credits</span> <span className="text-mute">every month</span>
                </div>
                <Features list={FEATURES[p.id]} />
                {teamNeedsName && !isCurrent && (
                  <input
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    placeholder="Team name, e.g. Acme"
                    aria-label="Team name"
                    className="mt-4 h-10 rounded-full bg-ink/[0.05] px-4 text-[0.875rem] outline-none focus:bg-ink/[0.08]"
                  />
                )}
                {isCurrent ? (
                  <div className="mt-4 rounded-full bg-ink/[0.05] px-4 py-2.5 text-center text-[0.875rem] font-medium">Current plan</div>
                ) : (
                  <Button className="mt-4 w-full" disabled={disabled} onClick={() => go(() => startCheckout(p.id, teamName.trim() || undefined, props.template), p.id)}>
                    {busy === p.id ? "Opening checkout…" : teamNeedsName ? "Create team & subscribe" : `Get ${p.name}`}
                  </Button>
                )}
                {wrongWorkspace && <p className="mt-2 text-[0.75rem] text-mute">Individual is for your personal workspace. Switch to it to subscribe.</p>}
              </div>
            );
          })}
        </div>
      )}

      {!workspace.isOwner && !current && <p className="mt-4 text-[0.875rem] text-mute">Only the owner of this workspace can choose its plan.</p>}
      {error && <p className="mt-4 text-[0.875rem] text-red">{error}</p>}

      <p className="mt-8 text-[0.8125rem] leading-relaxed text-mute">
        Credits pay for Claude on our key while your loopers work. One credit is $1 of usage at Looper prices, which are {props.markup}× the model&apos;s list price: a run that costs
        Anthropic $0.40 uses {num(0.4 * props.markup)} credits. Credits reset at the start of each billing month and don&apos;t roll over. On any plan, your own ChatGPT or Grok plan
        or API key costs nothing extra. Each workspace includes up to ${props.infra.cap} of computer time a month. Prefer to run it yourself? Self-hosting is free:{" "}
        <a href="https://github.com/HireLooper-com/looper" className="underline hover:text-ink">
          the code is on GitHub
        </a>
        .
      </p>
    </div>
  );
}

function PlanHead({ name, price }: { name: string; price: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <div className="text-[1.125rem] font-semibold">{name}</div>
      <div>
        <span className="text-[1.75rem] font-semibold tracking-[-0.03em]">{price}</span>
        <span className="text-[0.875rem] text-mute"> / month</span>
      </div>
    </div>
  );
}

function Features({ list }: { list: string[] }) {
  return (
    <ul className="mt-4 flex flex-1 flex-col gap-1.5 text-[0.875rem]">
      {list.map((f) => (
        <li key={f} className="flex gap-2">
          <span className="text-mute">✓</span>
          {f}
        </li>
      ))}
    </ul>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

function statusNote(b: { status: string; periodEnd?: string; cancelAt?: string }) {
  if (b.cancelAt && b.status !== "canceled") return `Cancels ${day(b.cancelAt)}`;
  const end = b.periodEnd ? day(b.periodEnd) : "";
  if (b.status === "active" || b.status === "trialing") return end ? `Renews ${end}` : "Active";
  if (b.status === "past_due") return "Payment failed — update your card";
  return b.status === "canceled" ? "Canceled" : b.status;
}

function Stat({ label, value, note, bar }: { label: string; value: string; note?: string; bar?: number }) {
  return (
    <div className="tile p-4">
      <div className="text-[0.75rem] text-mute">{label}</div>
      <div className="mt-1 text-[1.375rem] font-semibold tracking-[-0.02em]">{value}</div>
      {bar !== undefined && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink/[0.08]">
          <div className="h-full rounded-full bg-ink" style={{ width: `${Math.min(100, bar * 100)}%` }} />
        </div>
      )}
      {note && <div className="mt-1 text-[0.75rem] text-mute">{note}</div>}
    </div>
  );
}
