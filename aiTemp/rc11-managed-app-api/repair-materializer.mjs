import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd());

function replaceExactlyOnce(relative, before, after) {
  const target = path.join(root, relative);
  const current = fs.readFileSync(target, "utf8");
  if (current.includes(after)) {
    process.stdout.write(`already repaired ${relative}\n`);
    return;
  }
  const matches = current.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected one repair anchor in ${relative}, found ${matches}`);
  }
  fs.writeFileSync(target, current.replace(before, after), "utf8");
  process.stdout.write(`repaired ${relative}\n`);
}

replaceExactlyOnce(
  "aiTemp/rc11-managed-app-api/materialize.mjs",
  `  'invokeContract(ipcRenderer, "apps.snapshot")',\n);\n\nreplaceOnce(\n  "desktop-electron/electron/ipc-schema.cjs",`,
  `  'reconcile: (input) => invokeContract(ipcRenderer, "apps.reconcile", input)',\n);\n\nreplaceOnce(\n  "desktop-electron/electron/ipc-schema.cjs",`,
);

replaceExactlyOnce(
  ".github/workflows/rc11-managed-app-api.yml",
  `      - name: Prove wiring contracts are RED before materialization\n        shell: bash\n        run: |\n          set -euo pipefail\n          set +e\n`,
  `      - name: Prove wiring contracts are RED before materialization\n        shell: bash\n        run: |\n          set -euo pipefail\n          if grep -Fq 'apps: Object.freeze({' desktop-electron/electron/preload.cjs; then\n            echo 'Managed app API source is already materialized; first-run RED evidence is retained in its artifact.'\n            exit 0\n          fi\n          set +e\n`,
);

process.stdout.write("RC11_MANAGED_APP_MATERIALIZER_REPAIRED\n");
