"use strict";

const { wrapInProcessHandler } = require("../lib/in-process-handler.cjs");
const { createModule } = require("./handlers.cjs");

module.exports = wrapInProcessHandler(createModule);
