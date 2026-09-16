from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "desktop-electron/src/providers/ProviderHubIntegration.tsx"


def replace_once(text: str, old: str, new: str) -> str:
    if new in text and old not in text:
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, found {count}: {old[:120]!r}")
    return text.replace(old, new, 1)


source = PATH.read_text(encoding="utf-8")
source = replace_once(
    source,
    "import type {\n  ProviderAccountInput,",
    "import type {\n  Language,\n  ProviderAccountInput,",
)
source = replace_once(
    source,
    'type ProviderLocale = "en" | "zh-TW";\ntype ManagerView = "accounts" | "proxies";\n',
    '''type ProviderLocale = "en" | "zh-TW";
type ManagerView = "accounts" | "proxies";

function providerLocale(language: Language | null): ProviderLocale {
  return language === "zh-TW" || language === "zh-CN" ? "zh-TW" : "en";
}
''',
)
source = replace_once(
    source,
    '''  const [locale, setLocale] = useState<ProviderLocale>(() => {
    const saved = window.localStorage.getItem("coding-tools-provider-locale");
    if (saved === "en" || saved === "zh-TW") return saved;
    return navigator.language.toLowerCase().includes("zh") ? "zh-TW" : "en";
  });
  const copy = COPY[locale];
''',
    '''  const [locale, setLocale] = useState<ProviderLocale>("en");
  const copy = COPY[locale];

  useEffect(() => {
    let cancelled = false;
    void api?.snapshot()
      .then((snapshot) => {
        if (!cancelled) setLocale(providerLocale(snapshot.state.language));
      })
      .catch(() => undefined);
    const unsubscribe = api?.onStateChanged((state) => {
      setLocale(providerLocale(state.language));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
''',
)
source = replace_once(
    source,
    '''  const changeLocale = () => {
    const next = locale === "en" ? "zh-TW" : "en";
    window.localStorage.setItem("coding-tools-provider-locale", next);
    setLocale(next);
  };
''',
    '''  const changeLocale = () => {
    const next: Language = locale === "en" ? "zh-TW" : "en";
    void api?.setLanguage(next)
      .then(() => setLocale(providerLocale(next)))
      .catch(() => undefined);
  };
''',
)

if "coding-tools-provider-locale" in source or "navigator.language" in source:
    raise SystemExit("legacy Provider Hub locale source remains")
if "api?.onStateChanged" not in source or "api?.setLanguage" not in source:
    raise SystemExit("canonical launcher language bridge is missing")

PATH.write_text(source, encoding="utf-8")
print("PROVIDER_HUB_CANONICAL_LOCALE_OK")
