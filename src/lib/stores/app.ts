import { writable } from "svelte/store";
import type { LinkedProject, RuntimeState, WorkspaceProfile } from "$lib/types";

export const workspaces = writable<WorkspaceProfile[]>([]);
export const linkedProjectsByWorkspace = writable<Record<string, LinkedProject[]>>({});
export const mcpRuntimeStates = writable<Record<string, RuntimeState>>({});
export const actionsRuntimeStates = writable<Record<string, RuntimeState>>({});

/** @deprecated use mcpRuntimeStates */
export const runtimeStates = mcpRuntimeStates;

export function overallRuntimeState(
  mcp: RuntimeState | undefined,
  actions: RuntimeState | undefined,
): RuntimeState {
  const states = [mcp ?? "stopped", actions ?? "stopped"];
  if (states.some((state) => state === "error")) return "error";
  if (states.some((state) => state === "running")) return "running";
  if (states.some((state) => state === "starting")) return "starting";
  if (states.some((state) => state === "stopping")) return "stopping";
  return "stopped";
}
