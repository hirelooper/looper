import { connection } from "next/server";
import { getState } from "../actions";
import { WelcomeFlow } from "@/components/welcome-flow";
import { requireUser } from "@/lib/session";
import { ACCENTS, modelReady, ownModelReady } from "@/lib/types";
import { getWorkspace } from "@/lib/workspace";

// Reading the website and drafting a looper both ask the model, and the first run starts here.
export const maxDuration = 300;

/** Onboarding for a new workspace: your business, one metric, then connect and start. */
export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  await connection();
  const user = await requireUser();
  const [state, ws, { looper: looperId, connected, connect_error }] = await Promise.all([getState(), getWorkspace(user.ws), searchParams]);
  // Back from an app's connect page: resume at the last step for that looper.
  const l = typeof looperId === "string" ? state.loopers.find((x) => x.id === looperId) : undefined;
  const work = l?.skills.find((s) => s.kind === "work");
  const notice = typeof connected === "string" ? `Connected ${connected}.` : typeof connect_error === "string" ? `Couldn't connect ${connect_error}. Try again.` : undefined;
  const team = ws?.kind === "team";
  return (
    <WelcomeFlow
      profile={state.profile}
      workspace={{ name: team ? ws.name : "", team, canRename: team && ws.ownerId === user.id }}
      ready={modelReady(state.settings)}
      freeCredits={!ownModelReady(state.settings) && (state.settings.creditsLeft ?? 0) > 0 ? state.settings.creditsLeft : undefined}
      resume={l ? { id: l.id, name: l.name, color: l.color, firstSkillId: work?.id, firstSkillName: work?.name } : undefined}
      notice={notice}
      taken={state.loopers.map((x) => x.name)}
      nextColor={ACCENTS[state.loopers.length % ACCENTS.length]}
    />
  );
}
