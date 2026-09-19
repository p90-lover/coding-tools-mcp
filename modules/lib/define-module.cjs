"use strict";

const { sanitizePublic } = require("./sanitize.cjs");

function lifecycleOperations(moduleId) {
  async function run(action, context) {
    const fn = context.services?.[action];
    if (typeof fn !== "function") {
      throw new Error(`${moduleId} ${action} is unavailable`);
    }
    return sanitizePublic(await fn(moduleId));
  }

  return {
    inspect: {
      readOnly: true,
      description: `Inspect the managed ${moduleId} child service without opening a GUI.`,
      run: (_args, context) => run("inspect", context),
    },
    start: {
      readOnly: false,
      description: `Start the managed ${moduleId} child service owned by Coding Tools.`,
      run: (_args, context) => run("start", context),
    },
    stop: {
      readOnly: false,
      description: `Stop the managed ${moduleId} child service.`,
      run: (_args, context) => run("stop", context),
    },
    restart: {
      readOnly: false,
      description: `Restart the managed ${moduleId} child service.`,
      run: (_args, context) => run("restart", context),
    },
    repair: {
      readOnly: false,
      description: `Repair the managed ${moduleId} install, then inspect.`,
      run: async (_args, context) => {
        if (typeof context.services?.repair === "function") {
          return sanitizePublic(await context.services.repair(moduleId));
        }
        return run("restart", context);
      },
    },
    install: {
      readOnly: false,
      description: `Install or repair the managed ${moduleId} runtime through Coding Tools.`,
      run: async (_args, context) => {
        if (typeof context.services?.repair === "function") {
          return sanitizePublic(await context.services.repair(moduleId));
        }
        return run("start", context);
      },
    },
  };
}

function defineModule({ id, name, loopback, extraOperations = {} }) {
  const operations = { ...lifecycleOperations(id), ...extraOperations };
  const table = new Map(
    Object.entries(operations).map(([operation, spec]) => [operation, {
      readOnly: spec.readOnly === true,
      description: spec.description || "",
      run: spec.run,
    }]),
  );

  return Object.freeze({
    id,
    name,
    loopback: Object.freeze({ ...loopback }),
    operations: Object.freeze([...table.entries()].map(([operation, spec]) => Object.freeze({
      name: operation,
      readOnly: spec.readOnly,
      description: spec.description,
    }))),
    isReadOnly(operation) {
      return table.get(String(operation || ""))?.readOnly === true;
    },
    async call(operation, args, context) {
      const spec = table.get(String(operation || ""));
      if (!spec) throw new Error(`Unknown ${id} operation: ${operation || "missing"}`);
      return spec.run(args && typeof args === "object" ? args : {}, context);
    },
  });
}

module.exports = {
  defineModule,
  lifecycleOperations,
};
