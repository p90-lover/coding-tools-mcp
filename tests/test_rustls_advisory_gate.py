import pathlib
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCKFILE = ROOT / "src-tauri" / "Cargo.lock"
MINIMUM_SAFE_RUSTLS = (0, 23, 45)


def parse_semver(version: str) -> tuple[int, int, int]:
    core = version.split("-", 1)[0]
    parts = core.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise AssertionError(f"Unsupported rustls version format: {version}")
    return tuple(int(part) for part in parts)  # type: ignore[return-value]


class RustlsAdvisoryGateTests(unittest.TestCase):
    def test_every_locked_rustls_is_patched_for_rustsec_2026_0285(self):
        lock = tomllib.loads(LOCKFILE.read_text(encoding="utf-8"))
        versions = [
            package["version"]
            for package in lock["package"]
            if package["name"] == "rustls"
        ]
        self.assertTrue(versions, "Cargo.lock must contain rustls")
        vulnerable = [
            version
            for version in versions
            if parse_semver(version) < MINIMUM_SAFE_RUSTLS
        ]
        self.assertEqual(
            vulnerable,
            [],
            "RUSTSEC-2026-0285 requires rustls >= 0.23.45; "
            f"found vulnerable locked versions: {vulnerable}",
        )


if __name__ == "__main__":
    unittest.main()
