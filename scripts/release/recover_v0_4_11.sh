#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"

RELEASE_TAG="${RELEASE_TAG:-v0.4.11}"
RELEASE_SOURCE="${RELEASE_SOURCE:-546fbb37a82bd2e57ec019d8c361813af7615447}"
SOURCE_RUN_ID="${SOURCE_RUN_ID:-34942004718}"

mkdir -p \
  aiTemp/recovery-evidence \
  aiTemp/source-run-meta \
  aiTemp/source-artifacts/windows \
  aiTemp/source-artifacts/macos \
  aiTemp/release-assets \
  "aiTemp/readback-${GITHUB_RUN_ID}" \
  aiTemp/release-meta

git fetch --no-tags origin "refs/tags/${RELEASE_TAG}"
test "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$RELEASE_SOURCE"
git fetch origin main
git merge-base --is-ancestor "$RELEASE_SOURCE" origin/main
git diff --exit-code "$RELEASE_SOURCE" -- \
  package.json \
  package-lock.json \
  src-tauri/Cargo.toml \
  src-tauri/Cargo.lock \
  src-tauri/tauri.conf.json \
  "docs/releases/${RELEASE_TAG}.md"
printf '%s\n' "$RELEASE_SOURCE" > aiTemp/recovery-evidence/release-source.txt

python tests/test_release_credential_history_scan.py -v \
  2>&1 | tee aiTemp/recovery-evidence/scanner-tests.txt
python scripts/release/scan_credential_history.py \
  --output aiTemp/recovery-evidence/credential-screen.json \
  > aiTemp/recovery-evidence/credential-screen.stdout.json
python - <<'PY'
import json
import pathlib

report = json.loads(
    pathlib.Path("aiTemp/recovery-evidence/credential-screen.json").read_text()
)
accepted = report["accepted_synthetic_fixtures"]
assert len(accepted) == 4, accepted
assert not report["unexpected_findings"], report["unexpected_findings"]
assert all(item["kind"] == "openai-key" for item in accepted), accepted
print("Credential screen passed with exactly four pinned synthetic fixture blobs.")
PY

cargo install cargo-audit --locked --version 0.22.2 --root "$PWD/aiTemp/audit-tool"
aiTemp/audit-tool/bin/cargo-audit audit --file src-tauri/Cargo.lock \
  2>&1 | tee aiTemp/recovery-evidence/rustsec.txt
aiTemp/audit-tool/bin/cargo-audit audit --file src-tauri/Cargo.lock --json \
  > aiTemp/recovery-evidence/rustsec.json
python - <<'PY'
import json
import pathlib

report = json.loads(pathlib.Path("aiTemp/recovery-evidence/rustsec.json").read_text())
assert not report["vulnerabilities"]["found"], "RustSec vulnerability remains"
warnings = report.get("warnings", {})
assert not warnings.get("yanked", []), "A locked crate was yanked"
assert all(
    item["advisory"]["id"] == "RUSTSEC-2024-0429"
    and item["package"]["name"] == "glib"
    for item in warnings.get("unsound", [])
), "Unreviewed soundness warning"
print("RustSec vulnerability and yanked-crate gates passed.")
PY

gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${SOURCE_RUN_ID}" \
  > aiTemp/source-run-meta/run.json
gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${SOURCE_RUN_ID}/jobs?per_page=100" \
  > aiTemp/source-run-meta/jobs.json
gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${SOURCE_RUN_ID}/artifacts?per_page=100" \
  > aiTemp/source-run-meta/artifacts.json
python - <<'PY'
import json
import os
import pathlib

run = json.loads(pathlib.Path("aiTemp/source-run-meta/run.json").read_text())
jobs = json.loads(pathlib.Path("aiTemp/source-run-meta/jobs.json").read_text())["jobs"]
artifacts = json.loads(
    pathlib.Path("aiTemp/source-run-meta/artifacts.json").read_text()
)["artifacts"]
source = os.environ["RELEASE_SOURCE"]
assert run["head_sha"] == source, run["head_sha"]
assert run["path"] == ".github/workflows/release.yml", run["path"]
native = [job for job in jobs if job["name"].startswith("native (")]
assert len(native) == 2, [job["name"] for job in native]
assert all(job["conclusion"] == "success" for job in native), [
    (job["name"], job["conclusion"]) for job in native
]
identity = [job for job in jobs if job["name"] == "identity"]
assert len(identity) == 1 and identity[0]["conclusion"] == "success", identity
expected = {f"installer-windows-{source}", f"installer-macos-{source}"}
actual = {item["name"] for item in artifacts if not item.get("expired")}
assert expected <= actual, (expected, actual)
print("Exact-source identity and both native installer jobs passed.")
PY

gh run download "$SOURCE_RUN_ID" \
  --repo "$GITHUB_REPOSITORY" \
  --name "installer-windows-${RELEASE_SOURCE}" \
  --dir aiTemp/source-artifacts/windows
gh run download "$SOURCE_RUN_ID" \
  --repo "$GITHUB_REPOSITORY" \
  --name "installer-macos-${RELEASE_SOURCE}" \
  --dir aiTemp/source-artifacts/macos

python - <<'PY'
import hashlib
import json
import os
import pathlib
import shutil

source_root = pathlib.Path("aiTemp/source-artifacts")
output_root = pathlib.Path("aiTemp/release-assets")
exe = list(source_root.rglob("*.exe"))
dmg = list(source_root.rglob("*.dmg"))
assert len(exe) == 1, exe
assert len(dmg) == 1, dmg
assert exe[0].stat().st_size > 100_000, exe[0].stat().st_size
assert dmg[0].stat().st_size > 100_000, dmg[0].stat().st_size
assert exe[0].read_bytes()[:2] == b"MZ", "Windows installer lacks PE MZ header"

destinations = {
    exe[0]: output_root / "Coding.Tools.MCP_0.4.11_x64-setup.exe",
    dmg[0]: output_root / "Coding.Tools.MCP_0.4.11_universal.dmg",
}
for source, destination in destinations.items():
    if destination.exists():
        assert destination.read_bytes() == source.read_bytes(), destination
    else:
        shutil.copyfile(source, destination)

assets = sorted(destinations.values(), key=lambda path: path.name)
sums: list[str] = []
manifest: list[dict[str, object]] = []
for asset in assets:
    digest = hashlib.sha256(asset.read_bytes()).hexdigest()
    sums.append(f"{digest}  {asset.name}\n")
    manifest.append(
        {"name": asset.name, "size": asset.stat().st_size, "sha256": digest}
    )
sums_path = output_root / "SHA256SUMS.txt"
sums_path.write_text("".join(sums), encoding="utf-8")
manifest.append(
    {
        "name": sums_path.name,
        "size": sums_path.stat().st_size,
        "sha256": hashlib.sha256(sums_path.read_bytes()).hexdigest(),
    }
)
pathlib.Path("aiTemp/recovery-evidence/release-assets.json").write_text(
    json.dumps(
        {
            "tag": os.environ["RELEASE_TAG"],
            "source": os.environ["RELEASE_SOURCE"],
            "source_run_id": int(os.environ["SOURCE_RUN_ID"]),
            "assets": manifest,
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
print(json.dumps(manifest, indent=2))
PY

gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=100" \
  > aiTemp/release-meta/releases-before.json
release_state="$(python - <<'PY'
import json
import os
import pathlib

releases = json.loads(pathlib.Path("aiTemp/release-meta/releases-before.json").read_text())
matches = [release for release in releases if release.get("tag_name") == os.environ["RELEASE_TAG"]]
assert len(matches) <= 1, matches
if not matches:
    print("missing")
else:
    release = matches[0]
    assert release.get("name") == f"Coding Tools MCP {os.environ['RELEASE_TAG']}"
    assert release.get("prerelease") is False
    print(f"{'draft' if release.get('draft') else 'published'}:{release['id']}")
PY
)"

if [ "$release_state" = missing ]; then
  gh release create "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --verify-tag \
    --draft \
    --title "Coding Tools MCP $RELEASE_TAG" \
    --notes-file "docs/releases/${RELEASE_TAG}.md"
  gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=100" \
    > aiTemp/release-meta/releases-after-create.json
  release_state="$(python - <<'PY'
import json
import os
import pathlib

releases = json.loads(
    pathlib.Path("aiTemp/release-meta/releases-after-create.json").read_text()
)
matches = [
    release
    for release in releases
    if release.get("tag_name") == os.environ["RELEASE_TAG"]
    and release.get("draft") is True
]
assert len(matches) == 1, matches
print(f"draft:{matches[0]['id']}")
PY
)"
fi

case "$release_state" in
  draft:*|published:*) ;;
  *) echo "Unexpected release state: $release_state" >&2; exit 1 ;;
esac
release_kind="${release_state%%:*}"
release_id="${release_state#*:}"

gh api "repos/${GITHUB_REPOSITORY}/releases/${release_id}" \
  > aiTemp/release-meta/release-before-upload.json
python - <<'PY' > aiTemp/release-meta/missing-assets.txt
import json
import pathlib

release = json.loads(
    pathlib.Path("aiTemp/release-meta/release-before-upload.json").read_text()
)
local = {
    path.name: path.stat().st_size
    for path in pathlib.Path("aiTemp/release-assets").iterdir()
    if path.is_file()
}
remote = {asset["name"]: asset["size"] for asset in release["assets"]}
unexpected = set(remote) - set(local)
assert not unexpected, unexpected
for name, size in remote.items():
    assert local[name] == size, (name, local[name], size)
for name in sorted(set(local) - set(remote)):
    print(name)
PY

while IFS= read -r name; do
  [ -z "$name" ] || gh release upload "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    "aiTemp/release-assets/$name"
done < aiTemp/release-meta/missing-assets.txt

gh api "repos/${GITHUB_REPOSITORY}/releases/${release_id}" \
  > aiTemp/release-meta/release-after-upload.json
python - <<'PY' > aiTemp/release-meta/readback-plan.tsv
import json
import pathlib

release = json.loads(
    pathlib.Path("aiTemp/release-meta/release-after-upload.json").read_text()
)
expected = {
    "Coding.Tools.MCP_0.4.11_x64-setup.exe",
    "Coding.Tools.MCP_0.4.11_universal.dmg",
    "SHA256SUMS.txt",
}
assets = {asset["name"]: asset for asset in release["assets"]}
assert set(assets) == expected, (set(assets), expected)
for name in sorted(expected):
    print(f"{name}\t{assets[name]['id']}")
PY

while IFS=$'\t' read -r name asset_id; do
  gh api \
    -H 'Accept: application/octet-stream' \
    "repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}" \
    > "aiTemp/readback-${GITHUB_RUN_ID}/${name}"
done < aiTemp/release-meta/readback-plan.tsv

python - <<'PY'
import hashlib
import os
import pathlib

local = pathlib.Path("aiTemp/release-assets")
readback = pathlib.Path("aiTemp") / f"readback-{os.environ['GITHUB_RUN_ID']}"
expected = {path.name: path for path in local.iterdir() if path.is_file()}
actual = {path.name: path for path in readback.iterdir() if path.is_file()}
assert set(actual) == set(expected), (set(actual), set(expected))
for name, source in expected.items():
    source_digest = hashlib.sha256(source.read_bytes()).hexdigest()
    actual_digest = hashlib.sha256(actual[name].read_bytes()).hexdigest()
    assert source_digest == actual_digest, (name, source_digest, actual_digest)
print("Release-asset read-back SHA-256 verification passed.")
PY

if [ "$release_kind" = draft ]; then
  gh api \
    --method PATCH \
    -F draft=false \
    "repos/${GITHUB_REPOSITORY}/releases/${release_id}" \
    > aiTemp/release-meta/publish-response.json
fi

gh api "repos/${GITHUB_REPOSITORY}/releases/${release_id}" \
  > aiTemp/release-meta/release-final.json
python - <<'PY'
import json
import os
import pathlib

release = json.loads(pathlib.Path("aiTemp/release-meta/release-final.json").read_text())
expected = {
    "Coding.Tools.MCP_0.4.11_x64-setup.exe",
    "Coding.Tools.MCP_0.4.11_universal.dmg",
    "SHA256SUMS.txt",
}
assert release["tag_name"] == os.environ["RELEASE_TAG"]
assert release["target_commitish"] in ("main", os.environ["RELEASE_SOURCE"])
assert release["draft"] is False
assert release["prerelease"] is False
assert {asset["name"] for asset in release["assets"]} == expected
print(release["html_url"])
PY
