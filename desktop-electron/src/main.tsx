import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { installShimmerTicker } from "./features/shimmer-ticker";
import "./tokens.css";
import "./styles.css";
// The provider screens' styles. They came in with ProviderHubIntegration, whose Providers row under
// Connections (and the overlay it opened) left the sidebar on 2026-11-02.
import "./providers/provider-manager.css";
// The GPT Browser's bar and tabs, which the browser screen wears.
import "./features/gpt-browser.css";

installShimmerTicker();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* A render error anywhere used to unmount everything and leave a black window. */}
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
