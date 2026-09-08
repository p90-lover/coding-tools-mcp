import { COLUMNS, parseStatus, countByStatus } from './vendor/anneal-board.js';
export const columns = COLUMNS;
export const columnFor = parseStatus;
export const countTasks = countByStatus;
/** External observation never implies permission to start/resume an agent. @param {string} _provider */
export const canMutateExternal = _provider => false;
/** @param {{status:string,review_note?:string,verification_note?:string}} task */
export function completionProblem(task) {
  return task.status === 'DONE' && (!task.review_note?.trim() || !task.verification_note?.trim())
    ? 'Add review and verification notes before marking this task Done.' : '';
}
/** @template {{workspace_id?:string,title:string,archived?:boolean}} T @param {T[]} tasks @param {string} workspace @param {string} query @param {boolean} archived */
export function filterTasks(tasks,workspace='',query='',archived=false) {
  const needle=query.trim().toLocaleLowerCase();
  return tasks.filter(task => Boolean(task.archived)===archived && (!workspace || task.workspace_id===workspace) && (!needle || task.title.toLocaleLowerCase().includes(needle)));
}
/** @param {number|string|null|undefined} stamp */
export function formatTime(stamp) {
  if (!stamp) return 'Not yet refreshed';
  const date=new Date(stamp);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleTimeString([], { hour:'2-digit',minute:'2-digit' });
}
