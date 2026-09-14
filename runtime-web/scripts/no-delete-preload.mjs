import crypto from 'node:crypto';
import fs, { syncBuiltinESMExports } from 'node:fs';
import path from 'node:path';

const original = Object.freeze({
  existsSync: fs.existsSync.bind(fs),
  lstatSync: fs.lstatSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
});
const root = path.resolve(
  process.env.CODING_TOOLS_RETENTION_ROOT
    || path.join(process.cwd(), 'aiTemp', 'Trash', 'no-delete-preload', String(process.pid)),
);
let sequence = 0;

function retainedDestination(target) {
  const absolute = path.resolve(String(target));
  const hash = crypto.createHash('sha256').update(absolute).digest('hex').slice(0, 16);
  const name = path.basename(absolute) || 'root';
  sequence += 1;
  return path.join(root, `${String(sequence).padStart(6, '0')}-${hash}-${name}`);
}

function retainSync(target) {
  const absolute = path.resolve(String(target));
  if (!original.existsSync(absolute)) return;
  if (absolute === root || absolute.startsWith(`${root}${path.sep}`)) return;
  const metadata = original.lstatSync(absolute);
  if (metadata.isSymbolicLink()) {
    throw new Error(`NO_DELETE_SYMLINK_REJECTED:${absolute}`);
  }
  original.mkdirSync(root, { recursive: true });
  const destination = retainedDestination(absolute);
  original.renameSync(absolute, destination);
}

function callbackRetention(target, callback) {
  try {
    retainSync(target);
    queueMicrotask(() => callback(null));
  } catch (error) {
    queueMicrotask(() => callback(error));
  }
}

fs.rmSync = target => retainSync(target);
fs.rmdirSync = target => retainSync(target);
fs.unlinkSync = target => retainSync(target);
fs.rm = (target, _options, callback) => {
  if (typeof _options === 'function') return callbackRetention(target, _options);
  return callbackRetention(target, callback);
};
fs.rmdir = (target, _options, callback) => {
  if (typeof _options === 'function') return callbackRetention(target, _options);
  return callbackRetention(target, callback);
};
fs.unlink = (target, callback) => callbackRetention(target, callback);

for (const name of ['rm', 'rmdir', 'unlink']) {
  try {
    fs.promises[name] = async target => retainSync(target);
  } catch {
    // Older runtimes may expose a read-only promises facade. Synchronous and
    // callback APIs remain guarded, and the suite records any uncovered path.
  }
}

syncBuiltinESMExports();
