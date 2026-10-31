import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel, ToolSet } from "ai";
import { chatgptAccessToken, listChatGPTModels, RESOURCE, USAGE_URL } from "./oauth/chatgpt";
import { codexAuth, CODEX_BASE, codexBody, codexHeaders } from "./oauth/codex";
import { API_BASE, CLI_PROXY_BASE, cliProxyHeaders, grokAccessToken, GROK_USAGE_URL, isGrokEntitlementError } from "./oauth/grok";
import { creditsLeft, spendCredits } from "./billing";
import { isLocalServer } from "./db";
import { getCatalog, priceOf, recommendedModel, usdOf, type Catalog, type TokenUsage } from "./models";
import { getWorkspace, grantSignupCredits } from "./workspace";
import type { ModelChoice, ModelMenu, ModelOption, ModelPrice, Payer, Provider, Settings } from "./types";
import { PROVIDERS } from "./types";

type ProviderOptions = Record<string, Record<string, string | number | boolean | null>>;

export interface ResolvedModel {
  model: LanguageModel;
  providerOptions?: ProviderOptions;
  /** ChatGPT plan requests reject tools outside a namespace. */
  wrapTools: <T extends ToolSet>(tools: T) => T;
  /** Human label for errors and UI */
  label: string;
  provider: Provider;
  modelId: string;
  payer: Payer;
  /** list price; undefined for models the catalog doesn't know */
  price?: ModelPrice;
  /** Called with each call's token usage (hosted credits are spent here). */
  meter?: (tokens: TokenUsage) => Promise<void>;
}

/** Hosted Claude runs on our key and the workspace's included credits. */
export const hasHostedCredits = () => !!process.env.ANTHROPIC_API_KEY;

const identity = <T,>(t: T) => t;

const modeOf = (settings: Settings, p: Provider) => settings.authMode[p] ?? (settings.oauth[p] ? "oauth" : "key");
const payerOf = (mode: string): Payer => (mode === "credits" ? "us" : mode === "oauth" ? "plan" : "key");

/** ChatGPT signed in through the Codex CLI's login; it runs anywhere and uses the API's model ids. */
const viaCodex = (settings: Settings) => settings.oauth.openai?.via === "codex";

/**
 * Can this provider be called: included credits on this server (and, when `credits` is given, some
 * left), a sign-in (official ChatGPT only on your own machine), or a key.
 */
export function usable(settings: Settings, p: Provider, credits?: number) {
  const mode = modeOf(settings, p);
  if (mode === "credits") return p === "anthropic" && hasHostedCredits() && (credits === undefined || credits > 0);
  if (mode === "oauth") return !!settings.oauth[p] && (p !== "openai" || isLocalServer() || viaCodex(settings));
  return !!settings.apiKeys[p];
}

/** The workspace default: the picked default model, else the active provider's recommended one. */
export const defaultChoice = (settings: Settings): ModelChoice => settings.defaultModel ?? { provider: settings.provider };

/**
 * The model a call uses: the chat's pick, else the workspace default, else any connected provider.
 * A pick whose provider was disconnected, or whose included credits ran out, falls through to the next.
 */
export function resolveChoice(settings: Settings, choice?: ModelChoice, credits?: number): ModelChoice {
  const candidates = [choice, settings.defaultModel, { provider: settings.provider }, ...PROVIDERS.map((p) => ({ provider: p.id }))];
  return candidates.find((c): c is ModelChoice => !!c && usable(settings, c.provider, credits)) ?? choice ?? defaultChoice(settings);
}

/** Included credits left for a workspace; a personal one that never got its signup credits gets them now. */
export async function workspaceCredits(uid: string) {
  if (!hasHostedCredits()) return 0;
  let ws = await getWorkspace(uid);
  if (creditsLeft(ws) <= 0 && (await grantSignupCredits(uid))) ws = await getWorkspace(uid);
  return creditsLeft(ws);
}

/** Resolve the model from the user's own subscription (OAuth), API key, or included credits. */
export async function getModel(uid: string, settings: Settings, choice?: ModelChoice): Promise<ResolvedModel> {
  const [catalog, credits] = await Promise.all([getCatalog(), workspaceCredits(uid)]);
  const picked = resolveChoice(settings, choice, credits);
  const provider = picked.provider;
  const mode = modeOf(settings, provider);
  let modelId = picked.model || recommendedModel(catalog, provider).id;
  // A ChatGPT plan may not offer the API's recommended model; then take the plan's first.
  if (!picked.model && provider === "openai" && mode === "oauth" && !viaCodex(settings)) {
    const plan = await listChatGPTModels(uid).catch(() => []);
    if (plan.length && !plan.some((m) => m.id === modelId)) modelId = plan[0].id;
  }
  const price = priceOf(catalog, provider, modelId);
  const meta = { provider, modelId, payer: payerOf(mode), price };

  if (provider === "openai" && mode === "oauth" && viaCodex(settings)) {
    const openai = createOpenAI({
      apiKey: "chatgpt-plan",
      baseURL: CODEX_BASE,
      fetch: async (url, init) => {
        const send = async (force: boolean) => {
          const { token, accountId } = await codexAuth(uid, force);
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${token}`);
          for (const [k, v] of Object.entries(codexHeaders(accountId))) headers.set(k, v);
          headers.delete("openai-organization");
          headers.delete("openai-project");
          const body = typeof init?.body === "string" ? codexBody(init.body) : init?.body;
          return fetch(url, { ...init, headers, body, redirect: "error" });
        };
        let res = await send(false);
        if (res.status === 401) res = await send(true);
        if (!res.ok) throw await chatgptError(res);
        return res;
      },
    });
    // Callers always use streamText, which the Codex endpoint requires.
    return { model: openai.responses(modelId), providerOptions: { openai: { store: false } }, wrapTools: identity, label: "ChatGPT plan (Codex CLI)", ...meta };
  }

  if (provider === "openai" && mode === "oauth") {
    // OpenAI allows plan usage only from apps running on the user's machine.
    if (!isLocalServer())
      throw new Error("Official ChatGPT sign-in only runs loopers when Looper runs on your own machine. Reconnect ChatGPT through the Codex CLI in Settings, or use an OpenAI API key.");
    const openai = createOpenAI({
      apiKey: "chatgpt-plan",
      baseURL: RESOURCE,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${await chatgptAccessToken(uid)}`);
        headers.delete("openai-organization");
        headers.delete("openai-project");
        const res = await fetch(url, { ...init, headers, redirect: "error" });
        if (!res.ok) throw await chatgptError(res);
        return res;
      },
    });
    return {
      model: openai.responses(modelId),
      // Plan usage requires store:false and streaming; callers always use streamText.
      providerOptions: { openai: { store: false, systemMessageMode: "developer" } },
      wrapTools: (tools) =>
        Object.fromEntries(
          Object.entries(tools).map(([k, t]) => [
            k,
            { ...t, providerOptions: { ...t.providerOptions, openai: { ...t.providerOptions?.openai, namespace: { name: "looper", description: "Tools available to this looper." } } } },
          ]),
        ) as unknown as typeof tools,
      label: "ChatGPT plan",
      ...meta,
    };
  }

  if (provider === "xai" && mode === "oauth") {
    const proxy = settings.grokRoute === "cli-proxy";
    const xai = createXai({
      apiKey: "grok-plan",
      baseURL: proxy ? CLI_PROXY_BASE : API_BASE,
      fetch: async (url, init) => {
        const send = async (force: boolean) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${await grokAccessToken(uid, force)}`);
          let body = init?.body;
          if (proxy) {
            for (const [k, v] of Object.entries(await cliProxyHeaders())) headers.set(k, v);
            if (typeof body === "string") {
              const json = JSON.parse(body);
              // The proxy rejects these fields with 422.
              for (const f of ["seed", "parallel_tool_calls", "service_tier", "prompt_cache_retention"]) delete json[f];
              if (json.model) headers.set("x-grok-model-override", json.model);
              body = JSON.stringify(json);
            }
          }
          return fetch(url, { ...init, headers, body });
        };
        let res = await send(false);
        if (res.status === 401) res = await send(true);
        if (res.status === 403) {
          const text = await res.text();
          throw new Error(
            isGrokEntitlementError(text)
              ? `Your Grok plan doesn't cover this request (tier or monthly quota). Check ${GROK_USAGE_URL}${proxy ? "" : ", try the Grok CLI route in Settings,"} or use an xAI API key.`
              : `xAI refused the request (403): ${text.slice(0, 200)}`,
          );
        }
        return res;
      },
    });
    return { model: xai.responses(modelId), wrapTools: identity, label: "Grok plan", ...meta };
  }

  if (provider === "anthropic" && mode === "credits") {
    if (!hasHostedCredits()) throw new Error("Included credits aren't available on this server. Add an Anthropic API key in Settings.");
    if (credits <= 0)
      throw new Error("Your free Claude credits are used up. Connect your ChatGPT or Grok plan in Settings (or add an API key) to keep your loopers working.");
    return {
      model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId),
      wrapTools: identity,
      label: "Included credits",
      ...meta,
      // A model without a known price is charged as the priciest Claude, to be safe.
      meter: (tokens) => spendCredits(uid, usdOf(price ?? priciest(catalog), tokens)),
    };
  }

  const apiKey = settings.apiKeys[provider];
  if (!apiKey) {
    const label = PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
    throw new Error(`No ${label} sign-in or API key yet. Connect one in Settings.`);
  }
  switch (provider) {
    case "xai":
      return { model: createXai({ apiKey })(modelId), wrapTools: identity, label: "xAI API key", ...meta };
    case "openai":
      return { model: createOpenAI({ apiKey })(modelId), wrapTools: identity, label: "OpenAI API key", ...meta };
    case "anthropic":
      return { model: createAnthropic({ apiKey })(modelId), wrapTools: identity, label: "Anthropic API key", ...meta };
  }
}

const priciest = (catalog: Catalog) => catalog.models.anthropic.reduce<ModelPrice>((a, m) => (m.price.output > a.output ? m.price : a), { input: 0, output: 0 });

/** True when the workspace runs on its own plan or key, not only on our included credits. */
export const ownModelConnected = (settings: Settings) => PROVIDERS.some((p) => modeOf(settings, p.id) !== "credits" && usable(settings, p.id));

/** True when any provider has a usable sign-in, key or included credits (left, when `credits` is given). */
export function hasCredentials(settings: Settings, credits?: number) {
  return PROVIDERS.some((p) => usable(settings, p.id, credits));
}

/** Every model the workspace can pick now, across its connected providers, with how each is paid for. */
export async function availableModels(uid: string, settings: Settings): Promise<ModelOption[]> {
  const [catalog, credits] = await Promise.all([getCatalog(), workspaceCredits(uid)]);
  // Included-credit models only show while there are credits left to spend.
  const shown = (p: Provider) => usable(settings, p, credits);
  const lists = await Promise.all(
    PROVIDERS.filter((p) => shown(p.id)).map(async ({ id: provider }) => {
      const payer = payerOf(modeOf(settings, provider));
      const recommended = recommendedModel(catalog, provider).id;
      let models: { id: string; name: string }[] = catalog.models[provider];
      // A ChatGPT plan offers its own set of models; ask it which.
      if (provider === "openai" && payer === "plan" && !viaCodex(settings)) models = await listChatGPTModels(uid).catch(() => models);
      const options = models.map((m) => ({ provider, id: m.id, name: m.name, price: priceOf(catalog, provider, m.id), payer, recommended: m.id === recommended }));
      return options.some((o) => o.recommended) ? options : options.map((o, i) => ({ ...o, recommended: i === 0 }));
    }),
  );
  return lists.flat();
}

const CHATGPT_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: `You've reached your ChatGPT plan's usage limit. Manage it at ${USAGE_URL}.`,
  subscription_sharing_usage_unavailable: "ChatGPT plan usage is temporarily unavailable. Try again shortly.",
  subscription_sharing_user_unavailable: "ChatGPT plan usage is temporarily unavailable. Try again shortly.",
  subscription_sharing_user_not_eligible: "This ChatGPT account isn't eligible for plan usage in other apps (Plus or Pro required).",
  subscription_sharing_invalid_user: "ChatGPT didn't accept this account. Sign in with ChatGPT again.",
  usage_limit_reached: `You've reached your ChatGPT plan's Codex usage limit. Check https://chatgpt.com/codex/settings/usage, or use an OpenAI API key.`,
  usage_not_included: "This ChatGPT plan doesn't include Codex usage (Plus, Pro, Business or Enterprise required).",
};

async function chatgptError(res: Response) {
  const text = await res.text();
  let code = "";
  let message = text.slice(0, 300);
  let param = "";
  try {
    const j = JSON.parse(text);
    code = j.error?.code ?? j.error?.type ?? "";
    param = j.error?.param ?? "";
    message = j.error?.message ?? j.detail ?? message;
  } catch {}
  return new Error(CHATGPT_ERRORS[code] ?? `ChatGPT plan request failed (${res.status}${code ? ` ${code}` : ""}${param ? `, ${param}` : ""}): ${message}`);
}

/** The picker for one conversation: what can be picked, its pick, and what it runs on without one (the workspace default). */
export async function modelMenu(uid: string, settings: Settings, picked?: ModelChoice): Promise<ModelMenu> {
  const [options, credits] = await Promise.all([availableModels(uid, settings), workspaceCredits(uid)]);
  const d = resolveChoice(settings, undefined, credits);
  const inProvider = options.filter((o) => o.provider === d.provider);
  const fallback = inProvider.find((o) => o.id === d.model) ?? inProvider.find((o) => o.recommended);
  return { options, picked, fallback };
}
