import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "release" / "scan_credential_history.py"


def load_module():
    spec = importlib.util.spec_from_file_location("scan_credential_history", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("scanner module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CredentialHistoryAllowlistTests(unittest.TestCase):
    def test_accepts_only_the_three_exact_synthetic_openai_fixture_blobs(self):
        scanner = load_module()
        findings = [
            {"blob": blob, "kind": "openai-key"}
            for blob in sorted(scanner.KNOWN_SYNTHETIC_FINDINGS)
        ]

        accepted, unexpected = scanner.partition_findings(findings)

        self.assertEqual(accepted, findings)
        self.assertEqual(unexpected, [])

    def test_rejects_same_pattern_from_any_unknown_blob(self):
        scanner = load_module()
        findings = [{"blob": "0" * 40, "kind": "openai-key"}]

        accepted, unexpected = scanner.partition_findings(findings)

        self.assertEqual(accepted, [])
        self.assertEqual(unexpected, findings)

    def test_rejects_other_secret_kinds_even_on_a_known_fixture_blob(self):
        scanner = load_module()
        known_blob = sorted(scanner.KNOWN_SYNTHETIC_FINDINGS)[0]
        findings = [{"blob": known_blob, "kind": "github-token"}]

        accepted, unexpected = scanner.partition_findings(findings)

        self.assertEqual(accepted, [])
        self.assertEqual(unexpected, findings)


if __name__ == "__main__":
    unittest.main()
