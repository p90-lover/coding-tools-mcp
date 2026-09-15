import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "release" / "scan_credential_history.py"
EXPECTED_SYNTHETIC_BLOBS = {
    "ca6aace6e2e7e236ffe18a8b3447f4b6e4d8e168",
    "79f44f0363fbca255525cbb5efbe3062625cfdfc",
    "f3137dc08c41bb9d5d4e273aa54b79d2a9d7c355",
    "a9ba427524ed0dcc9b1934e448533c1101d8feb0",
}


def load_module():
    spec = importlib.util.spec_from_file_location("scan_credential_history", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("scanner module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CredentialHistoryAllowlistTests(unittest.TestCase):
    def test_accepts_only_the_exact_synthetic_openai_fixture_blobs(self):
        scanner = load_module()
        self.assertEqual(set(scanner.KNOWN_SYNTHETIC_FINDINGS), EXPECTED_SYNTHETIC_BLOBS)
        findings = [
            {"blob": blob, "kind": "openai-key"}
            for blob in sorted(EXPECTED_SYNTHETIC_BLOBS)
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
