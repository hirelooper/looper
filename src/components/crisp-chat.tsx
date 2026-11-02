"use client";

import { useEffect } from "react";

type CrispUser = { email?: string; name?: string; avatar?: string; workspace?: string };

declare global {
  interface Window {
    $crisp?: unknown[][];
    CRISP_WEBSITE_ID?: string;
  }
}

/** Crisp chat bubble. Loads once per page; tells Crisp who is chatting when we know. */
export function CrispChat({ websiteId, user }: { websiteId?: string; user?: CrispUser }) {
  useEffect(() => {
    if (!websiteId || window.CRISP_WEBSITE_ID) return;
    window.$crisp = window.$crisp ?? [];
    window.CRISP_WEBSITE_ID = websiteId;
    const s = document.createElement("script");
    s.src = "https://client.crisp.chat/l.js";
    s.async = true;
    document.head.appendChild(s);
  }, [websiteId]);

  const { email, name, avatar, workspace } = user ?? {};
  useEffect(() => {
    if (!websiteId) return;
    const q = (window.$crisp = window.$crisp ?? []);
    if (email) q.push(["set", "user:email", [email]]);
    if (name) q.push(["set", "user:nickname", [name]]);
    if (avatar) q.push(["set", "user:avatar", [avatar]]);
    if (workspace) q.push(["set", "session:data", [[["workspace", workspace]]]]);
  }, [websiteId, email, name, avatar, workspace]);

  return null;
}
