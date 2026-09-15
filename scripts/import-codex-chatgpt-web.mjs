import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeManifest } from './lib/upstream-manifest.mjs';

const PIN = Object.freeze({
  repository: 'miuuyy/codex-chatgpt-web',
  tag: 'v5.0.6',
  commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612',
  tunnelClientVersion: '0.0.12',
});

function argumentsMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`INVALID_ARGUMENT:${key ?? ''}`);
    result.set(key.slice(2), value);
  }
  return result;
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function retainExisting(target, label, timestamp) {
  if (!(await exists(target))) return null;
  const retained = path.join('Trash', 'vendor-import', timestamp, label);
  await fs.mkdir(path.dirname(retained), { recursive: true });
  await fs.rename(target, retained);
  return retained;
}

async function copyVerifiedSource(source, destination) {
  await fs.cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: sourcePath => path.basename(sourcePath) !== '.git',
  });
}

async function main() {
  const args = argumentsMap(process.argv.slice(2));
  const source = path.resolve(args.get('source') ?? 'aiTemp/vendor-import/source');
  const destination = path.resolve(args.get('destination') ?? 'vendor/codex-chatgpt-web-v5.0.6');
  const currentCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (currentCommit !== PIN.commit) throw new Error(`UPSTREAM_COMMIT_MISMATCH:${currentCommit}`);

  const timestamp = safeTimestamp();
  const licenseTarget = path.resolve('third_party/LICENSES/codex-chatgpt-web-MIT.txt');
  const noticeTarget = path.resolve('third_party/THIRD_PARTY_NOTICES.md');
  const retained = [];
  for (const [target, label] of [
    [destination, 'codex-chatgpt-web-v5.0.6'],
    [licenseTarget, 'codex-chatgpt-web-MIT.txt'],
    [noticeTarget, 'THIRD_PARTY_NOTICES.md'],
  ]) {
    const moved = await retainExisting(target, label, timestamp);
    if (moved) retained.push(moved);
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await copyVerifiedSource(source, destination);
  await writeManifest(destination, path.join(destination, 'UPSTREAM_MANIFEST.json'), PIN);

  await fs.mkdir(path.dirname(licenseTarget), { recursive: true });
  const license = await fs.readFile(path.join(destination, 'LICENSE'), 'utf8');
  await fs.writeFile(licenseTarget, license, 'utf8');
  await fs.writeFile(
    noticeTarget,
    `# Third-party notices\n\n## codex-chatgpt-web\n\n- Repository: ${PIN.repository}\n- Tag: ${PIN.tag}\n- Commit: ${PIN.commit}\n- License: MIT\n- License file: \`third_party/LICENSES/codex-chatgpt-web-MIT.txt\`\n- Vendored source: \`vendor/codex-chatgpt-web-v5.0.6/\`\n- Pinned tunnel-client: ${PIN.tunnelClientVersion}\n\nThe upstream and transitive license files remain in the vendored source tree.\n`,
    'utf8',
  );
  console.log(JSON.stringify({ imported: destination, retained, pin: PIN }, null, 2));
}

await main();
