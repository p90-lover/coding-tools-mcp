from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "aiTemp/rc8-release/run-windows-release.mjs"

source = RUNNER.read_text(encoding="utf-8")
marker = "const rendererDist = path.join(root, 'desktop-electron', 'dist');"
if marker in source:
    print("RC8_RENDERER_RETENTION_ALREADY_APPLIED")
    raise SystemExit(0)

anchor = "  requireCleanTrackedSource();\n"
if source.count(anchor) != 1:
    raise SystemExit(f"expected one clean-source anchor, found {source.count(anchor)}")

retention = """  const rendererDist = path.join(root, 'desktop-electron', 'dist');
  const retainedRenderer = path.join(trash, 'generated-renderer', sourceSha);
  if (fs.existsSync(rendererDist)) {
    assert(!fs.existsSync(retainedRenderer), 'RETAINED_RENDERER_ALREADY_EXISTS');
    fs.mkdirSync(path.dirname(retainedRenderer), { recursive: true });
    fs.renameSync(rendererDist, retainedRenderer);
    run('git', ['restore', '--source=HEAD', '--worktree', '--', 'desktop-electron/dist'], {
      env: process.env,
      label: 'restore tracked renderer after retaining package output',
    });
  }

"""
RUNNER.write_text(source.replace(anchor, retention + anchor, 1), encoding="utf-8")
print("RC8_RENDERER_RETENTION_APPLIED")
