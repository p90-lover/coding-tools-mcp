import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const modules = new Map();
function load(path) {
  path = resolve(path);
  if (modules.has(path)) return modules.get(path);
  const exports = {};
  const context = {
    exports,
    require: (specifier) => {
      if (specifier.startsWith('.')) return load(resolve(dirname(path), specifier.endsWith('.ts') ? specifier : specifier + '.ts'));
      return require(specifier);
    },
    URL,
    URLSearchParams,
    Set,
    Error,
    JSON,
    Object,
  };
  const out = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  vm.runInNewContext(out.outputText, context, { filename: path });
  modules.set(path, exports);
  return exports;
}

const provider = load(resolve('src/lib/control-center/commandcode-proxy-provider.ts'));
const plan = provider.commandCodeProxyRegistrationPlan({
  baseUrl: 'http://127.0.0.1:3050/v1/',
  routerCli: './bin/model-router',
  curateCli: './bin/curate-models',
});
assert.equal(JSON.stringify(plan.provider), JSON.stringify({
  id: 'commandcode-proxy',
  name: 'CommandCode Proxy',
  baseUrl: 'http://127.0.0.1:3050/v1',
  adapter: 'openai-chat',
  modelEndpoint: '/models',
}));
assert.equal(JSON.stringify(plan.commands), JSON.stringify([
  [
    './bin/model-router', 'codex', 'providers', 'generic', 'add', 'commandcode-proxy',
    '--name', 'CommandCode Proxy',
    '--base-url', 'http://127.0.0.1:3050/v1',
    '--adapter', 'openai-chat',
    '--allow-private',
  ],
  ['./bin/model-router', 'codex', 'providers', 'generic', 'credential', 'commandcode-proxy', 'set'],
  ['./bin/model-router', 'codex', 'providers', 'generic', 'enable', 'commandcode-proxy'],
  ['./bin/curate-models', 'commandcode-proxy'],
]));
assert.equal(plan.credentialPromptRequired, true);

const remote = provider.commandCodeProxyRegistrationPlan({
  baseUrl: 'https://cc-proxy.example/v1',
  routerCli: 'model-router',
  curateCli: 'curate-models',
});
assert.equal(remote.commands[0].includes('--allow-private'), false);

const secret = 'user_SUPER_SECRET_MUST_NOT_APPEAR';
const localPlan = provider.commandCodeProxyRegistrationPlan({
  baseUrl: 'http://localhost:3050/v1',
  routerCli: 'model-router',
  curateCli: 'curate-models',
});
const output = provider.renderCommandCodeProxyPlan(localPlan);
assert.equal(output.includes('providers generic credential commandcode-proxy set'), true);
assert.equal(output.includes('hidden credential prompt'), true);
assert.equal(output.includes(secret), false);
assert.equal(JSON.stringify(localPlan).includes('user_'), false);

const page = fs.readFileSync('src/routes/integrations/+page.svelte', 'utf8');
assert.equal(page.includes('CommandCodeProxyPanel'), true);
assert.equal(page.includes('PaseoPanel'), true);
assert.equal(page.includes('AnnealPanel'), true);
assert.equal(
  /ssh -N -L 3000:127\.0\.0\.1:3000/.test(
    fs.readFileSync('src/lib/components/control-center/AnnealPanel.svelte', 'utf8'),
  ),
  true,
);

const upstreams = JSON.parse(fs.readFileSync('src/lib/control-center/upstreams.json', 'utf8'));
assert.equal(upstreams.paseo.mode, 'live_allowlist');
assert.equal(upstreams.anneal.mode, 'live_allowlist');
assert.equal(upstreams.commandcode.mode, 'live_allowlist');
assert.equal(upstreams.agentLaunchEnabled, false);

const rust = fs.readFileSync('src-tauri/src/integrations/commandcode.rs', 'utf8');
assert.equal(/\.post\(|\.put\(|\.delete\(/.test(rust), false);
assert.equal(rust.includes('credential'), true);
assert.equal(rust.includes('non_secret_commands'), true);
assert.equal(fs.existsSync('runtime-web/scripts/commandcode-proxy-provider.ts'), true);

const cli = fs.readFileSync('runtime-web/scripts/commandcode-proxy-provider.ts', 'utf8');
assert.equal(cli.includes('commandCodeProxyRegistrationPlan'), true);
assert.equal(cli.includes('--apply'), true);

console.log('PASS: CommandCode Proxy registration plan, secret isolation, Integrations panel, live-allowlist Paseo/Anneal');
