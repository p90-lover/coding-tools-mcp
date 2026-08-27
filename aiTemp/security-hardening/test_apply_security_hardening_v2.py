from __future__ import annotations

import ast
import re
import tomllib
import unittest
from pathlib import Path


APPLICATOR = Path(__file__).with_name("apply_security_hardening_v2.py")


def load_ensure_cargo():
    source = APPLICATOR.read_text(encoding="utf-8")
    parsed = ast.parse(source, filename=str(APPLICATOR))
    function = next(
        node
        for node in parsed.body
        if isinstance(node, ast.FunctionDef) and node.name == "ensure_cargo"
    )
    isolated = ast.Module(body=[function], type_ignores=[])
    namespace = {"re": re}
    exec(compile(isolated, str(APPLICATOR), "exec"), namespace)
    return namespace["ensure_cargo"]


class EnsureCargoRegressionTests(unittest.TestCase):
    def test_existing_tower_http_dependency_remains_valid_toml(self) -> None:
        ensure_cargo = load_ensure_cargo()
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


if __name__ == "__main__":
    unittest.main()
