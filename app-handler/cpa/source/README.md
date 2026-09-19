# CPA in-process panel

Coding Tools hosts the CPA management visual inside the desktop GUI. Handlers live in
`app-handler/cpa/handlers.cjs` and are invoked through `codingTools.apps`.

The optional CLIProxyAPI child on `127.0.0.1:8317` is only for proxy traffic. Opening
Settings / 原始介面 / the CPA panel must not start that process or fetch `management.html`.
