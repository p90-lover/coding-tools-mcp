"use strict";

const { prepareRuntime } = require("./runtime-preparation.cjs");

if (require.main === module) {
  try {
    const result = prepareRuntime();
    process.stdout.write(`RUNTIME_PREPARED ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { prepareRuntime };
