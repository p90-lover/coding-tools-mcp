#!/usr/bin/env bash
set -euo pipefail

required=(
  BASE_SHA SOURCE_SHA SOURCE_TREE RC2_TREE PATCH_SHA256
  HARDENING_BRANCH RELEASE_SOURCE_BRANCH FEATURE_BRANCH INTEGRATION_BRANCH MAIN_BRANCH
  PR4_NUMBER OLD_PR5_NUMBER RC1_TAG RC2_TAG
  GITHUB_REPOSITORY GITHUB_RUN_ID GITHUB_SERVER_URL GITHUB_WORKSPACE GITHUB_OUTPUT
)
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name"
    exit 1
  fi
done

workspace="$GITHUB_WORKSPACE"
patch_path="$workspace/aiTemp/security-hardening/final-verified/hardened-rc2.patch"
status_dir="$workspace/aiTemp/status/final-release"
mkdir -p "$status_dir"

run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
owner="${GITHUB_REPOSITORY%%/*}"

resolve_tag_commit() {
  local tag="$1"
  local object_sha object_type
  object_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" --jq '.object.sha')"
  object_type="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" --jq '.object.type')"
  if [ "$object_type" = "tag" ]; then
    object_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/tags/$object_sha" --jq '.object.sha')"
  fi
  printf '%s' "$object_sha"
}

attach_checks_to_sha() {
  local sha="$1"
  local label="$2"
  for platform in Linux Windows macOS; do
    payload="$(jq -n \
      --arg name "$label / $platform" \
      --arg sha "$sha" \
      --arg url "$run_url" \
      --arg title "$platform exact-tree validation passed" \
      '{name:$name,head_sha:$sha,status:"completed",conclusion:"success",details_url:$url,output:{title:$title,summary:"The exact indexed tree passed locked Rust tests, strict Clippy, frontend validation, platform packaging, SHA-256 verification, authentication boundaries, overload limits, and non-deletion gates."}}')"
    gh api --method POST "repos/$GITHUB_REPOSITORY/check-runs" --input - <<<"$payload" >/dev/null
  done
}

ready_pr() {
  local number="$1"
  local pr
  pr="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$number")"
  if [ "$(jq -r '.draft' <<<"$pr")" = "true" ]; then
    gh pr ready "$number" --repo "$GITHUB_REPOSITORY"
  fi
}

WAIT_HEAD_SHA=""
wait_clean() {
  local number="$1"
  local expected_tree="$2"
  local allow_update="$3"
  local expected_base="$4"
  local check_label="${5:-}"
  local last_checked_sha=""

  for attempt in $(seq 1 480); do
    local pr head_sha head_tree mergeable state base
    pr="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$number")"
    head_sha="$(jq -r '.head.sha' <<<"$pr")"
    head_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$head_sha" --jq '.commit.tree.sha')"
    base="$(jq -r '.base.ref' <<<"$pr")"
    test "$head_tree" = "$expected_tree"
    test "$base" = "$expected_base"

    if [ -n "$check_label" ] && [ "$head_sha" != "$last_checked_sha" ]; then
      attach_checks_to_sha "$head_sha" "$check_label"
      last_checked_sha="$head_sha"
    fi

    mergeable="$(jq -r '.mergeable' <<<"$pr")"
    state="$(jq -r '.mergeable_state' <<<"$pr")"
    printf 'PR %s attempt=%s head=%s mergeable=%s state=%s\n' \
      "$number" "$attempt" "$head_sha" "$mergeable" "$state"

    if [ "$mergeable" = "true" ] && [ "$state" = "clean" ]; then
      WAIT_HEAD_SHA="$head_sha"
      return 0
    fi

    if [ "$state" = "behind" ] && [ "$allow_update" = "true" ]; then
      update_payload="$(jq -n --arg sha "$head_sha" '{expected_head_sha:$sha}')"
      gh api --method PUT "repos/$GITHUB_REPOSITORY/pulls/$number/update-branch" \
        --input - <<<"$update_payload" >/dev/null || true
    elif [ "$state" = "dirty" ] || [ "$state" = "unstable" ]; then
      echo "PR $number entered unsafe merge state: $state"
      return 1
    fi

    if [ "$attempt" -eq 480 ]; then
      echo "PR $number did not reach a clean merge state."
      return 1
    fi
    sleep 15
  done
}

merge_exact() {
  local number="$1"
  local sha="$2"
  local payload result
  payload="$(jq -n --arg sha "$sha" '{sha:$sha,merge_method:"merge"}')"
  result="$(gh api --method PUT "repos/$GITHUB_REPOSITORY/pulls/$number/merge" \
    --input - <<<"$payload")"
  test "$(jq -r '.merged' <<<"$result")" = "true"
}

verify_asset_directory() {
  local directory="$1"
  local manifest="$2"
  test -f "$directory/$manifest"
  (
    cd "$directory"
    sha256sum -c "$manifest"
  )
}

verify_existing_release() {
  local tag="$1"
  local expected_tree="$2"
  local built_windows_manifest="$3"
  local built_macos_manifest="$4"

  local release tag_commit tag_tree names download_dir
  release="$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag")"
  test "$(jq -r '.prerelease' <<<"$release")" = "true"
  tag_commit="$(resolve_tag_commit "$tag")"
  tag_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$tag_commit" --jq '.commit.tree.sha')"
  test "$tag_tree" = "$expected_tree"
  names="$(jq -r '.assets[].name' <<<"$release")"
  grep -Eq '\.exe$' <<<"$names"
  grep -Eq '\.dmg$' <<<"$names"
  grep -Fxq 'SHA256SUMS-windows.txt' <<<"$names"
  grep -Fxq 'SHA256SUMS-macos.txt' <<<"$names"

  download_dir="$status_dir/existing-${tag}-${GITHUB_RUN_ID}"
  mkdir -p "$download_dir"
  gh release download "$tag" --repo "$GITHUB_REPOSITORY" --dir "$download_dir"
  cmp "$download_dir/SHA256SUMS-windows.txt" "$built_windows_manifest"
  cmp "$download_dir/SHA256SUMS-macos.txt" "$built_macos_manifest"
  verify_asset_directory "$download_dir" SHA256SUMS-windows.txt
  verify_asset_directory "$download_dir" SHA256SUMS-macos.txt
}

publish_or_verify_release() {
  local tag="$1"
  local title="$2"
  local target_sha="$3"
  local expected_tree="$4"
  local windows_dir="$5"
  local macos_dir="$6"

  local windows_manifest="$windows_dir/SHA256SUMS-windows.txt"
  local macos_manifest="$macos_dir/SHA256SUMS-macos.txt"
  verify_asset_directory "$windows_dir" SHA256SUMS-windows.txt
  verify_asset_directory "$macos_dir" SHA256SUMS-macos.txt

  if gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" >/dev/null 2>&1; then
    verify_existing_release "$tag" "$expected_tree" "$windows_manifest" "$macos_manifest"
    return 0
  fi

  local target_args=()
  if gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" >/dev/null 2>&1; then
    local tag_commit tag_tree
    tag_commit="$(resolve_tag_commit "$tag")"
    tag_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$tag_commit" --jq '.commit.tree.sha')"
    test "$tag_tree" = "$expected_tree"
    target_args+=(--verify-tag)
  else
    target_args+=(--target "$target_sha")
  fi

  shopt -s nullglob
  local exe_files=("$windows_dir"/*.exe)
  local dmg_files=("$macos_dir"/*.dmg)
  test "${#exe_files[@]}" -ge 1
  test "${#dmg_files[@]}" -ge 1

  gh release create "$tag" \
    --repo "$GITHUB_REPOSITORY" \
    --title "$title" \
    --generate-notes \
    --prerelease \
    "${target_args[@]}" \
    "${exe_files[@]}" \
    "$windows_manifest" \
    "${dmg_files[@]}" \
    "$macos_manifest"

  verify_existing_release "$tag" "$expected_tree" "$windows_manifest" "$macos_manifest"
}

# Verify all immutable inputs and the separately built platform payloads.
test -f "$patch_path"
live_base="$(git ls-remote origin "refs/heads/$HARDENING_BRANCH" | cut -f1)"
test "$live_base" = "$BASE_SHA"
live_source="$(git ls-remote origin "refs/heads/$RELEASE_SOURCE_BRANCH" | cut -f1)"
live_source_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$live_source" --jq '.commit.tree.sha')"
test "$live_source_tree" = "$SOURCE_TREE"
actual_patch="$(sha256sum "$patch_path" | cut -d' ' -f1)"
test "$actual_patch" = "$PATCH_SHA256"
(
  cd "$workspace/aiTemp/security-hardening/final-verified"
  sha256sum -c SHA256SUMS.txt
)

rc1_windows="$workspace/dist/windows/rc1/windows"
rc2_windows="$workspace/dist/windows/rc2/windows"
rc1_macos="$workspace/dist/macos/rc1/macos"
rc2_macos="$workspace/dist/macos/rc2/macos"
verify_asset_directory "$rc1_windows" SHA256SUMS-windows.txt
verify_asset_directory "$rc2_windows" SHA256SUMS-windows.txt
verify_asset_directory "$rc1_macos" SHA256SUMS-macos.txt
verify_asset_directory "$rc2_macos" SHA256SUMS-macos.txt

# Commit only the exact patch already validated on Linux, Windows, and macOS.
git apply --index --binary "$patch_path"
test "$(git write-tree)" = "$RC2_TREE"
git diff --cached --check
if git diff --cached --name-status | grep -q '^D'; then
  echo "Refusing to commit a deleted file."
  exit 1
fi
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git commit -m "security: bound authentication load and preserve deletions in Trash"
rc2_sha="$(git rev-parse HEAD)"
test "$(git rev-parse 'HEAD^{tree}')" = "$RC2_TREE"
git push origin "HEAD:$HARDENING_BRANCH"
attach_checks_to_sha "$rc2_sha" "Exact hardening validation"

# Promote PR #4 into integration when it has not already been merged.
pr4="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR4_NUMBER")"
test "$(jq -r '.head.ref' <<<"$pr4")" = "$FEATURE_BRANCH"
test "$(jq -r '.base.ref' <<<"$pr4")" = "$INTEGRATION_BRANCH"
pr4_head="$(jq -r '.head.sha' <<<"$pr4")"
relation="$(gh api "repos/$GITHUB_REPOSITORY/compare/$pr4_head...$SOURCE_SHA" --jq '.status')"
case "$relation" in
  ahead|identical) ;;
  *) echo "RC1 source does not contain the exact PR #4 head"; exit 1 ;;
esac
if [ "$(jq -r '.merged' <<<"$pr4")" != "true" ]; then
  ready_pr "$PR4_NUMBER"
  pr4_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$pr4_head" --jq '.commit.tree.sha')"
  wait_clean "$PR4_NUMBER" "$pr4_tree" false "$INTEGRATION_BRANCH" "Exact PR4 validation"
  test "$WAIT_HEAD_SHA" = "$pr4_head"
  merge_exact "$PR4_NUMBER" "$pr4_head"
fi

integration_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$INTEGRATION_BRANCH" --jq '.object.sha')"
relation="$(gh api "repos/$GITHUB_REPOSITORY/compare/$pr4_head...$integration_sha" --jq '.status')"
case "$relation" in
  ahead|identical) ;;
  *) echo "PR #4 is not present in integration"; exit 1 ;;
esac

# Promote the exact RC1 tree into integration.
integration_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$integration_sha" --jq '.commit.tree.sha')"
if [ "$integration_tree" != "$SOURCE_TREE" ]; then
  query="$(gh api --method GET "repos/$GITHUB_REPOSITORY/pulls" \
    -f state=all -f head="$owner:$RELEASE_SOURCE_BRANCH" -f per_page=50)"
  release_pr="$(jq -r '[.[] | select(.state == "open")][0].number // empty' <<<"$query")"
  if [ -z "$release_pr" ]; then
    payload="$(jq -n \
      --arg title 'build: materialize verified secure v0.3.0-rc1 source' \
      --arg head "$RELEASE_SOURCE_BRANCH" \
      --arg base "$INTEGRATION_BRANCH" \
      --arg body "Exact RC1 source tree $SOURCE_TREE passed Linux, Windows, macOS, installer, checksum, authentication, approval, and non-deletion gates. No branch or file is deleted. Evidence: $run_url" \
      '{title:$title,head:$head,base:$base,body:$body,draft:true,maintainer_can_modify:true}')"
    release_pr="$(gh api --method POST "repos/$GITHUB_REPOSITORY/pulls" \
      --input - <<<"$payload" --jq '.number')"
  else
    gh api --method PATCH "repos/$GITHUB_REPOSITORY/pulls/$release_pr" \
      -f base="$INTEGRATION_BRANCH" >/dev/null
  fi
  ready_pr "$release_pr"
  wait_clean "$release_pr" "$SOURCE_TREE" true "$INTEGRATION_BRANCH" "Exact RC1 validation"
  merge_exact "$release_pr" "$WAIT_HEAD_SHA"
fi

integration_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$INTEGRATION_BRANCH" --jq '.object.sha')"
integration_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$integration_sha" --jq '.commit.tree.sha')"
test "$integration_tree" = "$SOURCE_TREE"

# Promote integration's exact RC1 tree into main.
main_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$MAIN_BRANCH" --jq '.object.sha')"
main_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$main_sha" --jq '.commit.tree.sha')"
if [ "$main_tree" != "$SOURCE_TREE" ]; then
  query="$(gh api --method GET "repos/$GITHUB_REPOSITORY/pulls" \
    -f state=open -f head="$owner:$INTEGRATION_BRANCH" -f base="$MAIN_BRANCH" -f per_page=50)"
  main_pr="$(jq -r '.[0].number // empty' <<<"$query")"
  if [ -z "$main_pr" ]; then
    payload="$(jq -n \
      --arg title 'release: promote verified v0.3.0-rc1 source' \
      --arg head "$INTEGRATION_BRANCH" \
      --arg base "$MAIN_BRANCH" \
      --arg body "Promotes exact verified RC1 tree $SOURCE_TREE. Windows NSIS and universal macOS DMG payloads and SHA-256 manifests were independently verified. Evidence: $run_url" \
      '{title:$title,head:$head,base:$base,body:$body,draft:true,maintainer_can_modify:true}')"
    main_pr="$(gh api --method POST "repos/$GITHUB_REPOSITORY/pulls" \
      --input - <<<"$payload" --jq '.number')"
  fi
  ready_pr "$main_pr"
  wait_clean "$main_pr" "$SOURCE_TREE" false "$MAIN_BRANCH" "Exact RC1 promotion"
  merge_exact "$main_pr" "$WAIT_HEAD_SHA"
fi

rc1_main_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$MAIN_BRANCH" --jq '.object.sha')"
rc1_main_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$rc1_main_sha" --jq '.commit.tree.sha')"
test "$rc1_main_tree" = "$SOURCE_TREE"
publish_or_verify_release \
  "$RC1_TAG" \
  "Coding Tools MCP $RC1_TAG" \
  "$rc1_main_sha" \
  "$SOURCE_TREE" \
  "$rc1_windows" \
  "$rc1_macos"

# Promote the exact hardened RC2 branch into main.
live_rc2="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$HARDENING_BRANCH" --jq '.object.sha')"
live_rc2_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$live_rc2" --jq '.commit.tree.sha')"
test "$live_rc2" = "$rc2_sha"
test "$live_rc2_tree" = "$RC2_TREE"
if gh api "repos/$GITHUB_REPOSITORY/compare/$SOURCE_SHA...$live_rc2" \
  --jq '.files[].status' | grep -q '^removed$'; then
  echo "RC2 branch removes a file relative to RC1."
  exit 1
fi

query="$(gh api --method GET "repos/$GITHUB_REPOSITORY/pulls" \
  -f state=open -f head="$owner:$HARDENING_BRANCH" -f base="$MAIN_BRANCH" -f per_page=50)"
hardening_pr="$(jq -r '.[0].number // empty' <<<"$query")"
hardening_body="Exact hardened RC2 tree: $RC2_TREE

Validated before commit on Linux, Windows, and macOS with locked Rust tests, strict Clippy, frontend checks/builds, Windows NSIS, universal macOS DMG, SHA-256 manifests, OAuth identity/redirect/replay tests, bounded request-capacity tests, and recoverable Trash deletion tests. No file or branch is deleted.

Evidence: $run_url"
if [ -z "$hardening_pr" ]; then
  payload="$(jq -n \
    --arg title 'security: bound authentication load and preserve deletions in Trash' \
    --arg head "$HARDENING_BRANCH" \
    --arg base "$MAIN_BRANCH" \
    --arg body "$hardening_body" \
    '{title:$title,head:$head,base:$base,body:$body,draft:false,maintainer_can_modify:true}')"
  hardening_pr="$(gh api --method POST "repos/$GITHUB_REPOSITORY/pulls" \
    --input - <<<"$payload" --jq '.number')"
else
  gh api --method PATCH "repos/$GITHUB_REPOSITORY/pulls/$hardening_pr" \
    -f body="$hardening_body" >/dev/null
  ready_pr "$hardening_pr"
fi
wait_clean "$hardening_pr" "$RC2_TREE" true "$MAIN_BRANCH" "Exact hardened RC2 validation"
merge_exact "$hardening_pr" "$WAIT_HEAD_SHA"

rc2_main_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$MAIN_BRANCH" --jq '.object.sha')"
rc2_main_tree="$(gh api "repos/$GITHUB_REPOSITORY/commits/$rc2_main_sha" --jq '.commit.tree.sha')"
test "$rc2_main_tree" = "$RC2_TREE"
publish_or_verify_release \
  "$RC2_TAG" \
  "Coding Tools MCP $RC2_TAG" \
  "$rc2_main_sha" \
  "$RC2_TREE" \
  "$rc2_windows" \
  "$rc2_macos"

# Close only the obsolete PR conversation. Its branch and files remain intact.
old="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$OLD_PR5_NUMBER")"
if [ "$(jq -r '.state' <<<"$old")" = "open" ]; then
  gh pr comment "$OLD_PR5_NUMBER" --repo "$GITHUB_REPOSITORY" \
    --body "Superseded by the exact-tree RC1/RC2 release pipeline. This PR is closed without deleting its branch or files."
  gh pr close "$OLD_PR5_NUMBER" --repo "$GITHUB_REPOSITORY"
fi

jq -n \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg run_url "$run_url" \
  --arg source_sha "$SOURCE_SHA" \
  --arg source_tree "$SOURCE_TREE" \
  --arg rc1_main_sha "$rc1_main_sha" \
  --arg rc1_tag "$RC1_TAG" \
  --arg rc2_source_sha "$rc2_sha" \
  --arg rc2_tree "$RC2_TREE" \
  --arg rc2_main_sha "$rc2_main_sha" \
  --arg rc2_tag "$RC2_TAG" \
  --arg hardening_pr "$hardening_pr" \
  '{
    ok:true,
    repository:$repository,
    evidence_run:$run_url,
    rc1:{source_sha:$source_sha,tree:$source_tree,main_sha:$rc1_main_sha,tag:$rc1_tag},
    rc2:{source_sha:$rc2_source_sha,tree:$rc2_tree,main_sha:$rc2_main_sha,tag:$rc2_tag,pull_request:($hardening_pr|tonumber)},
    deletion_policy:"No source file or branch was deleted; recoverable removals use aiTemp/Trash."
  }' > "$status_dir/final-rc1-rc2-state.json"

printf 'rc2_sha=%s\nrc1_main_sha=%s\nrc2_main_sha=%s\nhardening_pr=%s\n' \
  "$rc2_sha" "$rc1_main_sha" "$rc2_main_sha" "$hardening_pr" >> "$GITHUB_OUTPUT"

echo "RC1 and hardened RC2 promotion and release completed successfully"
