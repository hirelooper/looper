import { after, connection } from "next/server";
import { getState } from "../actions";
import { WelcomeFlow } from "@/components/welcome-flow";
import { businessDomain } from "@/lib/email-domains";
import { onboardingView, startOnboarding } from "@/lib/onboarding";
import { requireUser } from "@/lib/session";
import { modelReady, ownModelReady } from "@/lib/types";
import { getWorkspace } from "@/lib/workspace";

// Reading the website, hiring and filling the first rows all run after this page responds.
export const maxDuration = 300;

/** Onboarding for a new workspace: Chief reads the business, hires a looper for one metric and fills its table. */
export default async function WelcomePage() {
  await connection();
  const user = await requireUser();
  const [state, ws] = await Promise.all([getState(), getWorkspace(user.ws)]);
  const team = ws?.kind === "team";
  let view = await onboardingView(user.ws);
  // A work email already names the website: start reading it, no typing needed.
  const domain = businessDomain(user.email ?? "");
  if (!view && domain && !state.onboarded && state.loopers.length === 0 && modelReady(state.settings)) {
    const { done } = await startOnboarding(user.ws, { url: domain, renameTeam: team && ws?.ownerId === user.id });
    after(() => done);
    view = await onboardingView(user.ws);
  }
  return (
    <WelcomeFlow
      initial={view}
      site={state.profile?.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") || domain || ""}
      ready={modelReady(state.settings)}
      freeCredits={!ownModelReady(state.settings) && (state.settings.creditsLeft ?? 0) > 0 ? state.settings.creditsLeft : undefined}
      team={team}
    />
  );
}
