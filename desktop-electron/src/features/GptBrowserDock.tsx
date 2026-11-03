import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LauncherApi } from "../types";
import { PartErrorBoundary } from "../PartErrorBoundary";
import { GptBrowserSurface } from "./GptBrowserSurface";

/** One browser instance and account session shared by Chat and the GPT Browser tab. */
export function GptBrowserDock({ standaloneHost, chatHost, inChat, active, covered = false, api, setError }: {
  standaloneHost: HTMLDivElement | null;
  chatHost: HTMLDivElement | null;
  inChat: boolean;
  active: boolean;
  /** The sidebar or a dialog is laid over the pane: a still of the page stands in for it. */
  covered?: boolean;
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
  return createPortal(<PartErrorBoundary label="ChatGPT Web">
    <GptBrowserSurface api={api} active={active && Boolean(host)} covered={covered}
      placement={inChat ? "chat" : "standalone"} setError={setError} />
  </PartErrorBoundary>, root);
}
