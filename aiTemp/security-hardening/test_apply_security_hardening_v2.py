from __future__ import annotations

import ast
import re
import tomllib
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


class ApplicatorRegressionTests(unittest.TestCase):
    def test_existing_tower_http_dependency_remains_valid_toml(self) -> None:
        ensure_cargo = load_functions("ensure_cargo")["ensure_cargo"]
        source = '''[package]
name = "security-hardening-regression"
version = "0.0.0"

[dependencies]
tower-http = { version = "0.6", features = ["cors"] }

[dev-dependencies]
'''

        generated = ensure_cargo(source)
        try:
            parsed = tomllib.loads(generated)
        except tomllib.TOMLDecodeError as error:
            self.fail(f"ensure_cargo emitted invalid TOML: {error}")

        self.assertEqual(
            parsed["dependencies"]["tower-http"]["features"],
            ["cors", "timeout"],
        )

    def test_patch_deletion_generation_is_transactional_and_reversible(self) -> None:
        functions = load_functions("workspace_root_expression", "harden_patch_deletion")
        source = (ROOT / "src-tauri/src/tools/patch.rs").read_text(encoding="utf-8")
        generated = functions["harden_patch_deletion"](source)
        production = generated.partition("#[cfg(test)]")[0]

        self.assertIn(
            'let staging_root = ws.root()\n        .join("aiTemp")\n        .join("staging")',
            production,
        )
        self.assertIn("cleanup_staging_root(ws.root(), &staging_root);", production)
        self.assertIn("restore_backups(ws.root(), &backups);", production)
        self.assertIn("replace_file(ws.root(), &temp, &path)", production)
        self.assertIn("move_to_trash(ws.root(), &path).map(|_| ())", production)
        self.assertIn(
            "fn restore_backups(\n    workspace_root: &std::path::Path,",
            production,
        )
        self.assertIn(
            "fn replace_file(\n    workspace_root: &std::path::Path,",
            production,
        )
        self.assertNotRegex(production, r"(?:std::)?fs::remove_file")
        self.assertNotIn("move_to_trash(ws.root(), path)", production)

    def test_listener_generation_uses_non_deprecated_timeout_responses(self) -> None:
        functions = load_functions(
            "insert_before_once",
            "replace_once",
            "harden_mcp_listener",
            "harden_actions_listener",
        )
        cases = (
            ("src-tauri/src/mcp/listener.rs", "harden_mcp_listener"),
            ("src-tauri/src/actions/listener.rs", "harden_actions_listener"),
        )
        for relative, function_name in cases:
            with self.subTest(path=relative):
                source = (ROOT / relative).read_text(encoding="utf-8")
                generated = functions[function_name](source)
                self.assertIn(
                    "TimeoutLayer::with_status_code(\n"
                    "                    StatusCode::REQUEST_TIMEOUT,",
                    generated,
                )
                self.assertNotIn("TimeoutLayer::new(", generated)


if __name__ == "__main__":
    unittest.main()
