const electron = require("electron");
const { installProviderNetwork } = require("./provider-bootstrap.cjs");

installProviderNetwork(electron);
require("./main.cjs");
