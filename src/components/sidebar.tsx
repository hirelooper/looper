"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOutApp } from "@/app/actions";
import { switchWorkspace } from "@/app/workspace-actions";
import { AREAS, type Accent, type Area } from "@/lib/types";
import { WorkingTray } from "./activity";
import { openPalette } from "./command-palette";
import { Bot, cx } from "./ui";

export interface SidebarLooper {
  id: string;
  name: string;
  color: Accent;
  /** "missing invoices", shown next to the name */
  metricName: string;
  /** Sidebar group: Distribution or Operations */
  area: Area;
  paused: boolean;
  /** "26 now · target 0" */
  metric: string;
  /** "▼3" over the last week, or "" */
  trend: string;
  running: boolean;
  needsYou: number;
}

const Count = ({ n }: { n: number }) =>
  n > 0 ? <span className="ml-auto shrink-0 rounded-full bg-ink/[0.08] px-1.5 text-[0.6875rem] font-medium tabular-nums leading-[18px] text-ink">{n}</span> : null;

function InboxIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
      <path d="M3 11.5 5 4h10l2 7.5V16H3z" />
      <path d="M3 11.5h4l1 2h4l1-2h4" />
    </svg>
  );
}

/** Left rail: the inbox, Chief, then every looper with its number. */
type WorkspaceRef = { id: string; name: string; kind: "personal" | "team" };

export function Sidebar({
  loopers,
  account,
  workspace,
  workspaces,
  billing,
  credits,
  chiefPreview,
  inboxCount,
  admin,
}: {
  loopers: SidebarLooper[];
  account: { email?: string; name?: string; avatar?: string };
  workspace: WorkspaceRef & { plan?: string };
  workspaces: WorkspaceRef[];
  billing: boolean;
  /** Included Claude credits in USD, when the workspace was granted any; invite when no plan or key is connected */
  credits?: { left: number; granted: number; invite: boolean };
  chiefPreview?: string;
  inboxCount: number;
  /** operators (ADMIN_EMAILS) get a link to /admin */
  admin?: boolean;
}) {
  const path = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const row = (active: boolean) => cx("flex items-center gap-3 rounded-[14px] px-2.5 py-2 transition-colors", active ? "bg-ink/[0.06]" : "hover:bg-ink/[0.03]");

  return (
    <>
      {/* Phones: a strip across the top */}
      <div className="flex items-center gap-3 overflow-x-auto border-b border-ink/[0.06] bg-rail px-3 py-2 lg:hidden">
        <Link href="/inbox" aria-label="Needs you" className="relative flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-ink/[0.06]">
          <InboxIcon />
          {inboxCount > 0 && <span className="absolute -right-1 -top-1 h-4 min-w-4 rounded-full bg-ink px-1 text-center text-[0.625rem] font-semibold leading-4 text-page">{inboxCount}</span>}
        </Link>
        <Link href="/chief" aria-label="Chief">
          <Bot dark seed="chief" size={38} />
        </Link>
        {loopers.map((l) => (
          <Link key={l.id} href={`/loopers/${l.id}`} aria-label={l.name} className={cx("relative", l.paused && "opacity-50")}>
            <Bot color={l.color} seed={l.id} size={38} className={cx(l.running && "looping")} />
          </Link>
        ))}
        <button onClick={openPalette} className="ml-auto shrink-0 rounded-full bg-ink/[0.05] px-3 py-1.5 text-[0.8125rem]">
          Search
        </button>
      </div>

      <aside className="hidden h-dvh w-[300px] shrink-0 flex-col border-r border-ink/[0.06] bg-rail lg:flex">
        <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
          <button onClick={openPalette} className="flex h-9 flex-1 items-center gap-2 rounded-full bg-ink/[0.05] pl-3 pr-2 text-[0.875rem] text-mute transition-colors hover:bg-ink/[0.08]">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.5 10.5 3 3" />
            </svg>
            Search or jump to…
            <kbd className="ml-auto rounded-[6px] bg-ink/[0.06] px-1.5 font-sans text-[0.6875rem] text-mute">⌘K</kbd>
          </button>
          <Link href="/hire" aria-label="Hire a looper" title="Hire a looper" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-ink-2 transition-colors hover:bg-ink/[0.08]">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M7 2v10M2 7h10" />
            </svg>
          </Link>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <Link href="/inbox" className={row(path.startsWith("/inbox"))}>
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-ink">
              <InboxIcon size={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="text-[0.9375rem] font-medium">Needs you</span>
                <Count n={inboxCount} />
              </span>
              <span className="block truncate text-[0.8125rem] text-mute">{inboxCount ? `${inboxCount} waiting on you` : "All clear"}</span>
            </span>
          </Link>

          {/* Chief sits in the list like a looper; its page is the brief and the hiring chat. */}
          <Link href="/chief" className={row(path.startsWith("/chief"))}>
            <Bot dark seed="chief" size={44} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[0.9375rem] font-medium">Chief</span>
                <span className="shrink-0 rounded-[5px] bg-ink/[0.05] px-1.5 text-[0.6875rem] text-mute">Daily brief</span>
              </span>
              <span className="block truncate text-[0.8125rem] text-mute">{chiefPreview || "Tell me what to move"}</span>
            </span>
          </Link>

          <WorkingTray loopers={loopers} />

          {AREAS.map(({ id, label }) => {
            const group = loopers.filter((l) => l.area === id);
            return group.length > 0 && [
              <div key={id} className="eyebrow px-3 pb-1 pt-4">{label}</div>,
              ...group.map((l) => (
                <Link key={l.id} href={`/loopers/${l.id}`} className={row(path.startsWith(`/loopers/${l.id}`))} title={l.running ? `${l.name} is working` : undefined}>
                  <Bot color={l.color} seed={l.id} size={44} className={cx(l.running && "looping", l.paused && "opacity-40 grayscale")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="shrink-0 text-[0.9375rem] font-medium">{l.name}</span>
                      <span className="min-w-0 truncate rounded-[5px] bg-ink/[0.05] px-1.5 text-[0.6875rem] text-mute" title={l.metricName}>{l.metricName}</span>
                      <Count n={l.needsYou} />
                    </span>
                    <span className="flex items-center gap-2 text-[0.8125rem] text-mute">
                      <span className="min-w-0 flex-1 truncate">{l.paused ? "Paused" : l.running ? "Working…" : l.metric}</span>
                      {!l.paused && !l.running && l.trend && <span className="shrink-0 tabular-nums text-[0.75rem]">{l.trend}</span>}
                    </span>
                  </span>
                </Link>
              )),
            ];
          })}
          {loopers.length === 0 && (
            <Link href="/welcome" className="mx-1 mt-2 block rounded-full bg-ink px-3 py-2.5 text-center text-[0.875rem] font-medium text-page hover:bg-ink-2">
              Hire your first looper
            </Link>
          )}
        </nav>

        <div className="relative border-t border-ink/[0.06] p-2" ref={menuRef}>
          {credits && <CreditsMeter {...credits} billing={billing} />}
          <button onClick={() => setMenu((m) => !m)} aria-label="Account and workspaces" aria-expanded={menu} className="flex w-full items-center gap-3 rounded-[14px] px-2 py-2 text-left hover:bg-ink/[0.03]">
            <Avatar account={account} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.875rem] font-medium">{workspace.kind === "team" ? workspace.name : account.name || account.email || "Signed in"}</span>
              <span className="block truncate text-[0.75rem] text-mute">{workspace.kind === "team" ? `Team${workspace.plan ? ` · ${workspace.plan}` : ""}` : workspace.plan ?? account.email}</span>
            </span>
            <span className="text-mute">⋯</span>
          </button>
          {menu && (
            <div className="absolute bottom-[60px] left-2 right-2 z-50 max-h-[70dvh] overflow-y-auto rounded-[14px] border border-ink/[0.06] bg-panel p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.14)]">
              <div className="px-3 pb-1 pt-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.06em] text-faint">Workspaces</div>
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  onClick={async () => {
                    setMenu(false);
                    if (w.id === workspace.id) return;
                    await switchWorkspace(w.id);
                    router.push("/");
                    router.refresh();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-[8px] px-3 py-2 text-left text-[0.875rem] hover:bg-ink/[0.04]"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-ink/[0.07] text-[0.6875rem] font-semibold uppercase">{w.kind === "team" ? w.name.slice(0, 1) : "P"}</span>
                  <span className="min-w-0 flex-1 truncate">{w.kind === "team" ? w.name : "Personal"}</span>
                  {w.id === workspace.id && <span className="text-mute">✓</span>}
                </button>
              ))}
              <Link href="/workspace?new=1" onClick={() => setMenu(false)} className="block rounded-[8px] px-3 py-2 text-[0.875rem] text-mute hover:bg-ink/[0.04] hover:text-ink">
                + New team workspace
              </Link>
              <div className="my-1 h-px bg-line" />
              {[
                [workspace.kind === "team" ? "Members & invites" : "Workspace", "/workspace"],
                ...(billing ? [["Plan & credits", "/billing"]] : []),
                ["Settings", "/settings"],
                ...(admin ? [["Admin", "/admin"]] : []),
              ].map(([label, href]) => (
                <Link key={label} href={href} onClick={() => setMenu(false)} className="block rounded-[8px] px-3 py-2 text-[0.875rem] hover:bg-ink/[0.04]">
                  {label}
                </Link>
              ))}
              <div className="my-1 h-px bg-line" />
              <button
                onClick={async () => {
                  await signOutApp();
                  router.push("/login");
                  router.refresh();
                }}
                className="w-full rounded-[8px] px-3 py-2 text-left text-[0.875rem] hover:bg-ink/[0.04]"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function Avatar({ account }: { account: { email?: string; name?: string; avatar?: string } }) {
  if (account.avatar)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={account.avatar} alt="" referrerPolicy="no-referrer" className="h-9 w-9 shrink-0 rounded-full object-cover" />;
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#a1a1a6] to-[#6e6e73] text-[0.875rem] font-semibold uppercase text-white">
      {(account.name || account.email || "?").slice(0, 1)}
    </span>
  );
}

/** Included Claude credits left, with a bar, and the way to keep going: your own ChatGPT or Grok plan. */
function CreditsMeter({ left, granted, invite, billing }: { left: number; granted: number; invite: boolean; billing: boolean }) {
  const out = left < 0.01;
  return (
    <Link href={out || invite || !billing ? "/settings" : "/billing"} className="mb-1 block rounded-[14px] px-2.5 py-2 hover:bg-ink/[0.03]" title={`$${left.toFixed(2)} of $${Math.round(granted)} in Claude credits left`}>
      <span className="flex items-baseline justify-between gap-2 text-[0.75rem]">
        <span className="text-mute">Claude credits</span>
        <span className={cx("tabular-nums", out ? "text-red" : "text-ink")}>{out ? "Used up" : `$${left.toFixed(2)} left`}</span>
      </span>
      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-ink/[0.08]">
        <span className={cx("block h-full rounded-full", out ? "bg-red" : "bg-ink/60")} style={{ width: `${Math.min(100, (left / granted) * 100)}%` }} />
      </span>
      {invite && (
        <span className="mt-1.5 block text-[0.75rem] text-mute">
          {out ? "Connect your ChatGPT or Grok plan to keep going" : "On us for now. Connect your ChatGPT or Grok plan to keep loopers running after"}
        </span>
      )}
    </Link>
  );
}
