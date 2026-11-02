"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setChatModel } from "@/app/actions";
import type { ModelChoice, ModelMenu, ModelOption, ModelPrice, Payer, Provider } from "@/lib/types";
import { cx } from "./ui";

const providerName = (p: Provider, payer: Payer) => (p === "anthropic" ? "Claude" : p === "xai" ? "Grok" : payer === "plan" ? "ChatGPT" : "OpenAI");
const PAYER_NAME: Record<Payer, string> = { us: "included credits", key: "your API key", plan: "your plan" };

export const optionValue = (o: Pick<ModelOption, "provider" | "id">) => `${o.provider}:${o.id}`;
export function parseOption(v: string): ModelChoice {
  const i = v.indexOf(":");
  return { provider: v.slice(0, i) as Provider, model: v.slice(i + 1) };
}

const num = (n: number) => (n < 1 ? n.toFixed(2).replace(/0$/, "") : String(+n.toFixed(2)));
/** "$2 / $10": USD per million tokens in / out */
export const price = (p: ModelPrice) => `$${num(p.input)} / $${num(p.output)}`;

export function usd(n: number) {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** The models, grouped by provider and who pays, for a native select. */
export function ModelOptions({ options }: { options: ModelOption[] }) {
  const groups = [...new Set(options.map((o) => o.provider))];
  return groups.map((p) => {
    const list = options.filter((o) => o.provider === p);
    return (
      <optgroup key={p} label={`${providerName(p, list[0].payer)} · ${PAYER_NAME[list[0].payer]}`}>
        {list.map((o) => (
          <option key={o.id} value={optionValue(o)}>
            {o.name}
            {o.price ? `  ·  ${price(o.price)}` : ""}
          </option>
        ))}
      </optgroup>
    );
  });
}

const CONNECT = "connect";
const CONNECT_HREF = "/settings#ai";

/**
 * The model a conversation runs on, picked from what the workspace has connected.
 * `target` is "chief" or a looper id; a looper's runs use its pick too.
 */
export function ChatModelPicker({ target, menu, disabled }: { target: string; menu: ModelMenu; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { options, picked, fallback } = menu;
  // No plan signed in and no included credits left: point to Settings to connect one.
  const needsPlan = !options.some((o) => o.payer === "plan" || o.payer === "us");
  if (!options.length)
    return (
      <Link href={CONNECT_HREF} className="mb-0.5 flex h-9 shrink-0 items-center rounded-full px-3 text-[0.8125rem] text-blue transition-colors hover:bg-ink/[0.05]">
        Connect your own ChatGPT or Grok, use it free
      </Link>
    );
  // A pick whose provider is no longer connected runs on the default.
  const live = picked && options.some((o) => o.provider === picked.provider) ? picked : undefined;
  const known = live && options.find((o) => o.provider === live.provider && o.id === live.model);
  const shown = known ?? (live?.model ? { name: live.model } : fallback);
  const value = live?.model ? `${live.provider}:${live.model}` : "";

  return (
    <label
      className={cx(
        "relative mb-0.5 flex h-9 max-w-[45%] shrink-0 items-center gap-1 rounded-full px-3 text-[0.8125rem] text-mute transition-colors hover:bg-ink/[0.05] hover:text-ink",
        pending && "opacity-50",
      )}
      title={known?.price ? `${price(known.price)} per million tokens · ${PAYER_NAME[known.payer]}` : "Model for this chat"}
    >
      <span className="truncate">{shown?.name ?? "Model"}</span>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
        <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <select
        aria-label="Model for this chat"
        value={value}
        disabled={disabled || pending}
        onChange={(e) => {
          if (e.target.value === CONNECT) return router.push(CONNECT_HREF);
          start(async () => {
            await setChatModel(target, e.target.value ? parseOption(e.target.value) : null);
            router.refresh();
          });
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">Default{fallback ? ` (${fallback.name})` : ""}</option>
        {live?.model && !known && <option value={value}>{live.model}</option>}
        <ModelOptions options={options} />
        {needsPlan && (
          <optgroup label="More models">
            <option value={CONNECT}>Connect your own ChatGPT or Grok, use it free…</option>
          </optgroup>
        )}
      </select>
    </label>
  );
}
