import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { ProviderHubIntegration } from "./providers/ProviderHubIntegration";
import "./tokens.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* A render error anywhere used to unmount everything and leave a black window. */}
    <AppErrorBoundary>
      <ProviderHubIntegration>
        <App />
      </ProviderHubIntegration>
    </AppErrorBoundary>
  </React.StrictMode>,
);
