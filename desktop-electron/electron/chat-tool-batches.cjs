"use strict";

/**
 * Fixed allowlist of explicitly safe read-only tools that may be batched and executed
 * concurrently in waves of at most MAX_CONCURRENT_READS.
 *
 * DO NOT infer trust from readOnlyHint annotations or tool name prefixes (e.g. "read_*", "list_*", "get_*").
 * Only tools explicitly included in this allowlist are treated as safe read-only calls.
 */
const SAFE_READ_TOOLS = Object.freeze(new Set([
  "read_file",
  "list_dir",
  "list_files",
  "search_text",
  "grep_text",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_blame",
  "get_plan",
  "get_current_time",
  "server_info",
  "read_output",
  "list_commands",
]));

const MAX_CONCURRENT_READS = 4;

/**
 * Compact guidance for fast agent execution:
 * Instructs agents to batch independent reads together, focus verification tests,
 * reuse valid evidence, strictly preserve permission and confirmation gates, and
 * serialize heavy build commands.
 */
const FAST_EXECUTION_GUIDANCE = Object.freeze(
  "Batch independent reads (e.g. ReadMany/SearchAndRead) to minimize turn latency. " +
  "Run one focused test by default; reuse unchanged passing evidence from recent runs. " +
  "No automatic command skipping and no bypass of required gates (all permission checks and safety approvals apply). " +
  "Serialize heavy builds rather than running them in parallel. "
);

/**
 * Returns true only if the message is an explicitly safe read-only tools/call message.
 * Strictly checks against SAFE_READ_TOOLS; never infers trust from readOnlyHint or tool name prefixes.
 */
function isSafeReadToolCall(message) {
  if (!message || typeof message !== "object") return false;
  if (message.method !== "tools/call") return false;
  const name = message.params?.name;
  if (typeof name !== "string") return false;
  return SAFE_READ_TOOLS.has(name);
}

/**
 * Processes consecutive explicitly safe read-only tools/call messages in waves of max 4,
 * preserving answer order and message IDs, while every other message is an awaited barrier
 * (mutations, GUI, protocol initialize, unknown tools).
 *
 * All calls invoke the provided `dispatch` function (which performs normal permission checks).
 * Resolves returned non-null answers in input order; never overlaps across barriers.
 *
 * @param {Array<object>|object} messages - MCP message(s) to dispatch
 * @param {Function} dispatch - Async function (message, ...extraArgs) => answer
 * @param {...any} extraArgs - Additional arguments forwarded to dispatch
 * @returns {Promise<Array<object>>} Non-null answers in input order
 */
async function dispatchToolBatch(messages, dispatch, ...extraArgs) {
  if (typeof dispatch !== "function") {
    throw new TypeError("dispatch must be a function");
  }

  const list = Array.isArray(messages)
    ? messages
    : (messages && typeof messages === "object" && typeof messages[Symbol.iterator] !== "function")
      ? [messages]
      : Array.from(messages || []);

  if (!list.length) {
    return [];
  }

  const answers = [];
  let i = 0;

  while (i < list.length) {
    const message = list[i];

    if (!isSafeReadToolCall(message)) {
      // Barrier message (mutations, GUI, protocol initialize, unknown tools):
      // Awaited alone before any subsequent messages start.
      const answer = await dispatch(message, ...extraArgs);
      if (answer !== null && answer !== undefined) {
        answers.push(answer);
      }
      i++;
    } else {
      // Safe read message: collect consecutive safe read messages.
      const safeBatch = [];
      while (i < list.length && isSafeReadToolCall(list[i])) {
        safeBatch.push(list[i]);
        i++;
      }

      // Process consecutive safe reads in waves of max 4.
      for (let w = 0; w < safeBatch.length; w += MAX_CONCURRENT_READS) {
        const wave = safeBatch.slice(w, w + MAX_CONCURRENT_READS);

        const wavePromises = wave.map((msg) => {
          try {
            return Promise.resolve(dispatch(msg, ...extraArgs));
          } catch (error) {
            return Promise.reject(error);
          }
        });

        const settled = await Promise.allSettled(wavePromises);

        const rejection = settled.find((s) => s.status === "rejected");
        if (rejection) {
          throw rejection.reason;
        }

        for (const item of settled) {
          if (item.value !== null && item.value !== undefined) {
            answers.push(item.value);
          }
        }
      }
    }
  }

  return answers;
}

module.exports = {
  SAFE_READ_TOOLS,
  MAX_CONCURRENT_READS,
  FAST_EXECUTION_GUIDANCE,
  isSafeReadToolCall,
  dispatchToolBatch,
};
