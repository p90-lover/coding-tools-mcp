"use strict";

const electron = require("electron");
const {
  clearHeadlessExecutionHost,
  registerHeadlessExecutionHost,
} = require("./headless-execution-registry.cjs");
const { installProviderNetwork } = require("./provider-bootstrap.cjs");

const headlessModulePath = require.resolve("./headless-host.cjs");
const headlessModule = require(headlessModulePath);

class RegisteredHeadlessHost extends headlessModule.HeadlessHost {
  constructor(options) {
    super(options);
    registerHeadlessExecutionHost(this);
  }

  async shutdown(...args) {
    try {
      return await super.shutdown(...args);
    } finally {
      clearHeadlessExecutionHost(this);
    }
  }
}

require.cache[headlessModulePath].exports = Object.freeze({
  ...headlessModule,
  HeadlessHost: RegisteredHeadlessHost,
});

installProviderNetwork(electron);
require("./main.cjs");
