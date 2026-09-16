from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count == 0:
        if new in text:
            return
        raise SystemExit(f"{relative}: neither old nor replacement text was found: {old[:80]!r}")
    if count != 1:
        raise SystemExit(f"{relative}: expected one match, found {count}: {old[:80]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_count(relative: str, old: str, new: str, expected: int) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count == 0:
        if text.count(new) == expected:
            return
        raise SystemExit(f"{relative}: neither expected old nor replacement blocks were found")
    if count != expected:
        raise SystemExit(f"{relative}: expected {expected} matches, found {count}: {old[:80]!r}")
    path.write_text(text.replace(old, new), encoding="utf-8")


replace_once(
    "desktop-electron/src/types.ts",
    'export type Language = "en" | "zh-CN" | "ja";',
    'export type Language = "en" | "zh-CN" | "zh-TW" | "ja";',
)

zh_cn_option = '''              <WelcomeOption
                active={selectedLanguage === "zh-CN"}
                detail={localized.chinese}
                label={localized.chinese}
                marker="简"
                onClick={() => setSelectedLanguage("zh-CN")}
              />'''
zh_tw_option = zh_cn_option + '''
              <WelcomeOption
                active={selectedLanguage === "zh-TW"}
                detail={localized.traditionalChinese}
                label={localized.traditionalChinese}
                marker="繁"
                onClick={() => setSelectedLanguage("zh-TW")}
              />'''
replace_once("desktop-electron/src/App.tsx", zh_cn_option, zh_tw_option)
replace_once(
    "desktop-electron/src/App.tsx",
    '          disabled={busy || (stage === "support" && (!snapshot.state.githubOpened || !snapshot.state.xOpened))}',
    '          disabled={busy}',
)
replace_once(
    "desktop-electron/src/App.tsx",
    '''    { label: copy.chinese, value: "zh-CN" },
    { label: copy.japanese, value: "ja" },''',
    '''    { label: copy.chinese, value: "zh-CN" },
    { label: copy.traditionalChinese, value: "zh-TW" },
    { label: copy.japanese, value: "ja" },''',
)
replace_once(
    "desktop-electron/src/App.tsx",
    '''language === "ja" ? "ja-JP" : language === "zh-CN" ? "zh-CN" : "en"''',
    '''language === "ja" ? "ja-JP" : language === "zh-TW" ? "zh-TW" : language === "zh-CN" ? "zh-CN" : "en"''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    'const GITHUB_URL = "https://github.com/miuuyy/codex-chatgpt-web";',
    'const GITHUB_URL = "https://github.com/p90-lover/coding-tools-mcp";',
)
replace_once(
    "desktop-electron/electron/main.cjs",
    'const X_URL = "https://x.com/miu21590";',
    'const X_URL = "https://x.com/GIBUSHAT";',
)
replace_once(
    "desktop-electron/electron/main.cjs",
    '''  "zh-CN": Object.freeze({
    openLauncher: "打开 Codex Web GPT",
    quit: "退出",
    exportDiagnostics: "导出隐私安全诊断",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Web GPT",
    removeMessage: "从 Codex 中移除 ChatGPT Web 模型并恢复此前的模型路由？",
    removeDetail: "启动器中的 ChatGPT 登录 profile 会保留。Codex 需要重启一次。",
  }),
  ja: Object.freeze({''',
    '''  "zh-CN": Object.freeze({
    openLauncher: "打开 Codex Web GPT",
    quit: "退出",
    exportDiagnostics: "导出隐私安全诊断",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Web GPT",
    removeMessage: "从 Codex 中移除 ChatGPT Web 模型并恢复此前的模型路由？",
    removeDetail: "启动器中的 ChatGPT 登录 profile 会保留。Codex 需要重启一次。",
  }),
  "zh-TW": Object.freeze({
    openLauncher: "開啟 Codex Web GPT",
    quit: "結束",
    exportDiagnostics: "匯出已保護私隱的診斷資料",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Web GPT",
    removeMessage: "從 Codex 移除 ChatGPT Web 模型並還原先前的模型路由？",
    removeDetail: "啟動器中的 ChatGPT 登入 profile 會保留。Codex 需要重新啟動一次。",
  }),
  ja: Object.freeze({''',
)
replace_once(
    "desktop-electron/electron/main.cjs",
    '''function validateLanguage(value) {
  if (value !== "en" && value !== "zh-CN" && value !== "ja") {
    throw new Error("Language must be en, zh-CN, or ja");
  }
  return value;
}''',
    '''function validateLanguage(value) {
  if (value !== "en" && value !== "zh-CN" && value !== "zh-TW" && value !== "ja") {
    throw new Error("Language must be en, zh-CN, zh-TW, or ja");
  }
  return value;
}''',
)
replace_once(
    "desktop-electron/electron/main.cjs",
    '''    const current = stateStore.read();
    if (!current.githubOpened || !current.xOpened) throw new Error("Open the GitHub and X pages before continuing");
    if (current.autoStart) setAutostart(app, true);''',
    '''    const current = stateStore.read();
    if (current.autoStart) setAutostart(app, true);''',
)
replace_once(
    "desktop-electron/electron/state.cjs",
    '''    if (state.language !== null && state.language !== "en" && state.language !== "zh-CN" && state.language !== "ja") {''',
    '''    if (state.language !== null && state.language !== "en" && state.language !== "zh-CN" && state.language !== "zh-TW" && state.language !== "ja") {''',
)

replace_once(
    "desktop-electron/src/i18n.ts",
    'import type { Language } from "./types";',
    'import zhTWOverrides from "./i18n/locales/zh-TW";\nimport type { Language } from "./types";',
)
replace_count(
    "desktop-electron/src/i18n.ts",
    '  chinese: "简体中文",\n  japanese:',
    '  chinese: "简体中文",\n  traditionalChinese: "繁體中文",\n  japanese:',
    3,
)
replace_once(
    "desktop-electron/src/i18n.ts",
    '''export type Copy = typeof en;

export function copyFor(language: Language): Copy {''',
    '''export type Copy = typeof en;

const zhTW = {
  ...zh,
  ...zhTWOverrides,
} as Copy;

export function copyFor(language: Language): Copy {''',
)
replace_once(
    "desktop-electron/src/i18n.ts",
    '''  if (language === "zh-CN") return zh as Copy;
  if (language === "ja") return ja as Copy;''',
    '''  if (language === "zh-CN") return zh as Copy;
  if (language === "zh-TW") return zhTW;
  if (language === "ja") return ja as Copy;''',
)

print("Applied rc.2 onboarding, owner links, and Traditional Chinese wiring.")
