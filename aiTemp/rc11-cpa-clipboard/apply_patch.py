from __future__ import annotations

from pathlib import Path


def replace_once(pathname: str, old: str, new: str) -> None:
    path = Path(pathname)
    source = path.read_text(encoding="utf-8")
    if new in source and old not in source:
        return
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"expected one CPA clipboard anchor in {pathname}, found {count}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


replace_once(
    "src-tauri/Cargo.toml",
    'tauri-plugin-dialog = "2"\n',
    'tauri-plugin-dialog = "2"\ntauri-plugin-clipboard-manager = "=2.3.3"\n',
)

replace_once(
    "src-tauri/src/lib.rs",
    "        .plugin(tauri_plugin_dialog::init())\n        .setup(|app| {",
    "        .plugin(tauri_plugin_dialog::init())\n        .plugin(tauri_plugin_clipboard_manager::init())\n        .setup(|app| {",
)

replace_once(
    "src-tauri/src/commands/five_stack.rs",
    "use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};\n",
    "use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};\nuse tauri_plugin_clipboard_manager::ClipboardExt;\n",
)

replace_once(
    "src-tauri/src/commands/five_stack.rs",
    '''#[tauri::command]\npub async fn five_stack_copy_cpa_management_key(window: WebviewWindow) -> AppResult<String> {\n    local_focused(&window)?;\n    five_stack::cpa_management_key()\n}\n''',
    '''#[derive(serde::Serialize)]\n#[serde(rename_all = "camelCase")]\npub struct CpaClipboardResult {\n    copied: bool,\n    length: usize,\n}\n\n#[tauri::command]\npub async fn five_stack_copy_cpa_management_key(\n    window: WebviewWindow,\n) -> AppResult<CpaClipboardResult> {\n    local_focused(&window)?;\n    let key = five_stack::cpa_management_key()?;\n    let length = key.len();\n    window\n        .clipboard()\n        .write_text(key)\n        .map_err(|error| AppError::Message(format!("Could not copy CPA management key: {error}")))?;\n    Ok(CpaClipboardResult {\n        copied: true,\n        length,\n    })\n}\n''',
)

replace_once(
    "src/lib/components/control-center/OriginalUiPanel.svelte",
    '''      <button class="cc-button" type="button" disabled={busy !== null} onclick={() => void run('copy-key', async () => {\n        const copied = await invoke<string>('five_stack_copy_cpa_management_key');\n        await navigator.clipboard.writeText(copied);\n        onNotice(t($locale, `CPA management key copied (${copied.length} chars). Paste it into the original login form.`, `已複製 CPA 管理金鑰（${copied.length} 字）。請貼到原始登入表單。`));\n      })}>{t($locale, 'Copy management key', '複製管理金鑰')}</button>''',
    '''      <button class="cc-button" type="button" disabled={busy !== null} onclick={() => void run('copy-key', async () => {\n        const copied = await invoke<{ copied: boolean; length: number }>('five_stack_copy_cpa_management_key');\n        if (!copied.copied) throw new Error('CPA management key was not copied');\n        onNotice(t($locale, `CPA management key copied (${copied.length} chars). Paste it into the original login form.`, `已複製 CPA 管理金鑰（${copied.length} 字）。請貼到原始登入表單。`));\n      })}>{t($locale, 'Copy management key', '複製管理金鑰')}</button>''',
)

print("RC11_CPA_PRIVILEGED_CLIPBOARD_PATCH_APPLIED")
