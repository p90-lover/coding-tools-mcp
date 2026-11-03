// First: an app started from an agent's shell drops that agent session's environment before any
// module reads it (agent-session-env.cjs).
require("./agent-session-env.cjs").cleanAgentSessionEnvironment();
const electron = require("electron");
const { installProviderNetwork } = require("./provider-bootstrap.cjs");

installProviderNetwork(electron);
require("./main.cjs");
