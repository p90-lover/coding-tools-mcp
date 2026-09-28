from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "desktop-electron/src/features/ProviderHubSurface.tsx"


def replace_exact(text: str, old: str, new: str, expected: int = 1) -> str:
    count = text.count(old)
    if count == 0 and new in text:
        print(f"already applied: {old[:70]!r}")
        return text
    if count != expected:
        raise SystemExit(f"expected {expected} matches, found {count}: {old[:120]!r}")
    return text.replace(old, new)


source = PATH.read_text(encoding="utf-8")

source = replace_exact(
    source,
    '''function text(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}
''',
    '''function text(
  language: Language,
  english: string,
  traditionalChinese: string,
  simplifiedChinese = traditionalChinese,
  japanese = english,
): string {
  if (language === "zh-TW") return traditionalChinese;
  if (language === "zh-CN") return simplifiedChinese;
  if (language === "ja") return japanese;
  return english;
}

function authLabel(language: Language, auth: ProviderAuth): string {
  switch (auth) {
    case "oauth": return "OAuth";
    case "api_key": return "API Key";
    case "browser_session": return text(language, "Browser session", "瀏覽器工作階段", "浏览器会话", "ブラウザーセッション");
    case "local_proxy": return text(language, "Local / reverse proxy", "本機／反向代理", "本地／反向代理", "ローカル／リバースプロキシ");
  }
}

function statusLabel(language: Language, status: ProviderAccountStatus): string {
  switch (status) {
    case "pending": return text(language, "Pending login", "等待登入", "等待登录", "ログイン待ち");
    case "connected": return text(language, "Connected", "已連線", "已连接", "接続済み");
    case "expired": return text(language, "Expired", "已過期", "已过期", "期限切れ");
    case "error": return text(language, "Error", "錯誤", "错误", "エラー");
    case "disabled": return text(language, "Disabled", "已停用", "已停用", "無効");
  }
}
''',
)

source = replace_exact(
    source,
    '''function accountBadge(account: ProviderAccountRecord): string[] {
  const values = [account.auth.replaceAll("_", " "), account.status];
  if (account.isDefault) values.push("default");
  if (account.hasCredential) values.push("credential stored");
  return values;
}
''',
    '''function accountBadge(language: Language, account: ProviderAccountRecord): string[] {
  const values = [authLabel(language, account.auth), statusLabel(language, account.status)];
  if (account.isDefault) values.push(text(language, "Default", "預設", "默认", "既定"));
  if (account.hasCredential) {
    values.push(text(language, "Credential stored", "憑證已儲存", "凭证已保存", "認証情報を保存済み"));
  }
  return values;
}
''',
)

source = replace_exact(
    source,
    'setError("Provider Hub is unavailable in this window");',
    'setError(text(language, "Provider Hub is unavailable in this window.", "此視窗無法使用供應商中心。", "此窗口无法使用供应商中心。", "このウィンドウではプロバイダーハブを利用できません。"));',
)
source = replace_exact(
    source,
    'if (!api) throw new Error("Provider Hub is unavailable in this window");',
    'if (!api) throw new Error(text(language, "Provider Hub is unavailable in this window.", "此視窗無法使用供應商中心。", "此窗口无法使用供应商中心。", "このウィンドウではプロバイダーハブを利用できません。"));',
    expected=2,
)
source = replace_exact(source, '}, [adoptSnapshot]);', '}, [adoptSnapshot, language]);')
source = replace_exact(source, '}, [adoptSnapshot, setError]);', '}, [adoptSnapshot, language, setError]);')

source = replace_exact(
    source,
    'if (!draft.label.trim()) throw new Error("Account label is required");',
    'if (!draft.label.trim()) throw new Error(text(language, "Account label is required.", "必須輸入帳戶名稱。", "必须输入账户名称。", "アカウント名を入力してください。"));',
)
source = replace_exact(
    source,
    'if (!saved) throw new Error("Provider Hub saved the account but did not return it");',
    'if (!saved) throw new Error(text(language, "Provider Hub saved the account but did not return it.", "供應商中心已儲存帳戶，但未有回傳帳戶資料。", "供应商中心已保存账户，但未返回账户数据。", "プロバイダーハブはアカウントを保存しましたが、データを返しませんでした。"));',
)
source = replace_exact(
    source,
    'if (!launcher || !api) throw new Error("Coding Tools execution bridge is unavailable");',
    'if (!launcher || !api) throw new Error(text(language, "Coding Tools execution bridge is unavailable.", "Coding Tools 執行橋接目前無法使用。", "Coding Tools 执行桥接当前无法使用。", "Coding Tools 実行ブリッジを利用できません。"));',
)
source = replace_exact(
    source,
    'if (!selectedAccount) throw new Error("Save and select a Provider Hub account first");',
    'if (!selectedAccount) throw new Error(text(language, "Save and select a Provider Hub account first.", "請先儲存並選擇供應商中心帳戶。", "请先保存并选择供应商中心账户。", "先にプロバイダーハブのアカウントを保存して選択してください。"));',
)
source = replace_exact(
    source,
    'if (!workspaceId) throw new Error("Select a workspace before connecting a provider");',
    'if (!workspaceId) throw new Error(text(language, "Select a workspace before connecting a provider.", "連接供應商之前，請先選擇工作區。", "连接供应商之前，请先选择工作区。", "プロバイダーを接続する前にワークスペースを選択してください。"));',
)
source = replace_exact(
    source,
    'throw new Error("The selected Provider Hub account must be enabled and connected");',
    'throw new Error(text(language, "The selected Provider Hub account must be enabled and connected.", "所選供應商中心帳戶必須已啟用及連線。", "所选供应商中心账户必须已启用并连接。", "選択したプロバイダーハブのアカウントを有効化して接続してください。"));',
)
source = replace_exact(
    source,
    'if (!model) throw new Error("Select or enter a model for this account");',
    'if (!model) throw new Error(text(language, "Select or enter a model for this account.", "請為此帳戶選擇或輸入模型。", "请为此账户选择或输入模型。", "このアカウントのモデルを選択または入力してください。"));',
)
source = replace_exact(
    source,
    'throw new Error("Anneal requires project, repository and assigned agent IDs");',
    'throw new Error(text(language, "Anneal requires project, repository, and assigned-agent IDs.", "Anneal 需要專案、儲存庫及指派代理 ID。", "Anneal 需要项目、仓库和指定代理 ID。", "Anneal にはプロジェクト、リポジトリ、担当エージェントの ID が必要です。"));',
)

source = replace_exact(source, 'account.identity || account.auth.replaceAll("_", " ")', 'account.identity || authLabel(language, account.auth)')
source = replace_exact(source, 'accountBadge(account).map', 'accountBadge(language, account).map')
source = replace_exact(source, '{selectedAccount?.status ?? draft.status}', '{statusLabel(language, selectedAccount?.status ?? draft.status)}')
source = replace_exact(source, '{AUTH_TYPES.map((auth) => <option key={auth} value={auth}>{auth.replaceAll("_", " ")}</option>)}', '{AUTH_TYPES.map((auth) => <option key={auth} value={auth}>{authLabel(language, auth)}</option>)}')
source = replace_exact(source, '{ACCOUNT_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}', '{ACCOUNT_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(language, status)}</option>)}')

source = replace_exact(
    source,
    '<label><span>Anneal project ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>',
    '<label><span>{text(language, "Anneal project ID", "Anneal 專案 ID", "Anneal 项目 ID", "Anneal プロジェクト ID")}</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>',
)
source = replace_exact(
    source,
    '<label><span>Anneal repository ID</span><input value={repoId} onChange={(event) => setRepoId(event.target.value)} /></label>',
    '<label><span>{text(language, "Anneal repository ID", "Anneal 儲存庫 ID", "Anneal 仓库 ID", "Anneal リポジトリ ID")}</span><input value={repoId} onChange={(event) => setRepoId(event.target.value)} /></label>',
)
source = replace_exact(
    source,
    '<label className="full-row"><span>Anneal assigned agent ID</span><input value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} /></label>',
    '<label className="full-row"><span>{text(language, "Anneal assigned agent ID", "Anneal 指派代理 ID", "Anneal 指定代理 ID", "Anneal 担当エージェント ID")}</span><input value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} /></label>',
)

PATH.write_text(source, encoding="utf-8")
print(f"patched {PATH}")
