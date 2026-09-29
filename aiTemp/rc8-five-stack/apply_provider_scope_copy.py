from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "desktop-electron/src/providers/ProviderHubIntegration.tsx"


def replace_once(before: str, after: str) -> None:
    text = TARGET.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {TARGET.relative_to(ROOT)}")
        return
    count = text.count(before)
    if count != 1:
        raise SystemExit(
            f"expected one anchor in {TARGET.relative_to(ROOT)}, found {count}: {before!r}"
        )
    TARGET.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {TARGET.relative_to(ROOT)}")


replace_once(
    '''    oauthTraffic: "OAuth login",
    paseo: "Paseo",
''',
    '''    oauthTraffic: "OAuth login",
    subagent: "Codex subagents",
    paseo: "Paseo",
''',
)
replace_once(
    '''    oauthTraffic: "OAuth 登入",
    paseo: "Paseo",
''',
    '''    oauthTraffic: "OAuth 登入",
    subagent: "Codex 子代理",
    paseo: "Paseo",
''',
)
replace_once(
    '''  "provider",
  "oauth",
  "paseo",
''',
    '''  "provider",
  "oauth",
  "subagent",
  "paseo",
''',
)

print("RC8_PROVIDER_SCOPE_COPY_APPLIED")
