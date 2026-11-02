import { onboardingView } from "@/lib/onboarding";
import { currentUser } from "@/lib/session";

/** Live onboarding for /welcome: state, Chief's read of the business and the looper's first rows. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json(null, { status: 401 });
  return Response.json(await onboardingView(user.ws), { headers: { "cache-control": "no-store" } });
}
