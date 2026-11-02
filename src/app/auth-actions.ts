"use server";

import { after } from "next/server";
import { emailAllowed } from "@/lib/db";
import { businessDomain } from "@/lib/email-domains";
import { prefetchSite } from "@/lib/onboarding";
import { checkCode, emailCode } from "@/lib/email-code";
import { setSession, setWorkspace } from "@/lib/session";
import { upsertUser } from "@/lib/workspace";

const clean = (email: string) => email.trim().toLowerCase();

/** Email a 6-digit sign-in code. Returns an error to show, or null. */
export async function sendEmailCode(email: string): Promise<{ error: string } | null> {
  const e = clean(email);
  if (!emailAllowed(e)) return { error: "This email isn't on the allowed list for this workspace." };
  const error = await emailCode(e);
  if (error) return { error };
  // Read the company's website while they type the code, so onboarding opens on it.
  const domain = businessDomain(e);
  if (domain) after(() => prefetchSite(domain));
  return null;
}

/** Sign in with the code from the email. Returns an error to show, or null. */
export async function signInWithEmailCode(email: string, code: string): Promise<{ error: string } | null> {
  const e = clean(email);
  if (!emailAllowed(e)) return { error: "This email isn't on the allowed list for this workspace." };
  if (!(await checkCode(e, code))) return { error: "That code didn't work. Try again or send a new one." };
  const user = await upsertUser({ identity: `email:${e}`, email: e, provider: "email" });
  await setSession(user.id);
  await setWorkspace(user.id);
  return null;
}
