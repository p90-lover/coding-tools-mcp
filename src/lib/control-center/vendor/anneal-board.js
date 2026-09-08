// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Moson Lab
// Adapted from mosonlab/anneal apps/web/src/lib/board.ts at
// 088f0d5971a1692134aaa3db0230cc541b014c07. See third_party/anneal/LICENSE.
// Changed: browser-only JS, local English labels, unknown-state handling.
export const COLUMNS = [
  { status: 'BACKLOG', label: 'Backlog', zh: '待規劃' },
  { status: 'TODO', label: 'Ready', zh: '待處理' },
  { status: 'DOING', label: 'In progress', zh: '進行中' },
  { status: 'REVIEW', label: 'Review', zh: '待審查' },
  { status: 'DONE', label: 'Done', zh: '已完成' },
];
export const STATUSES = COLUMNS.map(column => column.status);
/** @param {string | null | undefined} raw */
export const parseStatus = raw => STATUSES.find(status => status === (raw ?? '').toUpperCase()) ?? null;
/** @param {readonly {status: string}[]} tasks */
export const countByStatus = tasks => {
  /** @type {Record<string,number>} */
  const counts = Object.fromEntries(STATUSES.map(status => [status,0]));
  for (const task of tasks) if (Object.hasOwn(counts,task.status)) counts[task.status] += 1;
  return counts;
};
/** @param {Record<string,number>} counts */
export const defaultTab = counts => counts.TODO > 0 ? 'TODO' : STATUSES.filter(status => status !== 'DONE').find(status => counts[status] > 0) ?? 'TODO';
