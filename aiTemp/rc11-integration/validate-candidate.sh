#!/usr/bin/env bash
set -uo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

evidence="$repo_root/aiTemp/rc11-integration/candidate-evidence"
trash="$repo_root/aiTemp/Trash/rc11-integration"
renderer_out="$repo_root/aiTemp/rc11-integration/renderer-build"
mkdir -p "$evidence" "$trash" "$renderer_out"

source_head="${SOURCE_HEAD:?SOURCE_HEAD is required}"
source_branch="${SOURCE_BRANCH:?SOURCE_BRANCH is required}"
base_head="$(git rev-parse HEAD)"
printf '%s\n' "$base_head" > "$evidence/base-head.txt"
printf '%s\n' "$source_head" > "$evidence/source-head.txt"

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git fetch --no-tags origin "$source_branch"
actual_source="$(git rev-parse FETCH_HEAD)"
if [[ "$actual_source" != "$source_head" ]]; then
  printf 'SOURCE_HEAD_MISMATCH expected=%s actual=%s\n' "$source_head" "$actual_source" | tee "$evidence/result.txt"
  exit 1
fi

set +e
git merge --no-commit --no-ff "$source_head" > "$evidence/merge-output.txt" 2>&1
merge_status=$?
set -e
printf '%s\n' "$merge_status" > "$evidence/merge-exit-code.txt"

git diff --name-only --diff-filter=U | sort > "$evidence/actual-conflicts.txt"
cat > "$evidence/expected-conflicts.txt" <<'EOF'
.github/workflows/rc8-external-services-control-plane.yml
desktop-electron/electron/codex-router-managed.cjs
desktop-electron/electron/codex-router-original-ui.cjs
desktop-electron/electron/cpa-codex-long-run.cjs
desktop-electron/electron/managed-components.cjs
desktop-electron/electron/managed-external-services.cjs
desktop-electron/electron/original-ui.cjs
desktop-electron/electron/product.cjs
desktop-electron/package.json
desktop-electron/scripts/prepare-package-resources.cjs
desktop-electron/scripts/verify-package.cjs
desktop-electron/src/features/ExternalServicesSurface.tsx
desktop-electron/src/types.ts
desktop-electron/tests/cpa-codex-long-run.test.cjs
desktop-electron/tests/installer-upgrade-migration.test.cjs
desktop-electron/tests/package-contents.test.cjs
desktop-electron/tests/package-resource-preparation.test.cjs
desktop-electron/tests/product-identity.test.cjs
desktop-electron/tests/rc9-managed-cpa-runtime.test.cjs
desktop-electron/tests/rc9-package-identity-alignment.test.cjs
desktop-electron/vendor/managed-components/codex-router.json
desktop-electron/vendor/managed-components/cpa.json
docs/releases/v0.7.0-cpa-router-longrun.md
EOF
sort -o "$evidence/expected-conflicts.txt" "$evidence/expected-conflicts.txt"
if ! diff -u "$evidence/expected-conflicts.txt" "$evidence/actual-conflicts.txt" > "$evidence/conflict-diff.txt"; then
  cat "$evidence/conflict-diff.txt"
  printf 'UNEXPECTED_CONFLICT_SET\n' > "$evidence/result.txt"
  exit 1
fi

ours_paths=(
  desktop-electron/electron/codex-router-managed.cjs
  desktop-electron/electron/codex-router-original-ui.cjs
  desktop-electron/electron/cpa-codex-long-run.cjs
  desktop-electron/electron/managed-components.cjs
  desktop-electron/electron/managed-external-services.cjs
  desktop-electron/electron/original-ui.cjs
  desktop-electron/package.json
  desktop-electron/scripts/prepare-package-resources.cjs
  desktop-electron/scripts/verify-package.cjs
  desktop-electron/tests/cpa-codex-long-run.test.cjs
  desktop-electron/tests/rc9-managed-cpa-runtime.test.cjs
  desktop-electron/vendor/managed-components/codex-router.json
  desktop-electron/vendor/managed-components/cpa.json
  docs/releases/v0.7.0-cpa-router-longrun.md
)

theirs_paths=(
  desktop-electron/electron/product.cjs
  desktop-electron/src/features/ExternalServicesSurface.tsx
  desktop-electron/src/types.ts
  desktop-electron/tests/installer-upgrade-migration.test.cjs
  desktop-electron/tests/package-contents.test.cjs
  desktop-electron/tests/package-resource-preparation.test.cjs
  desktop-electron/tests/product-identity.test.cjs
  desktop-electron/tests/rc9-package-identity-alignment.test.cjs
)

git checkout --ours -- "${ours_paths[@]}"
git checkout --theirs -- "${theirs_paths[@]}"
git add -- "${ours_paths[@]}" "${theirs_paths[@]}"

# Keep this integration branch's workflow inventory. New application behavior is
# validated by this dedicated candidate workflow before any merge commit exists.
git checkout HEAD -- .github/workflows
git add -- .github/workflows

# Merge the package contracts instead of choosing one side: rc.11 identity and
# the shared five-stack builder are combined with the CPA/Router bundled runtime.
node <<'NODE'
const fs = require('node:fs');
const file = 'desktop-electron/package.json';
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.version = '0.7.0-rc.11';
value.scripts['build:bundled-runtimes'] = 'node scripts/prepare-bundled-runtimes.cjs';
value.scripts['build:five-stack-runtime'] = 'node scripts/prepare-five-stack-runtime.cjs';
value.scripts['build:package-resources'] = 'node scripts/prepare-bundled-runtimes.cjs && node scripts/prepare-five-stack-runtime.cjs && node scripts/prepare-package-resources.cjs';
for (const key of ['package', 'package:mac', 'package:win', 'package:linux']) {
  const suffix = key === 'package' ? '' : ` --${key.split(':')[1]}`;
  value.scripts[key] = `bun run build && bun run build:runtime && bun run build:package-resources && bun run scripts/package.cjs${suffix}`;
}
const unpack = new Set(value.build.asarUnpack || []);
for (const entry of [
  'electron/bundled-runtimes.cjs',
  'vendor/bundled-runtimes/**',
]) unpack.add(entry);
value.build.asarUnpack = [...unpack];
const files = new Set(value.build.files || []);
files.add('vendor/bundled-runtimes/**');
value.build.files = [...files];
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE

# The #194 package composers own CPA/Router payload generation; align their
# active product identity while the #192 five-stack builder runs immediately
# before them through the merged package scripts above.
python3 - <<'PY'
from pathlib import Path
for name in (
    'desktop-electron/scripts/prepare-package-resources.cjs',
    'desktop-electron/scripts/verify-package.cjs',
):
    path = Path(name)
    text = path.read_text(encoding='utf-8')
    text = text.replace('0.7.0-rc.10', '0.7.0-rc.11')
    path.write_text(text, encoding='utf-8')
PY

git add desktop-electron/package.json \
  desktop-electron/scripts/prepare-package-resources.cjs \
  desktop-electron/scripts/verify-package.cjs

# The project has a strict no-deletion contract. Restore every tracked path that
# the source side proposed deleting, without removing any source branch/history.
mapfile -t deleted_paths < <(git diff --cached --diff-filter=D --name-only)
for deleted in "${deleted_paths[@]}"; do
  if git cat-file -e "HEAD:$deleted" 2>/dev/null; then
    git checkout HEAD -- "$deleted"
    git add -- "$deleted"
  fi
done

git diff --name-only --diff-filter=U | sort > "$evidence/unresolved-conflicts.txt"
if [[ -s "$evidence/unresolved-conflicts.txt" ]]; then
  cat "$evidence/unresolved-conflicts.txt"
  printf 'UNRESOLVED_CONFLICTS\n' > "$evidence/result.txt"
  exit 1
fi

git diff --cached --name-only | sort > "$evidence/candidate-paths.txt"
git diff --cached --stat > "$evidence/candidate-stat.txt"
git diff --cached --diff-filter=D --name-only > "$evidence/deleted-paths.txt"
if [[ -s "$evidence/deleted-paths.txt" ]]; then
  printf 'TRACKED_DELETION_FORBIDDEN\n' > "$evidence/result.txt"
  cat "$evidence/deleted-paths.txt"
  exit 1
fi

git diff --cached --check > "$evidence/diff-check.txt" 2>&1

failures=0
run_check() {
  local name="$1"
  shift
  set +e
  "$@" > "$evidence/${name}.log" 2>&1
  local status=$?
  set -e
  printf '%s=%s\n' "$name" "$status" | tee -a "$evidence/check-status.txt"
  if [[ $status -ne 0 ]]; then
    failures=$((failures + 1))
    printf '\n--- %s failure ---\n' "$name"
    tail -n 160 "$evidence/${name}.log"
  fi
}

run_check syntax bash -lc '
  node --check desktop-electron/electron/codex-router-managed.cjs &&
  node --check desktop-electron/electron/codex-router-original-ui.cjs &&
  node --check desktop-electron/electron/cpa-codex-long-run.cjs &&
  node --check desktop-electron/electron/five-stack-control-plane.cjs &&
  node --check desktop-electron/electron/five-stack-cross-use.cjs &&
  node --check desktop-electron/electron/managed-components.cjs &&
  node --check desktop-electron/electron/managed-external-services.cjs &&
  node --check desktop-electron/electron/original-ui.cjs &&
  node --check desktop-electron/electron/preload.cjs &&
  node --check desktop-electron/scripts/prepare-five-stack-runtime.cjs &&
  node --check desktop-electron/scripts/prepare-bundled-runtimes.cjs &&
  node --check desktop-electron/scripts/prepare-package-resources.cjs &&
  node --check desktop-electron/scripts/verify-package.cjs
'
run_check install bun install --cwd desktop-electron --frozen-lockfile
run_check contracts node --test \
  desktop-electron/tests/bundled-five-stack-runtime.test.cjs \
  desktop-electron/tests/cpa-codex-long-run.test.cjs \
  desktop-electron/tests/external-services-control-plane.test.cjs \
  desktop-electron/tests/five-stack-control-plane.test.cjs \
  desktop-electron/tests/five-stack-cross-use.test.cjs \
  desktop-electron/tests/five-stack-routing-completion.test.cjs \
  desktop-electron/tests/managed-bootstrap.test.cjs \
  desktop-electron/tests/managed-components-runtime.test.cjs \
  desktop-electron/tests/original-upstream-panels.test.cjs \
  desktop-electron/tests/package-contents.test.cjs \
  desktop-electron/tests/package-resource-preparation.test.cjs \
  desktop-electron/tests/product-identity.test.cjs \
  desktop-electron/tests/rc10-cpa-codex-original-ui.test.cjs \
  desktop-electron/tests/rc11-release-identity.test.cjs \
  desktop-electron/tests/rc9-managed-cpa-runtime.test.cjs \
  desktop-electron/tests/rc9-managed-five-stack.test.cjs \
  desktop-electron/tests/upstream-tool-runtime.test.cjs \
  desktop-electron/tests/upstream-tools.test.cjs
run_check typecheck bun run --cwd desktop-electron typecheck
run_check renderer bash -lc "cd desktop-electron && bunx vite build --outDir '$renderer_out' --emptyOutDir"

if [[ -d desktop-electron/node_modules ]]; then
  mv desktop-electron/node_modules "$trash/node_modules-${GITHUB_RUN_ID:-local}"
fi

printf 'failure_count=%s\n' "$failures" | tee "$evidence/result.txt"
exit "$failures"
