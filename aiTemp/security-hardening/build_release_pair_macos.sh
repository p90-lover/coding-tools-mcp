#!/usr/bin/env bash
set -euo pipefail

: "${BASE_SHA:?missing BASE_SHA}"
: "${SOURCE_SHA:?missing SOURCE_SHA}"
: "${RC2_TREE:?missing RC2_TREE}"
: "${PATCH_SHA256:?missing PATCH_SHA256}"
: "${GITHUB_WORKSPACE:?missing GITHUB_WORKSPACE}"

workspace="$GITHUB_WORKSPACE"
patch_path="$workspace/aiTemp/security-hardening/final-verified/hardened-rc2.patch"
test -f "$patch_path"
actual_patch="$(shasum -a 256 "$patch_path" | cut -d' ' -f1)"
test "$actual_patch" = "$PATCH_SHA256"
test "$(git rev-parse HEAD)" = "$BASE_SHA"

write_manifest() {
  local directory="$1"
  local extension="$2"
  local manifest="$3"
  shopt -s nullglob
  local files=("$directory"/*."$extension")
  if [ "${#files[@]}" -lt 1 ]; then
    echo "No .$extension files were produced in $directory"
    exit 1
  fi
  for file in "${files[@]}"; do
    shasum -a 256 "$file"
  done | sed 's#  .*/#  #' > "$directory/$manifest"
}

rc1_worktree="$workspace/aiTemp/rc1-source-macos"
git worktree add --detach "$rc1_worktree" "$SOURCE_SHA"

original_target="${CARGO_TARGET_DIR-}"
export CARGO_TARGET_DIR="$workspace/aiTemp/cargo-target-final-macos/rc1"
(
  cd "$rc1_worktree"
  mkdir -p aiTemp/npm-cache
  npm ci --cache aiTemp/npm-cache
  npm run check
  node --test tests/*.test.mjs
  (
    cd src-tauri
    cargo fmt --all -- --check
    cargo test --locked
    cargo clippy --locked --all-targets -- -D warnings
  )
  npm run tauri -- build --target universal-apple-darwin --bundles dmg
)

rc1_output="$CARGO_TARGET_DIR/universal-apple-darwin/release/bundle/dmg"
rc1_assets="$workspace/aiTemp/release-assets/rc1/macos"
mkdir -p "$rc1_assets"
shopt -s nullglob
rc1_files=("$rc1_output"/*.dmg)
if [ "${#rc1_files[@]}" -lt 1 ]; then
  echo "RC1 universal macOS DMG was not produced in the pinned target directory"
  exit 1
fi
cp "${rc1_files[@]}" "$rc1_assets/"
write_manifest "$rc1_assets" dmg SHA256SUMS-macos.txt

cd "$workspace"
git apply --index --binary "$patch_path"
test "$(git write-tree)" = "$RC2_TREE"
if git diff --cached --name-status | grep -q '^D'; then
  echo "RC2 patch deletes a file"
  exit 1
fi

export CARGO_TARGET_DIR="$workspace/aiTemp/cargo-target-final-macos/rc2"
mkdir -p aiTemp/npm-cache
npm ci --cache aiTemp/npm-cache
npm run check
node --test tests/*.test.mjs
(
  cd src-tauri
  cargo fmt --all -- --check
  cargo test --locked
  cargo clippy --locked --all-targets -- -D warnings
)
npm run tauri -- build --target universal-apple-darwin --bundles dmg

rc2_output="$CARGO_TARGET_DIR/universal-apple-darwin/release/bundle/dmg"
rc2_assets="$workspace/aiTemp/release-assets/rc2/macos"
mkdir -p "$rc2_assets"
rc2_files=("$rc2_output"/*.dmg)
if [ "${#rc2_files[@]}" -lt 1 ]; then
  echo "RC2 universal macOS DMG was not produced in the pinned target directory"
  exit 1
fi
cp "${rc2_files[@]}" "$rc2_assets/"
write_manifest "$rc2_assets" dmg SHA256SUMS-macos.txt

if [ -n "$original_target" ]; then
  export CARGO_TARGET_DIR="$original_target"
else
  unset CARGO_TARGET_DIR
fi

echo "macOS RC1 and exact-tree RC2 validation/build completed successfully"
