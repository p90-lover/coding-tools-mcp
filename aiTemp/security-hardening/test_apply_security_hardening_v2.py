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


class SecurityHardeningApplicatorTests(unittest.TestCase):
    def test_cargo_generation_adds_direct_dependencies_inside_dependencies_table(self) -> None:
        add_dependencies = load_functions("add_dependencies")["add_dependencies"]
        baseline = """[package]
name = "fixture"
version = "0.1.0"

[dependencies]
serde = "1"

[dev-dependencies]
tempfile = "3"
"""
        generated = add_dependencies(baseline)

        self.assertEqual(generated.count("[dependencies]"), 1)
        dependencies = generated.split("[dependencies]\n", 1)[1].split(
            "\n[dev-dependencies]", 1
        )[0]
        for dependency in ("sha2", "subtle", "zeroize"):
            self.assertRegex(
                dependencies,
                rf"(?m)^{dependency}\s*=",
                msg=f"{dependency} must be a direct dependency",
            )
        dev_dependencies = generated.split("[dev-dependencies]\n", 1)[1]
        for dependency in ("sha2", "subtle", "zeroize"):
            self.assertNotRegex(dev_dependencies, rf"(?m)^{dependency}\s*=")

    def test_patch_deletion_generation_is_reversible_and_root_aware(self) -> None:
        functions = load_functions("workspace_root_expression", "harden_patch_deletion")
        source = (ROOT / "src-tauri/src/tools/patch.rs").read_text(encoding="utf-8")
        generated = functions["harden_patch_deletion"](source)
        production = generated.partition("#[cfg(test)]")[0]

        self.assertIn("fn approved_storage_root(", production)
        self.assertIn(
            "let mut staging_roots: HashMap<PathBuf, PathBuf> = HashMap::new();",
            production,
        )
        self.assertIn(
            "let storage_root = approved_storage_root(ws, &resolved.display, &path)?;",
            production,
        )
        self.assertIn("cleanup_staging_roots(&staging_roots);", production)
        self.assertIn("restore_backups(ws, &backups)", production)
        self.assertIn(
            "replace_file(&storage_root, &temp, &path)",
            production,
        )
        self.assertIn(
            "move_to_trash(&storage_root, &path).map(|_| ())",
            production,
        )
        self.assertIn(
            "fn restore_backups(\n    ws: &Workspace,",
            production,
        )
        self.assertIn(
            "fn replace_file(\n    storage_root: &std::path::Path,",
            production,
        )
        self.assertIn("rollback also failed", production)
        self.assertNotIn("path.strip_prefix(ws.root())", production)
        self.assertNotIn("cleanup_temporary_files", production)
        self.assertIsNone(
            re.search(r"(?:std::)?fs::remove_file", production),
            msg="production patch code must never permanently delete files",
        )

    def test_exec_timeout_generation_returns_structured_timeout_result(self) -> None:
        harden_exec_timeout = load_functions("harden_exec_timeout")["harden_exec_timeout"]
        source = (ROOT / "src-tauri/src/tools/exec.rs").read_text(encoding="utf-8")
        generated = harden_exec_timeout(source)

        self.assertEqual(generated.count("use std::sync::mpsc;"), 1)
        self.assertIn("fn run_output_with_timeout(", generated)
        self.assertIn("recv_timeout(std::time::Duration::from_secs(timeout_secs))", generated)
        self.assertIn("pub(crate) fn execute_program(", generated)
        self.assertIn(
            "let (output, timed_out) = run_output_with_timeout(command, timeout_secs);",
            generated,
        )
        self.assertIn('"timed_out": timed_out', generated)
        self.assertIn("if timed_out { 124 }", generated)

    def test_oauth_fixture_uses_the_configured_client_id(self) -> None:
        harden_oauth_flow = load_functions("harden_oauth_flow")["harden_oauth_flow"]
        source = (ROOT / "src-tauri/src/auth/oauth_flow.rs").read_text(encoding="utf-8")
        generated = harden_oauth_flow(source)

        self.assertIn(
            'assert!(oauth.client_id_allowed("chatgpt-client-test"));',
            generated,
        )
        self.assertNotIn(
            'assert!(oauth.client_id_allowed("client"));',
            generated,
        )


if __name__ == "__main__":
    unittest.main()
