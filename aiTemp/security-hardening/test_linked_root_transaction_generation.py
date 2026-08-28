from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path
from typing import Callable


APPLICATOR = Path(__file__).with_name("apply_security_hardening_v2.py")
ROOT = Path(__file__).resolve().parents[2]


def load_functions(*names: str) -> dict[str, Callable[..., str]]:
    source = APPLICATOR.read_text(encoding="utf-8")
    parsed = ast.parse(source, filename=str(APPLICATOR))
    wanted = set(names)
    functions = [
        node
        for node in parsed.body
        if isinstance(node, ast.FunctionDef) and node.name in wanted
    ]
    found = {function.name for function in functions}
    missing = wanted - found
    if missing:
        raise RuntimeError(f"applicator functions are missing: {sorted(missing)}")
    isolated = ast.Module(body=functions, type_ignores=[])
    namespace: dict[str, object] = {"re": re}
    exec(compile(isolated, str(APPLICATOR), "exec"), namespace)
    return {name: namespace[name] for name in names}  # type: ignore[return-value]


class LinkedRootTransactionGenerationTests(unittest.TestCase):
    def test_linked_root_writes_use_their_approved_root_for_staging_and_trash(self) -> None:
        functions = load_functions(
            "workspace_root_expression",
            "harden_patch_deletion",
            "add_dependencies",
            "harden_exec_timeout",
            "harden_oauth_flow",
        )
        source = (ROOT / "src-tauri/src/tools/patch.rs").read_text(encoding="utf-8")
        generated = functions["harden_patch_deletion"](source)
        production = generated.partition("#[cfg(test)]")[0]

        self.assertIn("fn approved_storage_root(", production)
        self.assertIn(
            "let storage_root = approved_storage_root(ws, &resolved.display, &path)?;",
            production,
        )
        self.assertIn(
            'let staging_root = storage_root\n                .join("aiTemp")\n                .join("staging")',
            production,
        )
        self.assertIn("replace_file(&storage_root, &temp, &path)", production)
        self.assertIn(
            "move_to_trash(&storage_root, &path).map(|_| ())",
            production,
        )
        self.assertIn("cleanup_staging_roots(&staging_roots);", production)
        self.assertNotIn("path.strip_prefix(ws.root())", production)


if __name__ == "__main__":
    unittest.main()
