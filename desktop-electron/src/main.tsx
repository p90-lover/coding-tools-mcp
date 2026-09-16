import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ProviderHubIntegration } from "./providers/ProviderHubIntegration";
import "./tokens.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ProviderHubIntegration>
      <App />
    </ProviderHubIntegration>
  </React.StrictMode>,
);
