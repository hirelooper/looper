import "server-only";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
import { emailAllowed, mutate, read, upsertUser } from "../db";
import { kv } from "../kv";
import type { OAuthCredential } from "../types";

// ChatGPT plan sign-in through the Codex CLI's device code login. Works on hosted servers too,
// where official Sign in with ChatGPT isn't offered. Like OpenClaw and OpenCode, this borrows the
// Codex CLI's public client and endpoint. Unofficial: it can change or stop working.
const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const REVOKE_URL = `${ISSUER}/oauth/revoke`;
const VERIFY_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT = `${ISSUER}/deviceauth/callback`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const DEVICE_TTL = 15 * 60_000;

interface Device {
  deviceAuthId: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  nextPollAt: number;
  /** signed-in user connecting ChatGPT as a second subscription */
  linkUid?: string;
  /** the workspace that gets the connection (when linking from Settings) */
  linkWs?: string;
}

// Pending device sign-ins are stored in the shared store: on Vercel each poll may reach a different instance.
const deviceKey = (flowId: string) => `codex-device:${flowId}`;

async function post(url: string, body: Record<string, string>, form = false) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", accept: "application/json" },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  const code = typeof data.error === "string" ? data.error : (data.error?.code ?? "");
  const message = data.error_description ?? data.error?.message ?? (code || `status ${r.status}`);
  return { ok: r.ok, status: r.status, data, code: String(code), message: String(message) };
}

/** Step 1: get a code the user confirms on auth.openai.com. Returns a flow id the browser polls with. */
export async function startDevice(linkUid?: string, linkWs?: string) {
  const { ok, status, data } = await post(USERCODE_URL, { client_id: CLIENT_ID });
  if (status === 404) throw new Error("OpenAI turned off device code sign-in for the Codex CLI. Use an OpenAI API key instead.");
  if (!ok) throw new Error(`ChatGPT sign-in unavailable (${status})`);
  const interval = Math.max(1, Number(data.interval ?? 5) || 5);
  const flowId = randomBytes(18).toString("base64url");
  const device: Device = {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code ?? data.usercode,
    interval,
    expiresAt: Math.min(Date.parse(data.expires_at) || Infinity, Date.now() + DEVICE_TTL),
    nextPollAt: Date.now() + interval * 1000,
    linkUid,
    linkWs,
  };
  await kv.set(deviceKey(flowId), device, Math.ceil((device.expiresAt - Date.now()) / 1000));
  // OpenAI's page has no way to pre-fill the code, so the browser copies it for the user to paste.
  return { flowId, userCode: device.userCode, verificationUri: VERIFY_URL, verificationUriComplete: VERIFY_URL, codeInLink: false, interval, expiresAt: device.expiresAt };
}

/** Who signed in, and the ChatGPT account the Codex endpoint bills. */
async function identityOf(idToken?: string) {
  if (!idToken) return {};
  try {
    const { payload } = await jwtVerify(idToken, JWKS, { issuer: ISSUER, audience: CLIENT_ID });
    const auth = (payload["https://api.openai.com/auth"] ?? {}) as { chatgpt_account_id?: string };
    return {
      subject: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : undefined,
      accountId: auth.chatgpt_account_id,
    };
  } catch {
    return {};
  }
}

function credentialFrom(data: Record<string, unknown>, prev?: OAuthCredential): Omit<OAuthCredential, "email" | "subject" | "accountId"> {
  return {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token ?? prev?.refreshToken ?? ""),
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    scopes: typeof data.scope === "string" ? data.scope.split(" ") : (prev?.scopes ?? []),
    via: "codex",
  };
}

type PollResult = { status: "pending" | "denied" | "expired" | "not-allowed" } | { status: "connected"; uid: string; linked: boolean };

/** Step 2: the browser calls this every `interval` seconds; one poll per call. */
export async function pollDevice(flowId: string): Promise<PollResult> {
  const d = await kv.get<Device>(deviceKey(flowId));
  if (!d || Date.now() > d.expiresAt) return { status: "expired" };
  if (Date.now() < d.nextPollAt) return { status: "pending" };
  const drop = () => kv.delete(deviceKey(flowId));

  const poll = await post(DEVICE_TOKEN_URL, { device_auth_id: d.deviceAuthId, user_code: d.userCode });
  // 403 and 404 mean the user hasn't approved yet.
  if (poll.status === 403 || poll.status === 404) {
    d.nextPollAt = Date.now() + d.interval * 1000;
    await kv.set(deviceKey(flowId), d, Math.max(1, Math.ceil((d.expiresAt - Date.now()) / 1000)));
    return { status: "pending" };
  }
  await drop();
  if (!poll.ok) {
    if (/denied|declined/i.test(poll.code)) return { status: "denied" };
    throw new Error(`ChatGPT sign-in failed: ${poll.message}`);
  }

  const t = await post(
    TOKEN_URL,
    {
      grant_type: "authorization_code",
      code: poll.data.authorization_code,
      redirect_uri: DEVICE_REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: poll.data.code_verifier,
    },
    true,
  );
  if (!t.ok) throw new Error(`ChatGPT sign-in failed: ${t.message}`);
  if (!t.data.refresh_token) throw new Error("ChatGPT didn't return a refresh token. Try signing in again.");
  const identity = await identityOf(t.data.id_token);
  if (!identity.subject) throw new Error("ChatGPT didn't confirm who signed in. Try again.");
  if (!identity.accountId) throw new Error("This sign-in has no ChatGPT plan attached. Plus, Pro, Business or Enterprise is required.");
  if (!d.linkUid && !emailAllowed(identity.email)) return { status: "not-allowed" };

  const user = await upsertUser({ provider: "openai", identity: `openai:${identity.subject}`, email: identity.email }, d.linkUid);
  await mutate(d.linkWs ?? user.id, (db) => {
    db.settings.oauth.openai = { ...credentialFrom(t.data), ...identity };
    db.settings.authMode.openai = "oauth";
    db.settings.provider = "openai";
  });
  return { status: "connected", uid: user.id, linked: !!d.linkUid };
}

const RELOGIN = new Set(["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]);

/** A valid access token and the account it bills. Refreshes under the workspace lock (refresh tokens rotate). */
export async function codexAuth(uid: string, force = false): Promise<{ token: string; accountId: string }> {
  const cred = (await read(uid)).settings.oauth.openai;
  if (cred?.via !== "codex" || !cred.accountId) throw new Error("ChatGPT isn't connected through the Codex CLI. Connect it in Settings.");
  const accountId = cred.accountId;
  if (!force && cred.expiresAt - Date.now() > 5 * 60_000) return { token: cred.accessToken, accountId };

  const outcome = await mutate(uid, async (db) => {
    const current = db.settings.oauth.openai;
    if (current?.via !== "codex") return { error: "ChatGPT isn't connected. Connect it in Settings." };
    if (current.accessToken !== cred.accessToken) return { token: current.accessToken };
    const r = await post(TOKEN_URL, { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: current.refreshToken });
    if (!r.ok) {
      if (r.status === 401 || RELOGIN.has(r.code)) {
        delete db.settings.oauth.openai;
        db.settings.authMode.openai = "key";
        return { error: "Your ChatGPT session ended. Connect ChatGPT again in Settings." };
      }
      return { error: `Couldn't refresh the ChatGPT session (${r.status})` };
    }
    const identity = await identityOf(r.data.id_token);
    db.settings.oauth.openai = { ...current, ...credentialFrom(r.data, current), accountId: identity.accountId ?? current.accountId };
    return { token: db.settings.oauth.openai.accessToken };
  });
  if ("error" in outcome) throw new Error(outcome.error);
  return { token: outcome.token, accountId };
}

export async function signOut(uid: string) {
  const cred = (await read(uid)).settings.oauth.openai;
  if (cred?.via === "codex") await post(REVOKE_URL, { token: cred.refreshToken, token_type_hint: "refresh_token", client_id: CLIENT_ID }, true).catch(() => undefined);
  await mutate(uid, (db) => {
    delete db.settings.oauth.openai;
    db.settings.authMode.openai = "key";
  });
}

/** Headers the Codex endpoint expects (identifies as the Codex CLI). */
export function codexHeaders(accountId: string): Record<string, string> {
  return { "chatgpt-account-id": accountId, originator: "codex_cli_rs", "OpenAI-Beta": "responses=experimental" };
}

/**
 * The Codex endpoint takes a narrower Responses body than api.openai.com: it needs `instructions`,
 * store:false and streaming, and rejects sampling and token-limit fields.
 */
export function codexBody(raw: string): string {
  const json = JSON.parse(raw);
  json.store = false;
  json.stream = true;
  for (const f of ["max_output_tokens", "temperature", "top_p", "metadata", "user", "service_tier", "prompt_cache_retention", "safety_identifier"]) delete json[f];
  if (!json.instructions && Array.isArray(json.input)) {
    const parts: string[] = [];
    while (json.input.length && (json.input[0].role === "system" || json.input[0].role === "developer")) {
      const c = json.input.shift().content;
      parts.push(typeof c === "string" ? c : (c as { text?: string }[]).map((p) => p.text ?? "").join("\n"));
    }
    json.instructions = parts.join("\n\n") || "You are a helpful assistant.";
  }
  if (json.reasoning) json.include = [...new Set([...(json.include ?? []), "reasoning.encrypted_content"])];
  return JSON.stringify(json);
}

/**
 * Models the Codex endpoint serves to this ChatGPT plan, best first. The API catalog runs ahead of
 * it (e.g. a new GPT that Codex doesn't offer yet), and asking for one fails with model_not_found.
 * Cached per account for an hour; empty when the endpoint doesn't answer.
 */
export async function listCodexModels(uid: string): Promise<{ id: string; name: string }[]> {
  const { token, accountId } = await codexAuth(uid);
  const key = `codex-models:${accountId}`;
  const cached = await kv.get<{ id: string; name: string }[]>(key);
  if (cached) return cached;
  const r = await fetch(`${CODEX_BASE}/models?client_version=${CODEX_CLIENT_VERSION}`, {
    headers: { authorization: `Bearer ${token}`, ...codexHeaders(accountId) },
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`Couldn't list Codex models (${r.status})`);
  const data = (await r.json()) as { models?: { slug: string; display_name?: string; visibility?: string; priority?: number }[] };
  const models = (data.models ?? [])
    .filter((m) => m.slug && (m.visibility ?? "list") === "list")
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m) => ({ id: m.slug, name: m.display_name ?? m.slug }));
  if (models.length) await kv.set(key, models, 3600);
  return models;
}

const CODEX_CLIENT_VERSION = "0.60.0";
