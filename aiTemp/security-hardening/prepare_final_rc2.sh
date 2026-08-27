#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_SOURCE_BRANCH:?missing RELEASE_SOURCE_BRANCH}"
: "${GITHUB_OUTPUT:?missing GITHUB_OUTPUT}"

base_sha="$(git rev-parse HEAD)"
git fetch --no-tags origin \
  "refs/heads/$RELEASE_SOURCE_BRANCH:refs/remotes/origin/$RELEASE_SOURCE_BRANCH"
source_sha="$(git rev-parse "origin/$RELEASE_SOURCE_BRANCH")"
source_tree="$(git rev-parse "origin/$RELEASE_SOURCE_BRANCH^{tree}")"
git merge-base --is-ancestor "$source_sha" "$base_sha"
if git diff --name-status "$source_sha..$base_sha" | grep -q '^D'; then
  echo "The hardening branch history deletes a file relative to RC1."
  git diff --name-status "$source_sha..$base_sha"
  exit 1
fi

python aiTemp/security-hardening/apply_post_rc1_hardening.py
python aiTemp/security-hardening/apply_oauth_connection_compatibility.py
python aiTemp/security-hardening/fix_dynamic_client_byte_literals.py
python aiTemp/security-hardening/apply_trash_boundary_completion.py
python aiTemp/security-hardening/apply_request_capacity_tests.py
python aiTemp/security-hardening/apply_clippy_hygiene.py
python aiTemp/security-hardening/set_rc2_version.py
cargo fmt --manifest-path src-tauri/Cargo.toml --all
git diff --check
if git diff --name-status | grep -q '^D'; then
  echo "Refusing hardening because a working-tree path was deleted."
  git diff --name-status
  exit 1
fi

if grep -R --line-number --fixed-strings 'CorsLayer::permissive()' \
  src-tauri/src/mcp/listener.rs src-tauri/src/actions/listener.rs; then
  echo "Permissive browser-wide CORS remains enabled."
  exit 1
fi

python - <<'PY'
import json
import re
from pathlib import Path

for name in ("src-tauri/src/tools/patch.rs", "src-tauri/src/tools/file.rs"):
    production = Path(name).read_text(encoding="utf-8").partition("#[cfg(test)]")[0]
    if re.search(r"(?:std::)?fs::remove_(?:file|dir|dir_all)\(", production):
        raise SystemExit(f"irreversible deletion remains in {name}")

version = "0.3.0-rc2"
package = json.loads(Path("package.json").read_text(encoding="utf-8"))
lock = json.loads(Path("package-lock.json").read_text(encoding="utf-8"))
tauri = json.loads(Path("src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
observed = {
    "package": package.get("version"),
    "lock": lock.get("version"),
    "lock root": lock.get("packages", {}).get("", {}).get("version"),
    "tauri": tauri.get("version"),
}
bad = {name: value for name, value in observed.items() if value != version}
expected = f'name = "coding-tools-mcp-desktop"\nversion = "{version}"'
for cargo_path in ("src-tauri/Cargo.toml", "src-tauri/Cargo.lock"):
    if expected not in Path(cargo_path).read_text(encoding="utf-8"):
        bad[cargo_path] = "mismatch"
app_version = Path("src/lib/app-version.ts")
if app_version.exists() and version not in app_version.read_text(encoding="utf-8"):
    bad[str(app_version)] = "mismatch"
if bad:
    raise SystemExit(f"RC2 version mismatch: {bad}")
print("verified RC2 version and non-destructive source boundaries")
PY

grep -q 'return valid_dynamic_client_id(client_id);' src-tauri/src/auth/oauth_flow.rs
grep -q "!matches!(byte, b'&' | b'=' | b'<' | b'>' | 0x22 | 0x27)" src-tauri/src/auth/oauth_flow.rs
grep -q 'OAUTH_MAX_PENDING_CODES' src-tauri/src/auth/oauth_flow.rs
grep -q 'redirect_uri_allowed(&params.redirect_uri)' src-tauri/src/auth/oauth_flow.rs
grep -q 'redirect_uri_allowed(&form.redirect_uri)' src-tauri/src/auth/oauth_flow.rs
grep -q 'DefaultBodyLimit::max' src-tauri/src/mcp/listener.rs
grep -q 'DefaultBodyLimit::max' src-tauri/src/actions/listener.rs
grep -q 'spawn_blocking' src-tauri/src/actions/listener.rs
grep -q 'trash_root.starts_with(&canonical)' src-tauri/src/tools/trash.rs
grep -q 'refusing to move Git internals into recovery Trash' src-tauri/src/tools/trash.rs
grep -q 'ensure_no_symlink_components' src-tauri/src/tools/trash.rs
if grep -q 'stable_oauth_client_id(' src-tauri/src/runtime/supervisor.rs; then
  echo "Hidden runtime-only OAuth client-ID substitution remains."
  exit 1
fi

(
  cd src-tauri
  cargo test --locked security_hardening_tests -- --nocapture
  cargo test --locked request_capacity_hardening_tests -- --nocapture
  cargo test --locked tools::trash -- --nocapture
  cargo test --locked auth::refresh_tokens -- --nocapture
  cargo test --locked auth::oauth_flow::tests -- --nocapture
  cargo test --locked --test call_tool_security apply_patch_allows_deleting_a_normal_file -- --nocapture
  cargo test --locked --test call_tool_security deleting_readme_requires_explicit_confirmation -- --nocapture
  cargo test --locked --test call_tool_security deleting_git_assets_is_always_rejected -- --nocapture
  cargo test --locked elevation_requests_are_always_blocked -- --nocapture
  cargo fmt --all -- --check
  cargo test --locked
  cargo clippy --locked --all-targets -- -D warnings
)

mkdir -p aiTemp/npm-cache
npm ci --cache aiTemp/npm-cache
npm run check
npm run build
node --test tests/*.test.mjs

verified_dir="aiTemp/security-hardening/final-verified"
mkdir -p "$verified_dir"
git add -- \
  package.json \
  package-lock.json \
  src-tauri/Cargo.toml \
  src-tauri/Cargo.lock \
  src-tauri/tauri.conf.json \
  src-tauri/src \
  src-tauri/tests \
  src

if git diff --cached --quiet; then
  echo "The final hardening patch is unexpectedly empty."
  exit 1
fi

git diff --cached --check
git diff --cached --name-status > "$verified_dir/changed-files.txt"
if grep -q '^D' "$verified_dir/changed-files.txt"; then
  echo "Refusing to package a deleted file."
  exit 1
fi
allowed='^(package.json|package-lock.json|src-tauri/Cargo.toml|src-tauri/Cargo.lock|src-tauri/tauri.conf.json|src-tauri/src/|src-tauri/tests/|src/)'
unexpected="$(git diff --cached --name-only | grep -Ev "$allowed" || true)"
if [ -n "$unexpected" ]; then
  echo "Unexpected staged paths:"
  printf '%s\n' "$unexpected"
  exit 1
fi

git diff --cached --binary > "$verified_dir/hardened-rc2.patch"
rc2_tree="$(git write-tree)"
patch_sha256="$(sha256sum "$verified_dir/hardened-rc2.patch" | cut -d' ' -f1)"
printf '%s  hardened-rc2.patch\n' "$patch_sha256" > "$verified_dir/SHA256SUMS.txt"
printf 'base_sha=%s\nsource_sha=%s\nsource_tree=%s\nrc2_tree=%s\npatch_sha256=%s\n' \
  "$base_sha" "$source_sha" "$source_tree" "$rc2_tree" "$patch_sha256" \
  > "$verified_dir/metadata.env"

printf 'base_sha=%s\n' "$base_sha" >> "$GITHUB_OUTPUT"
printf 'source_sha=%s\n' "$source_sha" >> "$GITHUB_OUTPUT"
printf 'source_tree=%s\n' "$source_tree" >> "$GITHUB_OUTPUT"
printf 'rc2_tree=%s\n' "$rc2_tree" >> "$GITHUB_OUTPUT"
printf 'patch_sha256=%s\n' "$patch_sha256" >> "$GITHUB_OUTPUT"

echo "Linux exact-patch preparation and full validation completed successfully"
