import { connection } from "next/server";
import { NudgeButton } from "@/components/admin-nudge";
import { FunnelBar, Section, Stat, Table, WorkspaceCell, ago, date, hours, money, pct, planLabel } from "@/components/admin-view";
import { Usage } from "@/components/settings-view";
import { cohorts, overview, REASONS, requireAdmin, stepTimes, steps } from "@/lib/admin";
import { hasNotes } from "@/lib/loops";
import { getCatalog, nameOf } from "@/lib/models";
import { Pill } from "@/components/ui";

export const metadata = { title: "Admin · Looper", robots: { index: false } };

/** For the people who run Looper: who is stuck, who is active, and what it all costs. */
export default async function AdminPage() {
  await connection();
  const me = await requireAdmin();
  const [{ rows, usage, pulse, signup }, catalog] = await Promise.all([overview(me), getCatalog()]);
  const live = rows.filter((r) => !r.excluded);
  const canSend = hasNotes();

  // Not yet nudged first, then by how much the reason matters, then the longest stuck.
  const order = Object.keys(REASONS);
  const stuck = live
    .flatMap((r) => (r.nudges.length ? [{ r, top: r.nudges.find((n) => !n.sentAt) ?? r.nudges[0] }] : []))
    .sort((a, b) => Number(!!a.top.sentAt) - Number(!!b.top.sentAt) || order.indexOf(a.top.reason) - order.indexOf(b.top.reason) || (a.top.since ?? "").localeCompare(b.top.since ?? ""))
    .slice(0, 40);
  const active = [...live].filter((r) => r.runs7 + r.messages7 > 0).sort((a, b) => b.runsOk7 + b.messages7 - (a.runsOk7 + a.messages7)).slice(0, 12);
  const costly = [...live].filter((r) => r.spendUs + r.infra > 0).sort((a, b) => b.spendUs + b.infra - (a.spendUs + a.infra)).slice(0, 12);
  const margin = pulse.mrr - pulse.spendUs - pulse.infra;
  const funnel = steps();
  const reached = funnel.map((s) => live.filter((r) => r.reached[s.id]).length);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-10 sm:px-6">
      <h1 className="display text-[2.5rem] sm:text-[3rem]">Admin</h1>
      <p className="mt-2 max-w-[64ch] text-[1rem] text-mute">
        Every workspace on this install. <span className="text-faint">Metadata and run summaries only: no chats, settings or keys. Visible to ADMIN_EMAILS.</span>
      </p>

      <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Signups, 7 days" value={String(pulse.signups7)} sub={`${pulse.signups30} in 30 days · ${pulse.users} people`} />
        <Stat label="Paying workspaces" value={String(pulse.paying)} sub={`${money(pulse.mrr)} a month`} />
        <Stat label="Our model spend" value={money(pulse.spendUs)} sub={`this month · ${money(pulse.infra)} computers`} />
        <Stat label="Margin this month" value={money(margin)} sub="revenue minus our models and computers" />
        <Stat label="Runs, 24 hours" value={String(pulse.runs24)} sub={`${pct(pulse.failed24, pulse.runs24)} failed`} />
      </div>

      <Section title="Needs a nudge" hint={`${stuck.length} workspaces`}>
        {stuck.length ? (
          <div className="tile divide-y divide-line">
            {stuck.map(({ r, top }) => {
              const more = r.nudges.filter((n) => n !== top);
              return (
                <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[0.875rem]">
                  <div className="w-full min-w-0 sm:w-56">
                    <WorkspaceCell row={r} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{top.label}</div>
                    <div className="text-[0.75rem] text-mute">
                      {top.since && `since ${date(top.since)} · `}
                      {planLabel(r)}
                      {more.length > 0 && ` · also: ${more.map((n) => n.label.toLowerCase()).join(", ")}`}
                    </div>
                  </div>
                  <NudgeButton wsId={r.id} nudge={top} to={r.owner.email} canSend={canSend} />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="tile px-4 py-4 text-[0.875rem] text-mute">Nobody is stuck right now.</p>
        )}
      </Section>

      <Section title="Onboarding" hint={`${live.length} workspaces since launch`}>
        <div className="tile px-4 py-3">
          {funnel.map((s, i) => (
            <FunnelBar key={s.id} label={s.label} count={reached[i]} total={reached[0]} prev={i ? reached[i - 1] : undefined} />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {stepTimes(live).map((t) => (
            <Stat key={t.label} label={t.label} value={hours(t.hours)} sub="median" />
          ))}
        </div>
        <div className="mt-3">
          <Table
            head={[{ label: "Signup week" }, ...funnel.map((s) => ({ label: s.label, right: true }))]}
            rows={cohorts(live).map((c) => [
              `${date(c.week)} · ${c.size}`,
              ...funnel.map((s) => (
                <span key={s.id}>
                  {c.reached[s.id]} <span className="text-faint">{pct(c.reached[s.id], c.size)}</span>
                </span>
              )),
            ])}
            empty="No signups yet."
          />
        </div>
      </Section>

      <Section title="Most active" hint="last 7 days">
        <Table
          head={[{ label: "Workspace" }, { label: "Plan" }, { label: "Runs", right: true }, { label: "Messages", right: true }, { label: "Loopers", right: true }, { label: "Last seen", right: true }, { label: "Our spend", right: true }]}
          rows={active.map((r) => [
            <WorkspaceCell key="w" row={r} />,
            planLabel(r),
            <span key="r">
              {r.runsOk7}
              {r.runsFailed7 > 0 && <span className="text-red"> +{r.runsFailed7} failed</span>}
            </span>,
            r.messages7,
            r.loopers.length,
            ago(r.lastSeen),
            money(r.spendUs),
          ])}
          empty="No runs or messages this week."
        />
      </Section>

      <Section title="Costs" hint="this month">
        <Table
          head={[{ label: "Workspace" }, { label: "Plan" }, { label: "Revenue", right: true }, { label: "Models", right: true }, { label: "Computers", right: true }, { label: "Credits left", right: true }, { label: "Margin", right: true }]}
          rows={costly.map((r) => [
            <WorkspaceCell key="w" row={r} />,
            planLabel(r),
            money(r.mrr),
            money(r.spendUs),
            money(r.infra),
            r.credits ? money(Math.max(0, r.credits.granted - r.credits.used)) : "–",
            <span key="m" className={r.mrr - r.spendUs - r.infra < 0 ? "text-red" : undefined}>
              {money(r.mrr - r.spendUs - r.infra)}
            </span>,
          ])}
          empty="Nothing spent on our side this month."
        />
        <p className="mt-3 text-[0.8125rem] text-mute">
          Signup credits: {money(signup.usd)} of {money(signup.budget)} given, {money(signup.each)} each to {signup.count} {signup.count === 1 ? "account" : "accounts"}.
        </p>
        <h3 className="mb-3 mt-8 text-[1rem] font-semibold">
          By model <span className="font-normal text-faint">every workspace, by who pays</span>
        </h3>
        <Usage
          sources={false}
          usage={{
            ...usage,
            byModel: usage.byModel.map((m) => ({ ...m, name: nameOf(catalog, m.provider, m.model) })),
            bySource: usage.bySource.map((x) => ({ ...x, name: x.source })),
          }}
        />
      </Section>

      <Section title="All workspaces" hint={`${rows.length}`}>
        <details className="group">
          <summary className="cursor-pointer text-[0.875rem] text-mute hover:text-ink">Show every workspace, newest first</summary>
          <div className="mt-3">
            <Table
              head={[{ label: "Workspace" }, { label: "Stage" }, { label: "Plan" }, { label: "Signed up", right: true }, { label: "Last seen", right: true }]}
              rows={[...rows]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((r) => [
                  <WorkspaceCell key="w" row={r} />,
                  r.excluded ? <Pill key="s">{r.excluded === "operator" ? "Operator" : "Works in a team"}</Pill> : (funnel.findLast((s) => r.reached[s.id])?.label ?? "Signed up"),
                  planLabel(r),
                  date(r.createdAt),
                  ago(r.lastSeen),
                ])}
              empty="No workspaces yet."
            />
          </div>
        </details>
      </Section>
    </div>
  );
}
