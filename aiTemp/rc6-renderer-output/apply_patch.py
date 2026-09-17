from __future__ import annotations

from pathlib import Path

WORKFLOW = Path(".github/workflows/codex-router-multiprovider-release-rc6-csc.yml")

OLD = '''      - name: Build and inspect production renderer in aiTemp
        run: |
          set -euo pipefail
          (
            cd desktop-electron
            bunx vite build \\
              --outDir ../aiTemp/rc6-csc/renderer \\
              --emptyOutDir
          )
          node --test desktop-electron/tests/renderer-provider-bundle.test.cjs \\
            2>&1 | tee aiTemp/evidence/renderer-provider-bundle-tests.txt
          grep -F '# pass 1' aiTemp/evidence/renderer-provider-bundle-tests.txt
          grep -F '# fail 0' aiTemp/evidence/renderer-provider-bundle-tests.txt

      - name: Require unchanged tracked source and no deletion
'''

NEW = '''      - name: Build and inspect production renderer in aiTemp
        run: |
          set -euo pipefail
          if [ -d desktop-electron/dist ]; then
            previous="aiTemp/Trash/release-0.7.0-rc.6-csc/dist-before-$GITHUB_RUN_ID"
            test ! -e "$previous"
            mv desktop-electron/dist "$previous"
          fi
          preload="$PWD/runtime-web/scripts/no-delete-preload.mjs"
          export NODE_OPTIONS="--import=$preload"
          temp="$PWD/aiTemp/tmp/release-0.7.0-rc.6-csc"
          TMPDIR="$temp" TMP="$temp" TEMP="$temp" \\
            bun run --cwd desktop-electron build \\
            2>&1 | tee aiTemp/evidence/desktop-build.txt
          node --test desktop-electron/tests/renderer-provider-bundle.test.cjs \\
            2>&1 | tee aiTemp/evidence/renderer-provider-bundle-tests.txt
          grep -F '# pass 1' aiTemp/evidence/renderer-provider-bundle-tests.txt
          grep -F '# fail 0' aiTemp/evidence/renderer-provider-bundle-tests.txt

      - name: Retain generated renderer and restore tracked dist
        run: |
          set -euo pipefail
          retained="aiTemp/Trash/release-0.7.0-rc.6-csc/generated-dist-$GITHUB_RUN_ID"
          test -d desktop-electron/dist
          test ! -e "$retained"
          mv desktop-electron/dist "$retained"
          git restore --source=HEAD --worktree -- desktop-electron/dist
          test -d "$retained"
          test -d desktop-electron/dist

      - name: Require unchanged tracked source and no deletion
'''

text = WORKFLOW.read_text(encoding="utf-8")
if NEW in text and OLD not in text:
    print("rc.6 renderer output-path repair is already applied")
elif text.count(OLD) == 1:
    WORKFLOW.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print("applied rc.6 renderer output-path repair")
else:
    raise SystemExit(
        "expected exactly one unpatched rc.6 renderer build block, "
        f"found {text.count(OLD)}"
    )
