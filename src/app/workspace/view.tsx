"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { inviteLink, makePersonalTeam, newTeamWorkspace, removeFromWorkspace, renameCurrentWorkspace } from "@/app/workspace-actions";
import { Button } from "@/components/ui";

type Member = { userId: string; name: string; email?: string; avatar?: string; role: "owner" | "member" };

export function WorkspaceView(props: { me: string; workspace: { id: string; name: string; kind: "personal" | "team"; isOwner: boolean }; members: Member[]; creating: boolean; billing: boolean }) {
  const { workspace } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(workspace.kind === "team" ? workspace.name : "");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [shareName, setShareName] = useState("");

  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

  const create = (
    <section className="tile p-6">
      <div className="text-[1.125rem] font-semibold">New team workspace</div>
      <p className="mt-1 text-[0.875rem] text-mute">A shared space: everyone you invite sees and works with the same loopers, boards, chats and approvals.{props.billing ? " Teams are on the Team plan ($199/month, $199 of AI credits included once)." : ""}</p>
      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await newTeamWorkspace(teamName || "Team");
            window.location.assign(props.billing ? "/billing?plan=team" : "/welcome");
          });
        }}
      >
        <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team name, e.g. Acme" aria-label="Team name" className="h-10 min-w-0 flex-1 rounded-full bg-ink/[0.05] px-4 text-[0.875rem] outline-none focus:bg-ink/[0.08]" />
        <Button disabled={pending}>Create team</Button>
      </form>
    </section>
  );

  // Opened from "+ New team workspace": show only the create form, so the current
  // workspace's settings below it don't read as part of the new team.
  if (props.creating)
    return (
      <div className="mx-auto flex max-w-[720px] flex-col gap-4 px-4 py-8 sm:px-6">
        {create}
        {error && <p className="text-[0.875rem] text-red">{error}</p>}
      </div>
    );

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">{workspace.kind === "team" ? workspace.name : "Personal workspace"}</h1>
        <p className="mt-1 text-[0.9375rem] text-mute">{workspace.kind === "team" ? `${props.members.length} member${props.members.length === 1 ? "" : "s"}` : "Only you. Add people to it, or start a separate team workspace."}</p>
      </div>

      {workspace.kind === "personal" && workspace.isOwner && (
        <section className="tile p-6">
          <div className="text-[1.125rem] font-semibold">Add people to this workspace</div>
          <p className="mt-1 text-[0.875rem] text-mute">
            Turns it into a team workspace. Your loopers, boards, chats and apps stay as they are, and everyone you invite works with them too.{props.billing ? " Teams are on the Team plan." : ""}
          </p>
          <form
            className="mt-4 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const teamName = shareName.trim() || "Team";
                const r = await makePersonalTeam(teamName);
                setName(teamName);
                setLink(r.url);
                setCopied(false);
                router.refresh();
              });
            }}
          >
            <input value={shareName} onChange={(e) => setShareName(e.target.value)} placeholder="Team name, e.g. Acme" aria-label="Team name" className="h-10 min-w-0 flex-1 rounded-full bg-ink/[0.05] px-4 text-[0.875rem] outline-none focus:bg-ink/[0.08]" />
            <Button disabled={pending}>Make it a team</Button>
          </form>
        </section>
      )}

      {workspace.kind === "personal" && create}

      {workspace.kind === "team" && (
        <>
          {workspace.isOwner && (
            <section className="tile p-6">
              <div className="text-[1.125rem] font-semibold">Name</div>
              <form
                className="mt-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    await renameCurrentWorkspace(name);
                    router.refresh();
                  });
                }}
              >
                <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Workspace name" className="h-10 min-w-0 flex-1 rounded-full bg-ink/[0.05] px-4 text-[0.875rem] outline-none focus:bg-ink/[0.08]" />
                <Button variant="soft" disabled={pending || !name.trim() || name === workspace.name}>
                  Save
                </Button>
              </form>
            </section>
          )}

          <section className="tile p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[1.125rem] font-semibold">Invite people</div>
                <p className="mt-1 text-[0.875rem] text-mute">Anyone with the link can join for the next 14 days.</p>
              </div>
              <Button
                variant="soft"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const r = await inviteLink();
                    setLink(r.url);
                    setCopied(false);
                  })
                }
              >
                {link ? "New link" : "Create invite link"}
              </Button>
            </div>
            {link && (
              <div className="mt-4 flex items-center gap-2 rounded-[12px] bg-ink/[0.05] p-1.5 pl-4">
                <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{link}</span>
                <Button
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            )}
          </section>

          <section className="tile divide-y divide-line">
            {props.members.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 px-6 py-3.5">
                {m.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.avatar} alt="" referrerPolicy="no-referrer" className="h-9 w-9 rounded-full object-cover" />
                ) : (
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink/[0.08] text-[0.875rem] font-semibold uppercase">{m.name.slice(0, 1)}</span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.9375rem] font-medium">
                    {m.name}
                    {m.userId === props.me && <span className="font-normal text-mute"> (you)</span>}
                  </div>
                  <div className="truncate text-[0.8125rem] text-mute">{m.email}</div>
                </div>
                <span className="text-[0.75rem] text-mute">{m.role === "owner" ? "Owner" : "Member"}</span>
                {m.role !== "owner" && (workspace.isOwner || m.userId === props.me) && (
                  <button
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        await removeFromWorkspace(m.userId);
                        if (m.userId === props.me) router.push("/");
                        router.refresh();
                      })
                    }
                    className="text-[0.8125rem] text-mute hover:text-red"
                  >
                    {m.userId === props.me ? "Leave" : "Remove"}
                  </button>
                )}
              </div>
            ))}
          </section>
        </>
      )}

      {error && <p className="text-[0.875rem] text-red">{error}</p>}
    </div>
  );
}
