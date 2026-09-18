#!/usr/bin/env bash
set -uo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

evidence="$repo_root/aiTemp/rc11-integration/evidence"
mkdir -p "$evidence" "$repo_root/aiTemp/Trash/rc11-integration"

source_head="${SOURCE_HEAD:?SOURCE_HEAD is required}"
source_branch="${SOURCE_BRANCH:?SOURCE_BRANCH is required}"

printf '%s\n' "$source_head" > "$evidence/expected-source-head.txt"
git rev-parse HEAD > "$evidence/integration-base-head.txt"

git fetch --no-tags origin "$source_branch"
actual_source="$(git rev-parse FETCH_HEAD)"
printf '%s\n' "$actual_source" > "$evidence/fetched-source-head.txt"
if [[ "$actual_source" != "$source_head" ]]; then
  printf 'SOURCE_HEAD_MISMATCH expected=%s actual=%s\n' "$source_head" "$actual_source" | tee "$evidence/result.txt"
  exit 1
fi

set +e
git merge --no-commit --no-ff "$source_head" > "$evidence/merge-output.txt" 2>&1
merge_status=$?
set -e

printf '%s\n' "$merge_status" > "$evidence/merge-exit-code.txt"
git status --porcelain=v1 > "$evidence/status.txt"
git diff --name-only --diff-filter=U | sort > "$evidence/conflicts.txt"
git diff --stat > "$evidence/working-tree-stat.txt"
git diff --cached --stat > "$evidence/index-stat.txt"

{
  printf 'integration_base=%s\n' "$(cat "$evidence/integration-base-head.txt")"
  printf 'source_head=%s\n' "$source_head"
  printf 'merge_exit=%s\n' "$merge_status"
  printf 'conflict_count=%s\n' "$(wc -l < "$evidence/conflicts.txt" | tr -d ' ')"
  while IFS= read -r conflict; do
    [[ -n "$conflict" ]] || continue
    printf '\n=== %s ===\n' "$conflict"
    git ls-files -u -- "$conflict"
  done < "$evidence/conflicts.txt"
} > "$evidence/summary.txt"

cat "$evidence/summary.txt"
printf '\n--- conflicts ---\n'
cat "$evidence/conflicts.txt"
printf '\n--- merge output ---\n'
cat "$evidence/merge-output.txt"

# A conflict is evidence, not a failed probe. The runner workspace is ephemeral;
# no project path, branch, release, or retained evidence is deleted here.
exit 0
