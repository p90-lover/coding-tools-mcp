"use strict";

// The delegated implementation stages work under repository aiTemp/work and
// preserves replaced or failed runtime bundles under repository aiTemp/Trash.
// This wrapper never performs cleanup, deletion, or direct publication itself.
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
