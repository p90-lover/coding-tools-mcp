// First: an app started from an agent's shell drops that agent session's environment before any
// module reads it (agent-session-env.cjs).
require("./agent-session-env.cjs").cleanAgentSessionEnvironment();
// One host for the whole backend (electron/host, docs/specs/electron-host-seam-lifecycle), registered
// before anything uses it: the provider network gets it here and main.cjs asks for it. A WebView2
// entry registers its own host in this place, and nothing after it changes.
const { currentHost, setCurrentHost } = require("./host/current.cjs");
const host = currentHost();
setCurrentHost(host);
const { installProviderNetwork } = require("./provider-bootstrap.cjs");

installProviderNetwork(host);
require("./main.cjs");
