#!/usr/bin/env python3

from pathlib import Path

from apply_bridge_patch import patch_ipc_schema, patch_main, patch_preload

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def ensure_development_binary_candidates() -> None:
    path = ROOT / "desktop-electron/electron/headless-host.cjs"
    old = '''  binaryPath() {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const name = `coding-tools-headless${suffix}`;
    const candidates = [
      process.env.CODING_TOOLS_HEADLESS_BINARY,
      this.app.isPackaged ? path.join(process.resourcesPath, "coding-tools", name) : null,
      path.join(this.sourceRoot, "rust-core", "target", "debug", name),
      path.join(this.sourceRoot, "rust-core", "target", "release", name),
    ].filter(Boolean);
    for (const candidate of candidates) {
'''
    new = '''  binaryCandidates() {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const name = `coding-tools-headless${suffix}`;
    return [
      process.env.CODING_TOOLS_HEADLESS_BINARY,
      this.app.isPackaged ? path.join(process.resourcesPath, "coding-tools", name) : null,
      path.join(this.sourceRoot, "rust-core", "coding-tools-headless", "target", "debug", name),
      path.join(this.sourceRoot, "rust-core", "coding-tools-headless", "target", "release", name),
      path.join(this.sourceRoot, "rust-core", "target", "debug", name),
      path.join(this.sourceRoot, "rust-core", "target", "release", name),
    ].filter(Boolean);
  }

  binaryPath() {
    const candidates = this.binaryCandidates();
    for (const candidate of candidates) {
'''
    replace_once(path, old, new, "development headless binary candidates")


def ensure_development_binary_contract() -> None:
    path = ROOT / "desktop-electron/tests/execution-bridge-contract.test.cjs"
    text = path.read_text(encoding="utf-8")
    marker = 'test("development binary discovery includes Cargo package-local targets"'
    if marker in text:
        return
    addition = r'''

test("development binary discovery includes Cargo package-local targets", () => {
  const { HeadlessHost } = require(path.join(
    repositoryRoot,
    "desktop-electron/electron/headless-host.cjs",
  ));
  const sourceRoot = path.join(repositoryRoot, "source-fixture");
  const host = new HeadlessHost({
    app: { isPackaged: false },
    logger: {},
    sourceRoot,
  });
  const suffix = process.platform === "win32" ? ".exe" : "";
  const executable = `coding-tools-headless${suffix}`;
  const candidates = host.binaryCandidates();

  assert.ok(candidates.includes(path.join(
    sourceRoot,
    "rust-core",
    "coding-tools-headless",
    "target",
    "debug",
    executable,
  )));
  assert.ok(candidates.includes(path.join(
    sourceRoot,
    "rust-core",
    "coding-tools-headless",
    "target",
    "release",
    executable,
  )));
});
'''
    path.write_text(text.rstrip() + addition.rstrip() + "\n", encoding="utf-8")


def bridge_contract_present() -> bool:
    checks = (
        ("desktop-electron/electron/ipc-schema.cjs", '"execution.read"'),
        ("desktop-electron/electron/preload.cjs", "execution: Object.freeze({"),
        ("desktop-electron/electron/main.cjs", 'handle("coding-tools:execution:read"'),
        ("desktop-electron/electron/main.cjs", "new HeadlessHost({"),
    )
    return all(marker in (ROOT / relative).read_text(encoding="utf-8") for relative, marker in checks)


def main() -> None:
    ensure_development_binary_candidates()
    ensure_development_binary_contract()
    if bridge_contract_present():
        print("Electron execution bridge is already applied; verified idempotent no-op.")
        return
    patch_ipc_schema()
    patch_preload()
    patch_main()
    print("Applied Electron IPC bridge on the already-integrated headless source.")


if __name__ == "__main__":
    main()
