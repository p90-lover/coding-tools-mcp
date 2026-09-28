"""Preserve existing integrations; materialize bounded paired-release changes."""
from pathlib import Path
import os,shutil,subprocess
EXT='b0d4db553227fa3c7300050b8edff6e2eb9afee4'
BRANCH='release/main-extension-0.4.3-rc.3'
changed=[]
def once(text,old,new):
    assert text.count(old)==1,(old[:100],text.count(old))
    return text.replace(old,new,1)
def save(name,text):
    p=Path(name)
    if p.read_text(encoding='utf-8')==text:return
    dest=Path('aiTemp/Trash/paired-before')/os.environ['GITHUB_RUN_ID']/p
    dest.parent.mkdir(parents=True,exist_ok=True)
    assert not dest.exists() and not p.is_symlink()
    shutil.copy2(p,dest);p.write_text(text,encoding='utf-8');changed.append(str(p))

p=Path('aiTemp/oauth-popup/http_flow.rs');s=p.read_text(encoding='utf-8')
if 'let fixture_dir =' not in s:
    s=once(s,'    std::fs::create_dir_all("aiTemp/oauth-popup").unwrap();','''    // Cargo tests run in src-tauri; packaging runs at repository root.
    let fixture_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().expect("desktop crate must have a repository parent")
        .join("aiTemp/oauth-popup");
    std::fs::create_dir_all(&fixture_dir).unwrap();''')
    s=once(s,'        "aiTemp/oauth-popup/browser-fixture.json",','        fixture_dir.join("browser-fixture.json"),')
if 'profiles_fixture' not in s:
    s=once(s,'    assert!(!browser_snapshot.is_null());','''    assert!(!browser_snapshot.is_null());
    // Serialize the real Desktop settings types using synthetic values only.
    // The extension contract check consumes this JSON, not a hand-invented schema.
    let mut data = crate::data::AppData::default();
    let mut profile = crate::workspace::WorkspaceProfile::new("fixture-workspace".into(), None);
    profile.id = "extension-fixture".into();
    profile.auth.auth_type = "oauth".into();
    profile.auth.oauth_client_id = client_id.into();
    profile.auth.use_shared_secrets = false;
    profile.tunnel.public_url = "https://old-popup.example".into();
    data.last_workspace_id = profile.id.clone();
    data.workspace_secrets.insert(profile.id.clone(), HashMap::from([
        ("oauth_password".into(), "fixture-password-not-real".into()),
        ("oauth_client_secret".into(), "fixture-secret-not-real".into()),
    ]));
    data.profiles.push(profile);
    browser_snapshot["profiles_fixture"] = serde_json::to_value(&data).unwrap();
    data.profiles[0].auth.use_shared_secrets = true;
    data.shared_secrets = HashMap::from([
        ("oauth_client_id".into(), "fixture-shared-client".into()),
        ("oauth_password".into(), "fixture-shared-password".into()),
        ("oauth_client_secret".into(), "fixture-shared-secret".into()),
    ]);
    browser_snapshot["shared_profiles_fixture"] = serde_json::to_value(&data).unwrap();''')
save(p,s)

p=Path('aiTemp/oauth-popup/csp_prepare.py');s=p.read_text(encoding='utf-8')
if 'let fixture_dir =' not in s:
    s=once(s,'    std::fs::create_dir_all("aiTemp/oauth-popup").unwrap();','''    let fixture_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent()
        .expect("desktop crate must have a repository parent").join("aiTemp/oauth-popup");
    std::fs::create_dir_all(&fixture_dir).unwrap();''')
    s=once(s,'std::fs::write("aiTemp/oauth-popup/browser-fixture.json",','std::fs::write(fixture_dir.join("browser-fixture.json"),')
save(p,s)

p=Path('aiTemp/oauth-popup/publish.py');s=p.read_text(encoding='utf-8')
if 'paired_extension' not in s:
    s=once(s,"BRANCH='fix/oauth-popup-0.4.3-rc.3'",f"BRANCH='{BRANCH}'")
    s=once(s,"download('oauth-popup-browser-evidence-'+RUN,root/'browser')", "download('oauth-popup-browser-evidence-'+RUN,root/'browser')\ndownload('oauth-popup-extension-'+RUN,root/'extension')")
    marker="assets=root/'assets';assets.mkdir();shutil.copy2(binary,assets/name)"
    s=once(s,marker,marker+f'''
paired_extension=json.loads((root/'extension/extension-proof.json').read_text())
assert paired_extension['source_commit']=='{EXT}' and paired_extension['version']=='0.0.7'
assert paired_extension['desktop_source']==SOURCE and paired_extension['workflow_run']==int(RUN)
assert paired_extension['focused_groups_passed']==4 and paired_extension['model_requests']==0
assert browser['extension_source']==paired_extension['source_commit'] and browser['extension_helper_replayed']
assert browser['profile_contract_checked'] and browser['sender_boundary']=='synthetic Chrome runtime; production helper and worker code'
ext_name='coding-tools-mcp-extension-v0.0.7.zip'
ext_zip=root/'extension'/ext_name
assert digest(ext_zip)==paired_extension['sha256'] and ext_zip.stat().st_size==paired_extension['size']
shutil.copy2(ext_zip,assets/ext_name)
''')
    s=once(s,"'browser':browser,'live_chatgpt_account_verified':False", "'browser':browser,'extension':paired_extension,'live_chatgpt_account_verified':False")
    s=once(s,'assert len(files)==4','assert len(files)==5')
    s=once(s,'— OAuth popup and callback repair','— OAuth popup and extension compatibility')
save(p,s)

p=Path('docs/releases/v0.4.3-rc.3.md');s=p.read_text(encoding='utf-8')
if 'Paired extension v0.0.7' not in s:
    english='''Paired extension v0.0.7 is included as `coding-tools-mcp-extension-v0.0.7.zip`, built from immutable source `'''+EXT+'''`. It no longer treats the unchanged parent ChatGPT tab or a merely created app as OAuth completion. Password delivery checks Chrome's real sender, top-level frame, popup opener, client, S256 and callback parameters. Unlinked/noopener windows require manual password entry. Callback state and tab must match, and completion requires an explicit Connected/Disconnect state for this exact app. Repeated Connect clicks stop after submission. Content scripts cannot invoke extension-only local-credential reads. The paired pipeline runs four focused worker/DOM groups, consumes settings JSON serialized by the real Rust Desktop types, and runs the exact extension form helper against the recorded production consent page in Chromium. Chrome messaging is explicitly synthetic in this replay; a real account is not contacted and tool execution is not inferred.

The installer evidence-path failure is corrected by resolving the fixture from Cargo's manifest directory rather than the test process working directory. No release gate is removed. Existing core/advanced catalogs, native-command consent, computer controls, vision memory and integration adapters remain. Autonomous Paseo/Anneal engines and the broader sandbox/file audit are not represented as completed.

Install the paired EXE, fully exit/restart Desktop, then reload the extension and existing ChatGPT tabs once. Keep settings and site permissions. The settings file is in the app's configuration data directory, not necessarily beside the EXE; use the existing extension path override for a nonstandard executable location. No public credential endpoint is added.

'''
    chinese='''配對擴充功能 v0.0.7 以 `coding-tools-mcp-extension-v0.0.7.zip` 提供，固定原始碼為 `'''+EXT+'''`。不再把未改變的 ChatGPT 主分頁或僅已建立的應用程式當成 OAuth 完成。密碼傳送會核對 Chrome 真正訊息來源、頂層畫面、彈窗開啟者、Client、S256 及回呼參數；無法驗證開啟者的彈窗須手動輸入密碼。回呼 State／分頁必須相符，並須在指定應用程式觀察到已連線／中斷連線狀態才完成。送出後停止重複 Connect；內容腳本不能呼叫擴充功能介面專用的本機密鑰讀取。配對流程執行四項工作狀態／DOM 重點測試，使用真正 Rust Desktop 型別序列化的設定 JSON，並在 Chromium 用指定擴充功能助手操作正式程式產生的同意表單。Chrome 訊息邊界明確使用模擬，不接觸真實帳戶，也不推斷工具已執行。

安裝程式證據路徑錯誤已改為從 Cargo Manifest 目錄定位測試資料，不再依賴測試程序工作目錄；沒有移除發佈驗證關卡。既有 Core／Advanced 目錄、原生命令同意、電腦控制、視覺記憶及整合轉接器均保留；不會把 Paseo／Anneal 自主執行引擎或更廣泛的沙箱／檔案稽核宣稱為完成。

安裝配對 EXE 後完全退出並重新啟動 Desktop，再重新載入擴充功能及已開啟的 ChatGPT 分頁一次。保留設定及網站權限。設定檔在應用程式設定資料目錄，不一定在 EXE 旁；執行檔位置非標準時使用擴充功能既有的路徑覆寫，不會新增公開密鑰端點。

'''
    s=once(s,'References checked 2026-09-10:',english+'References checked 2026-09-10:')
    s=once(s,'參考資料（2026-09-10 查閱）：',chinese+'參考資料（2026-09-10 查閱）：').replace('带有所述','帶有所述')
save(p,s)
subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true','aiTemp/oauth-popup/http_flow.rs'],check=True)
subprocess.run(['git','add','--','aiTemp/oauth-popup/http_flow.rs','aiTemp/oauth-popup/csp_prepare.py','aiTemp/oauth-popup/publish.py','docs/releases/v0.4.3-rc.3.md'],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
