# Electron Harness Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a reproducible, license-compliant foundation for importing and validating pinned `codex-chatgpt-web` v5.0.6 before any Electron runtime or installer code is merged.

**Architecture:** Keep upstream source outside the ordinary Coding Tools source tree during this workstream. GitHub Actions checks out the exact upstream commit into `aiTemp/upstream`, validates its Git identity and required files against a committed manifest, runs upstream model-free checks, produces a deterministic source archive, and publishes evidence artifacts. The existing Tauri/Rust product remains unchanged.

**Tech Stack:** Node.js 22, Bun 1.4.0, TypeScript, Git, GitHub Actions, deterministic GNU tar, JSON manifests.

**Spec:** `docs/superpowers/specs/2026-09-14-electron-full-codex-harness-design.md`

## Global Constraints

- Pin upstream commit `e85e3693fdb4e3e033348c08df0298c20fcdb612` and version `5.0.6`.
- Retain upstream MIT text and all imported third-party notices.
- Put transient checkouts, archives, logs, and generated reports under `aiTemp/`.
- Do not delete or replace Tauri source, releases, branches, user data, or upstream history.
- Do not run ChatGPT, a model, a browser login, a tunnel, or a Codex task in this workstream.
- Fail when the upstream commit, package version, required blob identity, required license, or generated archive manifest differs.

---

### Task 1: Commit the upstream identity manifest

**Files:**
- Create: `vendor/codex-chatgpt-web-v5.0.6/UPSTREAM.json`
- Create: `vendor/codex-chatgpt-web-v5.0.6/LICENSE`
- Create: `tests/upstream/codex-chatgpt-web-manifest.test.mjs`

**Interfaces:**
- Consumes: the pinned public upstream repository.
- Produces: `UPSTREAM.json` with `repository`, `version`, `commit`, `requiredFiles`, and `buildInputs` fields.

- [ ] **Step 1: Write the failing manifest test**

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(fs.readFileSync('vendor/codex-chatgpt-web-v5.0.6/UPSTREAM.json', 'utf8'));

test('pins the reviewed upstream identity', () => {
  assert.equal(manifest.repository, 'https://github.com/miuuyy/codex-chatgpt-web');
  assert.equal(manifest.version, '5.0.6');
  assert.equal(manifest.commit, 'e85e3693fdb4e3e033348c08df0298c20fcdb612');
  assert.equal(manifest.packageManager, 'bun@1.4.0');
  assert.equal(manifest.requiredFiles.LICENSE, '99a9feb4d2246a1fe00eb0f27394a97497af32cf');
  assert.equal(manifest.requiredFiles['package.json'], '8456912ea3ebe25e370b6328bbff983dabe5ffa2');
  assert.equal(manifest.requiredFiles['launcher/package.json'], 'cf9d469debf42e2aa73614bc9825b48f9668ad3e');
});
```

- [ ] **Step 2: Run the test and confirm it fails because the manifest is absent**

Run: `node --test tests/upstream/codex-chatgpt-web-manifest.test.mjs`

Expected: FAIL with `ENOENT` for `UPSTREAM.json`.

- [ ] **Step 3: Add the exact manifest and retained MIT license**

Use the reviewed values above plus required blobs for `bun.lock`, `launcher/bun.lock`, `docs/architecture.md`, and `docs/security-model.md`. Copy the upstream MIT text verbatim into the retained license file.

- [ ] **Step 4: Run the focused test**

Run: `node --test tests/upstream/codex-chatgpt-web-manifest.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vendor/codex-chatgpt-web-v5.0.6 tests/upstream/codex-chatgpt-web-manifest.test.mjs
git commit -m "build: pin codex-chatgpt-web v5.0.6 identity"
```

### Task 2: Validate a materialized upstream checkout

**Files:**
- Create: `scripts/upstream/verify-codex-chatgpt-web.mjs`
- Create: `tests/upstream/verify-checkout.test.mjs`

**Interfaces:**
- Consumes: `verify-codex-chatgpt-web.mjs --source <directory> --manifest <file> --report <file>`.
- Produces: JSON report containing the verified commit, tree, package versions, required blob IDs, file counts, and `modelRequests: 0`.

- [ ] **Step 1: Write a failing fixture test**

Create a temporary Git repository with the right package version but the wrong commit and assert that the verifier exits nonzero with `UPSTREAM_COMMIT_MISMATCH`.

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `node --test tests/upstream/verify-checkout.test.mjs`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement the verifier**

The verifier must:

```js
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
const tree = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD^{tree}'], {encoding: 'utf8'}).trim();
const blob = (path) => execFileSync('git', ['-C', source, 'rev-parse', `HEAD:${path}`], {encoding: 'utf8'}).trim();
```

It must reject symlinked required files, dirty tracked files, missing lockfiles, incorrect package versions, unexpected commit identity, and required blob mismatches. It must write the report atomically under the caller-supplied path.

- [ ] **Step 4: Add success, dirty-tree, blob-mismatch, and symlink fixture cases**

Each fixture must use its own directory under `aiTemp/test-upstream/`; tests preserve failed fixture directories for inspection instead of deleting them.

- [ ] **Step 5: Run the focused tests**

Run: `node --test tests/upstream/verify-checkout.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/upstream/verify-codex-chatgpt-web.mjs tests/upstream/verify-checkout.test.mjs
git commit -m "test: verify the exact upstream checkout"
```

### Task 3: Generate retained license and provenance evidence

**Files:**
- Create: `scripts/upstream/generate-codex-notices.mjs`
- Create: `third_party/THIRD_PARTY_NOTICES.md`
- Create: `third_party/LICENSES/codex-chatgpt-web-MIT.txt`
- Create: `tests/upstream/license-evidence.test.mjs`

**Interfaces:**
- Consumes: verified upstream source and `UPSTREAM.json`.
- Produces: `aiTemp/evidence/codex-chatgpt-web-provenance.json` and deterministic notices.

- [ ] **Step 1: Write tests requiring the upstream notice, Bun notice, tiktoken notice, source commit, and project licenses**

The test must reject a notice file missing either upstream copyright text or one listed upstream license input.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test tests/upstream/license-evidence.test.mjs`

Expected: FAIL because the generator and notice files are absent.

- [ ] **Step 3: Implement the generator**

Read only declared license paths from the verified source. Bound each input to 1 MiB, reject symlinks, preserve exact text, include source path and blob ID, and never scan browser profiles or application data.

- [ ] **Step 4: Generate and verify notices**

Run:

```bash
node scripts/upstream/generate-codex-notices.mjs \
  --source aiTemp/upstream \
  --manifest vendor/codex-chatgpt-web-v5.0.6/UPSTREAM.json \
  --output aiTemp/evidence/codex-chatgpt-web-provenance.json
node --test tests/upstream/license-evidence.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/upstream/generate-codex-notices.mjs third_party tests/upstream/license-evidence.test.mjs
git commit -m "docs: retain upstream license and provenance evidence"
```

### Task 4: Add deterministic source materialization CI

**Files:**
- Create: `.github/workflows/electron-upstream-foundation.yml`
- Create: `scripts/upstream/archive-codex-chatgpt-web.sh`
- Test: workflow evidence artifacts.

**Interfaces:**
- Consumes: the target branch and an `actions/checkout` of upstream commit `e85e3693fdb4e3e033348c08df0298c20fcdb612` in `aiTemp/upstream`.
- Produces: `codex-chatgpt-web-v5.0.6-source.tar.gz`, `SHA256SUMS.txt`, verification report, test logs, and provenance evidence.

- [ ] **Step 1: Add a workflow that first proves the manifest tests fail if a required blob is changed in a synthetic copy**

Use Node fixtures only; never mutate the checked-out upstream directory.

- [ ] **Step 2: Check out both repositories at exact commits**

Use pinned actions:

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  with:
    repository: miuuyy/codex-chatgpt-web
    ref: e85e3693fdb4e3e033348c08df0298c20fcdb612
    path: aiTemp/upstream
    clean: false
    persist-credentials: false
- uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
  with:
    bun-version: 1.4.0
```

- [ ] **Step 3: Run model-free upstream checks**

Run `bun install --frozen-lockfile`, root typecheck/tests, launcher typecheck/tests, and the committed verifier. Do not start the launcher, browser, tunnel, Responses daemon, or ChatGPT session.

- [ ] **Step 4: Create a deterministic archive**

The archive script must use sorted paths, numeric owners, fixed owner/group, and `--mtime=@0`. It must exclude `.git` and put the top-level directory at `codex-chatgpt-web-v5.0.6/`.

- [ ] **Step 5: Verify a second archive has the same SHA-256**

Create the second archive in another `aiTemp/` directory and compare hashes byte-for-byte.

- [ ] **Step 6: Upload evidence and source bundle**

Use `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` with 14-day retention. Preserve evidence on failure.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/electron-upstream-foundation.yml scripts/upstream/archive-codex-chatgpt-web.sh
git commit -m "ci: materialize verified upstream source reproducibly"
```

### Task 5: Record foundation completion without claiming product integration

**Files:**
- Create: `docs/integration/codex-chatgpt-web-source-foundation.md`
- Modify: draft PR #35 description after successful workflow evidence exists.

**Interfaces:**
- Consumes: successful workflow run ID and artifact hashes.
- Produces: a precise statement of what is verified and what remains unimplemented.

- [ ] **Step 1: Document the verified boundary**

State that source identity, licenses, model-free tests, and deterministic materialization passed. State explicitly that Electron replacement, Rust sidecar, Full Harness wiring, browser login, live account compatibility, installer, and release are not implemented by this workstream.

- [ ] **Step 2: Link workflow evidence and source commit**

Include branch commit, upstream commit, workflow run, source archive hash, and notice/provenance artifact names.

- [ ] **Step 3: Run repository checks**

Run:

```bash
node --test tests/upstream/*.test.mjs
npm run check
npm run build
git diff --check
```

Expected: all pass; no deletion appears in the diff.

- [ ] **Step 4: Commit**

```bash
git add docs/integration/codex-chatgpt-web-source-foundation.md
git commit -m "docs: record verified Electron migration foundation"
```

- [ ] **Step 5: Review the branch diff**

Confirm changes are limited to the approved specification, plans, manifest, retained licenses, verification scripts/tests, CI workflow, and foundation evidence documentation.
