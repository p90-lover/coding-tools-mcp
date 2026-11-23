"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { fail, encode } = require("./chat-input-schema.cjs");

function createChatInputStore({ file, attachmentsRoot, maxPending = 64, maxStoredBytes, startupTimeoutMs = 30000, createWorker = (file, options) => new Worker(file, options) } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || typeof attachmentsRoot !== "string" || !path.isAbsolute(attachmentsRoot)) throw fail("INPUT_ROOT_REQUIRED", "Choose explicit absolute input and attachment storage paths");
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 256) throw fail("INPUT_INVALID", "Input storage request capacity must be 1 to 256");
  let worker = null, ready = null, closed = false, closing = null, sequence = 0, admitted = 0, fatal = null, exited = null;
  const pending = new Map();
  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let timer;
      const failAll = error => {
        fatal = error; closed = true;
        clearTimeout(timer); reject(error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      };
      try {
        worker = createWorker(path.join(__dirname, "chat-input-worker.cjs"), { workerData: { chatInputStore: true, file, attachmentsRoot, maxStoredBytes } });
        exited = new Promise(resolveExit => worker.once("exit", resolveExit));
        timer = setTimeout(() => {
          failAll(fail("INPUT_STORE_TIMEOUT", "Input storage did not become ready; no save was acknowledged"));
          void worker.terminate();
        }, startupTimeoutMs);
        worker.on("message", message => {
          if (message.ready) { clearTimeout(timer); resolve(); return; }
          if (message.startupError) { failAll(fail(message.startupError.code, message.startupError.message)); return; }
          const request = pending.get(message.requestId);
          if (!request) return;
          pending.delete(message.requestId);
          if (message.error) request.reject(fail(message.error.code, message.error.message));
          else request.resolve(message.result);
        });
        worker.on("error", () => failAll(fail("INPUT_STORE_FAILED", "Input storage stopped; check the saved input before retrying")));
        worker.on("exit", () => failAll(fail("INPUT_STORE_CLOSED", "Input storage is closed")));
      } catch (error) { failAll(fail("INPUT_STORE_FAILED", "Input storage could not be started")); }
    });
    return ready;
  }
  async function call(operation, args = {}) {
    if (closed || closing && operation !== "close") throw fatal ?? fail("INPUT_STORE_CLOSED", "Input storage is closing");
    if (admitted >= maxPending && operation !== "close") throw fail("INPUT_STORE_BUSY", "Input storage is busy; this input was not accepted");
    encode(args);
    admitted += 1;
    try {
      await start();
      if (closed) throw fatal;
      return await new Promise((resolve, reject) => {
        const requestId = ++sequence;
        pending.set(requestId, { resolve, reject });
        try { worker.postMessage({ requestId, operation, args }); }
        catch (error) { pending.delete(requestId); reject(fail("INPUT_INVALID", "Input could not be sent to storage")); }
      });
    } finally { admitted -= 1; }
  }
  return Object.freeze({
    call,
    saved: () => ready ? call("barrier") : Promise.resolve({ saved: true }),
    close() {
      if (closing) return closing;
      if (!worker) { closed = true; return Promise.resolve(); }
      closing = (async () => {
        if (!closed) await call("close");
        await exited;
      })();
      return closing;
    },
  });
}

module.exports = { createChatInputStore };
