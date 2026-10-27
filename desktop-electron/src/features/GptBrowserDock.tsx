import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LauncherApi } from "../types";
import { GptBrowserSurface } from "./GptBrowserSurface";

/** One browser instance and account session shared by Chat and the GPT Browser tab. */
export function GptBrowserDock({ standaloneHost, chatHost, inChat, active, api, setError }: {
  standaloneHost: HTMLDivElement | null;
  chatHost: HTMLDivElement | null;
  inChat: boolean;
  active: boolean;
  api: LauncherApi;
  setError: (message: string | null) => void;
}) {
  const [root] = useState(() => {
    const node = document.createElement("div");
    node.className = "gpb-portal-root";
    return node;
  });
  const host = inChat ? chatHost : standaloneHost;
  useLayoutEffect(() => {
    if (host && root.parentElement !== host) host.appendChild(root);
  }, [root, host]);
  useLayoutEffect(() => () => { root.remove(); }, [root]);
  return createPortal(<GptBrowserSurface api={api} active={active && Boolean(host)}
    placement={inChat ? "chat" : "standalone"} setError={setError} />, root);
}
