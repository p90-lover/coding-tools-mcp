from pathlib import Path

path = Path(__file__).with_name("apply_commandcode.py")
text = path.read_text(encoding="utf-8")
old = '''replace_once(
    "desktop-electron/electron/provider-network.cjs",
    \'\'\'    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {\n
\'\'\',
    \'\'\'    if (account.providerId === COMMANDCODE_PROVIDER_ID) {\n
      return startCommandCodeLogin(account);\n
    }\n
    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {\n
\'\'\',
)
'''
new = '''replace_once(
    "desktop-electron/electron/provider-network.cjs",
    \'\'\'  async function openProviderLogin(accountId) {\n
    const account = accountRecord(accountId);\n
    if (account.providerId === "chatgpt-web" || account.providerId === "codex-oauth") {\n
      const browser = await getBrowserHost()?.openLogin();\n
      return { opened: true, mode: "embedded", browser: browser || null };\n
    }\n
    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {\n
\'\'\',
    \'\'\'  async function openProviderLogin(accountId) {\n
    const account = accountRecord(accountId);\n
    if (account.providerId === "chatgpt-web" || account.providerId === "codex-oauth") {\n
      const browser = await getBrowserHost()?.openLogin();\n
      return { opened: true, mode: "embedded", browser: browser || null };\n
    }\n
    if (account.providerId === COMMANDCODE_PROVIDER_ID) {\n
      return startCommandCodeLogin(account);\n
    }\n
    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {\n
\'\'\',
)
'''
if new in text:
    print("RC7_COMMANDCODE_MATERIALIZER_ALREADY_FIXED")
elif text.count(old) == 1:
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print("RC7_COMMANDCODE_MATERIALIZER_FIXED")
else:
    raise SystemExit(f"expected one ambiguous CommandCode patch block, found {text.count(old)}")
