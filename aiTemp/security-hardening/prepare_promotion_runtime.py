from __future__ import annotations

from pathlib import Path

ROOT = Path.cwd().resolve()
SOURCE = ROOT / "aiTemp" / "security-hardening" / "promote_release_pair.sh"
RUNTIME = ROOT / "aiTemp" / "runtime" / "security-hardening" / "promote_release_pair.sh"


def checked_source() -> Path:
    if SOURCE.is_symlink():
        raise RuntimeError("refusing to read promotion logic through a symlink")
    resolved = SOURCE.resolve(strict=True)
    resolved.relative_to(ROOT)
    if not resolved.is_file():
        raise RuntimeError("promotion logic is not a regular file")
    return resolved


text = checked_source().read_text(encoding="utf-8")
marker = "\npublish_or_verify_release() {\n"
if marker not in text:
    raise RuntimeError("promotion release-function boundary changed")

repair_function = r'''
repair_or_verify_existing_release() {
  local tag="$1"
  local expected_tree="$2"
  local built_windows_manifest="$3"
  local built_macos_manifest="$4"
  local windows_dir="$5"
  local macos_dir="$6"

  local release tag_commit tag_tree names
  release="$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag")"
  test "$(jq -r '.prerelease' <<<"$release")" = "true"
  tag_commit="$(resolve_tag_commit "$tag")"
  tag_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$tag_commit" --jq '.commit.tree.sha')"
  test "$tag_tree" = "$expected_tree"
  names="$(jq -r '.assets[].name' <<<"$release")"

  shopt -s nullglob
  local candidates=(
    "$windows_dir"/*.exe
    "$built_windows_manifest"
    "$macos_dir"/*.dmg
    "$built_macos_manifest"
  )
  local missing=()
  local file name
  for file in "${candidates[@]}"; do
    name="$(basename "$file")"
    if ! grep -Fxq "$name" <<<"$names"; then
      missing+=("$file")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    gh release upload "$tag" --repo "$GITHUB_REPOSITORY" "${missing[@]}"
  fi

  verify_existing_release "$tag" "$expected_tree" "$built_windows_manifest" "$built_macos_manifest"
}
'''

if "repair_or_verify_existing_release()" not in text:
    text = text.replace(marker, "\n" + repair_function.strip() + "\n" + marker, 1)

before = '''  if gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" >/dev/null 2>&1; then
    verify_existing_release "$tag" "$expected_tree" "$windows_manifest" "$macos_manifest"
    return 0
  fi
'''
after = '''  if gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" >/dev/null 2>&1; then
    repair_or_verify_existing_release \
      "$tag" \
      "$expected_tree" \
      "$windows_manifest" \
      "$macos_manifest" \
      "$windows_dir" \
      "$macos_dir"
    return 0
  fi
'''
if after not in text:
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f"expected one existing-release branch, found {count}")
    text = text.replace(before, after, 1)

RUNTIME.parent.mkdir(parents=True, exist_ok=True)
if RUNTIME.is_symlink() or RUNTIME.parent.is_symlink():
    raise RuntimeError("refusing to write runtime promotion logic through a symlink")
resolved_parent = RUNTIME.parent.resolve(strict=True)
resolved_parent.relative_to(ROOT)
RUNTIME.write_text(text, encoding="utf-8")
RUNTIME.chmod(0o700)

verified = RUNTIME.read_text(encoding="utf-8")
required = (
    "repair_or_verify_existing_release()",
    'gh release upload "$tag" --repo "$GITHUB_REPOSITORY" "${missing[@]}"',
    "verify_existing_release",
)
missing = [item for item in required if item not in verified]
if missing:
    raise RuntimeError(f"runtime promotion preparation failed: {missing}")
if "--clobber" in verified:
    raise RuntimeError("runtime promotion must never overwrite a release asset")

print(RUNTIME)
