"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  addIntegration,
  checkIntegration,
  disconnectSubscription,
  removeIntegration,
  removeKey,
  saveApiKey,
  setConnection,
  setDefaultModel,
  setGrokRoute,
  toggleIntegration,
} from "@/app/actions";
import type { UsageSummary, UsageTotals } from "@/lib/usage";
import type { IntegrationKind, ModelMenu, Payer, Provider, PublicSettings } from "@/lib/types";
import { PROVIDERS } from "@/lib/types";
import { ModelOptions, optionValue, parseOption, price, usd } from "./model-picker";
import { ChatGPTButton, CodexSignIn, GrokMark, GrokSignIn, OpenAIMark } from "./sign-in";
import { Button, Field, Input, Panel, Pill, Select, cx } from "./ui";

const HUBS: { kind: IntegrationKind; name: string; apps: string; how: string; header?: string }[] = [
  {
    kind: "composio",
    name: "Composio",
    apps: "Hundreds of toolkits",
    how: "Create an MCP server in the Composio dashboard, pick the toolkits, then paste its URL. Add your Composio API key as a header if the URL needs one.",
    header: "x-api-key",
  },
  {
    kind: "zapier",
    name: "Zapier MCP",
    apps: "Thousands of apps",
    how: "Open Zapier MCP, choose the actions you allow, and copy the server URL. The URL carries its own secret.",
  },
  {
    kind: "pipedream",
    name: "Pipedream",
    apps: "Thousands of apps",
    how: "Use Pipedream's remote MCP server URL for your project. Add the auth header Pipedream gives you.",
    header: "Authorization",
  },
  {
    kind: "custom",
    name: "Any MCP server",
    apps: "Your own tools",
    how: "Any Streamable HTTP MCP endpoint: your internal APIs, Linear, Notion, Stripe, GitHub and others.",
    header: "Authorization",
  },
];

export interface ConnectedApp {
  slug: string;
  name: string;
  logo?: string;
  accounts: string[];
  loopers: { id: string; name: string }[];
}

export type Labeled = Omit<UsageSummary, "byModel" | "bySource"> & {
  byModel: (UsageSummary["byModel"][number] & { name: string })[];
  bySource: (UsageSummary["bySource"][number] & { name: string })[];
};
export interface UsageProps {
  workspace: Labeled;
}

export function SettingsView({ settings, menu, usage, apps, notice }: { settings: PublicSettings; menu: ModelMenu; usage: UsageProps; apps: ConnectedApp[]; notice?: string }) {
  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-10 sm:px-6">
      <h1 className="display text-[2.5rem] sm:text-[3rem]">Settings</h1>
      <p className="mt-2 max-w-[60ch] text-[1rem] text-mute">Connect the AI your loopers run on and the apps they can use.</p>
      {notice && <div className="mt-6 rounded-[12px] bg-blue/10 px-4 py-3 text-[0.875rem] text-blue">{notice}</div>}

      <section id="ai" className="mt-10 scroll-mt-6">
        <h2 className="mb-1 text-[1.25rem] font-semibold tracking-[-0.01em]">AI</h2>
        <p className="mb-4 text-[0.875rem] text-mute">Connect any of these. Every chat has its own model picker with the models they give you, always the current ones.</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {PROVIDERS.map((p) => (
            <ProviderCard key={p.id} id={p.id} settings={settings} />
          ))}
        </div>
        <DefaultModel menu={menu} />
      </section>

      <section className="mt-12">
        <h2 className="mb-1 text-[1.25rem] font-semibold tracking-[-0.01em]">Usage this month</h2>
        <p className="mb-4 text-[0.875rem] text-mute">Every model call, by who pays for it. Plan usage is shown at what the same tokens would cost on the API.</p>
        <Usage usage={usage.workspace} />
      </section>

      <section className="mt-12">
        <h2 className="mb-1 text-[1.25rem] font-semibold tracking-[-0.01em]">Connected apps</h2>
        <p className="mb-4 text-[0.875rem] text-mute">Connect an app once and every looper can use it. Add or remove them from a looper&apos;s Tools tab.</p>
        {apps.length ? (
          <div className="tile divide-y divide-line overflow-hidden">
            {apps.map((a) => (
              <div key={a.slug} className="flex items-center gap-3 px-4 py-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {a.logo ? <img src={a.logo} alt="" className="h-8 w-8 rounded-[8px] bg-white object-contain p-1" /> : <span className="h-8 w-8 rounded-[8px] bg-ink/[0.06]" />}
                <div className="min-w-0 flex-1">
                  <div className="text-[0.9375rem] font-medium">{a.name}</div>
                  <div className="truncate text-[0.8125rem] text-mute">{a.accounts.join(", ")}</div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {a.loopers.map((l) => (
                    <a key={l.id} href={`/loopers/${l.id}?tab=apps`} className="rounded-full bg-ink/[0.05] px-2.5 py-0.5 text-[0.75rem] text-mute hover:text-ink">
                      {l.name}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="tile px-4 py-4 text-[0.875rem] text-mute">No apps connected yet. Each looper lists the apps it needs under Tools tab.</p>
        )}
      </section>

      <details className="group mt-12" open={settings.integrations.length > 0}>
        <summary className="flex cursor-pointer list-none items-baseline gap-2 [&::-webkit-details-marker]:hidden">
          <h2 className="text-[1.25rem] font-semibold tracking-[-0.01em]">Advanced</h2>
          <span className="text-[0.875rem] text-mute">MCP hubs and custom servers</span>
          <span className="text-[0.875rem] text-mute transition-transform group-open:rotate-90">›</span>
        </summary>
        <p className="mb-4 mt-1 text-[0.875rem] text-mute">A hub is one MCP link that reaches hundreds or thousands of apps, for apps you&apos;d rather connect through Zapier, Pipedream or your own server.</p>
        <Integrations settings={settings} />
      </details>
    </div>
  );
}

const BILLED: Record<Payer, string> = {
  us: "Credits from Looper, nothing billed to you",
  key: "Billed per token by the provider",
  plan: "Counts against your plan's limits",
};

function ProviderCard({ id, settings }: { id: Provider; settings: PublicSettings }) {
  const router = useRouter();
  const meta = PROVIDERS.find((p) => p.id === id)!;
  const sub = settings.subscriptions[id];
  const hasKey = settings.keysSet[id];
  const credits = id === "anthropic" ? settings.creditsLeft : undefined;
  const mode = settings.authMode[id] ?? (sub ? "oauth" : hasKey ? "key" : credits !== undefined ? "credits" : "key");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); });

  const Mark = id === "openai" ? OpenAIMark : id === "anthropic" ? ClaudeMark : GrokMark;
  const usable = mode === "credits" ? (credits ?? 0) > 0 : mode === "oauth" ? !!sub && (id !== "openai" || settings.isLocal || settings.subscriptions.openai?.via === "codex") : hasKey;
  const payer: Payer = mode === "credits" ? "us" : mode === "oauth" ? "plan" : "key";
  const how =
    mode === "credits"
      ? `Included credits · $${(credits ?? 0).toFixed(2)} left`
      : mode === "oauth" && sub
        ? `${meta.plan} plan${"via" in sub && sub.via === "codex" ? " via Codex CLI" : ""}${sub.email ? ` · ${sub.email}` : ""}`
        : hasKey
          ? `${meta.label} API key`
          : "Not connected";

  return (
    <Panel className="flex flex-col gap-5 p-6">
      <div className="flex items-start gap-3">
        {id === "xai" ? (
          <Mark className="h-11 w-11 shrink-0" />
        ) : id === "anthropic" ? (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[22%] bg-[#F5F4EE] text-[#D97757] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)]">
            <Mark className="h-6 w-6" />
          </span>
        ) : (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[22%] bg-ink text-page">
            <Mark className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[1.0625rem] font-semibold">{meta.plan}</span>
            {usable && <Pill tone="green">Connected</Pill>}
          </div>
          <div className="truncate text-[0.8125rem] text-mute" title={how}>{how}</div>
          {usable && <div className="text-[0.75rem] text-faint">{BILLED[payer]}</div>}
        </div>
      </div>

      {id === "anthropic" ? (
        !!credits && credits > 0 && mode !== "credits" && (
          <div>
            <Button size="sm" variant="soft" disabled={pending} onClick={() => act(() => setConnection(id, "credits"))}>
              Use included credits · ${credits.toFixed(2)} left
            </Button>
          </div>
        )
      ) : sub ? (
        <div className="flex flex-col gap-3">
          {id === "openai" && !settings.subscriptions.openai?.sharing && (
            <p className="text-[0.8125rem] text-red">Plan usage wasn&apos;t granted. Sign in again and allow plan usage.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {mode === "key" && (
              <Button size="sm" variant="soft" disabled={pending} onClick={() => act(() => setConnection(id, "oauth"))}>
                Use my {meta.plan} plan
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => disconnectSubscription(id))}>
              Disconnect {meta.plan}
            </Button>
          </div>
        </div>
      ) : id === "openai" ? (
        settings.isLocal ? (
          <ChatGPTButton isLocal label="Connect ChatGPT plan" />
        ) : (
          <div className="flex flex-col gap-2">
            <CodexSignIn onConnected={() => router.refresh()} />
            <p className="text-[0.75rem] leading-snug text-mute">
              Signs in the way the Codex CLI does and runs loopers on your plan&apos;s Codex usage (Plus, Pro, Business or Enterprise). Unofficial and identifies as the Codex CLI. If OpenAI says device codes are off, turn on device code sign-in for Codex in ChatGPT&apos;s security settings.
            </p>
          </div>
        )
      ) : (
        <GrokSignIn label="Connect Grok plan" onConnected={() => router.refresh()} />
      )}

      {id === "xai" && sub && mode === "oauth" && (
        <Field label="Send Grok requests to" hint="Some SuperGrok tiers get a 403 on xAI's API. The Grok CLI endpoint is what the Grok CLI uses; it's unofficial and identifies as the Grok CLI.">
          <Select value={settings.grokRoute} onChange={(e) => act(() => setGrokRoute(e.target.value as "api" | "cli-proxy"))}>
            <option value="api">xAI API (api.x.ai)</option>
            <option value="cli-proxy">Grok CLI endpoint (unofficial)</option>
          </Select>
        </Field>
      )}

      <div className="mt-auto">
        {hasKey && mode !== "key" && (
          <Button size="sm" variant="soft" className="mb-3" disabled={pending} onClick={() => act(() => setConnection(id, "key"))}>
            Use my API key
          </Button>
        )}
        <button className="block text-[0.8125rem] text-blue hover:underline" onClick={() => setShowKey((s) => !s)}>
          {showKey ? "Hide API key" : hasKey ? "API key saved · change" : `Use an ${meta.label} API key`}
        </button>
        {showKey && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => {
                await saveApiKey(id, key);
                setKey("");
                setShowKey(false);
              });
            }}
          >
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? "Paste to replace" : meta.keyHint} autoComplete="off" />
            {key ? (
              <Button size="sm" type="submit" className="!h-10" disabled={pending}>
                Save
              </Button>
            ) : (
              hasKey && (
                <Button size="sm" type="button" variant="ghost" className="!h-10" onClick={() => act(() => removeKey(id))}>
                  Remove
                </Button>
              )
            )}
          </form>
        )}
      </div>
    </Panel>
  );
}

/** The model for scheduled runs and for chats with nothing picked. */
function DefaultModel({ menu }: { menu: ModelMenu }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const current = menu.fallback;
  return (
    <div className="tile mt-4 flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-[0.9375rem] font-semibold">Default model</div>
        <div className="text-[0.8125rem] text-mute">
          {current
            ? `For scheduled runs and chats with no model picked.${current.price ? ` ${price(current.price)} per million tokens in / out.` : ""}`
            : "Connect one of the above to pick a model."}
        </div>
      </div>
      {menu.options.length > 0 && (
        <Select
          className="sm:max-w-[320px]"
          disabled={pending}
          value={current ? optionValue(current) : ""}
          onChange={(e) =>
            start(async () => {
              await setDefaultModel(parseOption(e.target.value));
              router.refresh();
            })
          }
        >
          <ModelOptions options={menu.options} />
        </Select>
      )}
    </div>
  );
}

const PAYERS: { id: Payer; label: string; hint: string }[] = [
  { id: "us", label: "Included credits", hint: "Paid by Looper from your plan" },
  { id: "key", label: "Your API keys", hint: "Billed to you by the provider" },
  { id: "plan", label: "Your plans", hint: "API value of ChatGPT and Grok plan usage" },
];

const tokens = (n: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const line = (t: UsageTotals) => `${tokens(t.tokens)} tokens · ${t.calls} call${t.calls === 1 ? "" : "s"}`;

export function Usage({ usage, sources = true }: { usage: Labeled; sources?: boolean }) {
  if (!usage.total.calls) return <p className="tile px-4 py-4 text-[0.875rem] text-mute">No model calls yet this month.</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {PAYERS.map((p) => {
          const t = usage.byPayer[p.id];
          return (
            <div key={p.id} className="tile p-4">
              <div className="text-[0.8125rem] text-mute">{p.label}</div>
              <div className="mt-1 text-[1.5rem] font-semibold tracking-[-0.02em] tabular-nums">{usd(t.usd)}</div>
              <div className="text-[0.75rem] text-faint">{t.calls ? line(t) : p.hint}</div>
              {t.unpriced > 0 && <div className="text-[0.75rem] text-faint">{t.unpriced} calls on models without a known price</div>}
            </div>
          );
        })}
      </div>
      <div className={cx("grid grid-cols-1 gap-3", sources && "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]")}>
        <div className="tile divide-y divide-line overflow-hidden">
          {usage.byModel.map((m) => (
            <div key={`${m.provider}|${m.model}|${m.payer}`} className="flex items-center gap-3 px-4 py-2.5 text-[0.875rem]">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{m.name}</div>
                <div className="truncate text-[0.75rem] text-mute">{PAYERS.find((p) => p.id === m.payer)!.label} · {line(m)}</div>
              </div>
              <div className="shrink-0 tabular-nums">{usd(m.usd)}</div>
            </div>
          ))}
        </div>
        {sources && (
          <div className="tile divide-y divide-line self-start overflow-hidden">
            {usage.bySource.map((x) => (
              <div key={x.source} className="flex items-center gap-3 px-4 py-2.5 text-[0.875rem]">
                <div className="min-w-0 flex-1 truncate">{x.name}</div>
                <div className="shrink-0 text-[0.75rem] text-mute">{tokens(x.tokens)}</div>
                <div className="w-16 shrink-0 text-right tabular-nums">{usd(x.usd)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Integrations({ settings }: { settings: PublicSettings }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hub, setHub] = useState<(typeof HUBS)[number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  const test = (id: string) => {
    setTests((t) => ({ ...t, [id]: "Connecting…" }));
    start(async () => {
      const r = await checkIntegration(id);
      setTests((t) => ({ ...t, [id]: r.ok ? `✓ ${r.count} tools: ${r.sample.join(", ")}${r.count > r.sample.length ? "…" : ""}` : `✕ ${r.error}` }));
    });
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="grid grid-cols-2 gap-3">
        {HUBS.map((h) => (
          <button
            key={h.kind}
            onClick={() => {
              setHub(h);
              setError(null);
            }}
            className={cx("tile flex flex-col gap-0.5 p-4 text-left", hub?.kind === h.kind && "ring-2 ring-blue")}
          >
            <div className="font-semibold">{h.name}</div>
            <div className="text-[0.8125rem] text-mute">{h.apps}</div>
          </button>
        ))}
      </div>

      <Panel className="p-6">
        {hub ? (
          <form
            className="grid gap-4"
            action={(fd) =>
              start(async () => {
                setError(null);
                try {
                  await addIntegration({
                    name: String(fd.get("name")),
                    kind: hub.kind,
                    url: String(fd.get("url")),
                    headerName: String(fd.get("headerName") ?? ""),
                    headerValue: String(fd.get("headerValue") ?? ""),
                  });
                  setHub(null);
                  router.refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              })
            }
          >
            <div className="text-[1.25rem] font-semibold tracking-[-0.01em]">Connect {hub.name}</div>
            <p className="text-[0.8125rem] leading-relaxed text-mute">{hub.how}</p>
            <Field label="Name">
              <Input name="name" defaultValue={hub.name} />
            </Field>
            <Field label="MCP server URL">
              <Input name="url" type="url" required placeholder="https://…" />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
              <Field label="Header">
                <Input name="headerName" defaultValue={hub.header ?? ""} placeholder="optional" />
              </Field>
              <Field label="Value">
                <Input name="headerValue" type="password" placeholder="optional" autoComplete="off" />
              </Field>
            </div>
            {error && <p className="text-[0.8125rem] text-red">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setHub(null)}>Cancel</Button>
              <Button type="submit" disabled={pending}>Connect</Button>
            </div>
          </form>
        ) : settings.integrations.length === 0 ? (
          <div className="flex h-full min-h-56 flex-col justify-center gap-2">
            <div className="text-[1.25rem] font-semibold tracking-[-0.01em]">Thousands of apps, one link each</div>
            <p className="text-[0.875rem] leading-relaxed text-mute">
              Connect a hub and every looper can reach Gmail, Slack, HubSpot, LinkedIn, Notion, Sheets, Stripe and thousands more. They search for the tool they need at run time, so a big catalog doesn&apos;t slow them down.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="mb-1 text-[0.8125rem] font-medium text-mute">Connected</div>
            {settings.integrations.map((i) => (
              <div key={i.id} className="rounded-[12px] bg-well p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[0.9375rem] font-medium">{i.name}</div>
                    <div className="truncate text-[0.75rem] text-mute">
                      {i.url.replace(/(https?:\/\/[^/]+).*/, "$1/…")}
                      {i.headerNames.length > 0 && ` · ${i.headerNames.join(", ")}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => test(i.id)}>Test</Button>
                    <Button size="sm" variant="soft" onClick={() => start(async () => { await toggleIntegration(i.id); router.refresh(); })}>
                      {i.enabled ? "On" : "Off"}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => start(async () => { await removeIntegration(i.id); router.refresh(); })} aria-label={`Remove ${i.name}`}>
                      ✕
                    </Button>
                  </div>
                </div>
                {tests[i.id] && <div className={cx("mt-2 break-words text-[0.75rem]", tests[i.id].startsWith("✕") ? "text-orange" : "text-green-deep")}>{tests[i.id]}</div>}
              </div>
            ))}
            <p className="mt-2 text-[0.75rem] text-faint">Pick a hub to add another.</p>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Claude's spark (simple-icons). */
function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}
