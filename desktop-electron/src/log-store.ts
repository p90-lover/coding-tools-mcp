import { useSyncExternalStore } from "react";
import type { LogRecord } from "./types";

// The launcher's recent log lines live here, outside React state. As App state, every line
// re-rendered the whole window (chat and agent surfaces included), and the Activity table, kept
// mounted once visited, rebuilt all its rows because their keys held their position: each line
// froze the window for ~100 ms while a task was logging and the person was typing. Now only the
// Activity table re-renders, and a new line adds one row.
const LIMIT = 300;

let records: readonly LogRecord[] = [];
const listeners = new Set<() => void>();
const ids = new WeakMap<LogRecord, number>();
let nextId = 0;

function track(record: LogRecord) {
  if (!ids.has(record)) ids.set(record, nextId++);
  return record;
}

function emit() {
  for (const listener of listeners) listener();
}

export function replaceLogs(next: readonly LogRecord[]) {
  records = next.slice(-LIMIT).map(track);
  emit();
}

export function appendLog(record: LogRecord) {
  records = [...records.slice(-(LIMIT - 1)), track(record)];
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const read = () => records;

export function useLogs(): readonly LogRecord[] {
  return useSyncExternalStore(subscribe, read, read);
}

/** A key that stays with the record while lines are added and the oldest ones drop off. */
export function logKey(record: LogRecord): number {
  return ids.get(record) ?? ids.set(record, nextId++).get(record)!;
}
