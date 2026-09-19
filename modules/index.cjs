"use strict";

const { MODULE_IDS, createCodingToolsAppsHost } = require("./host.cjs");
const {
  FOREIGN_SLOTS,
  createHandlerRegistry,
  defaultRegistry,
} = require("./handler-registry.cjs");

module.exports = {
  MODULE_IDS,
  FOREIGN_SLOTS,
  createCodingToolsAppsHost,
  createHandlerRegistry,
  defaultRegistry,
};
