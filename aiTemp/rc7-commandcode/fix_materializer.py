from pathlib import Path

path = Path(__file__).with_name("apply_commandcode.py")
text = path.read_text(encoding="utf-8")

ambiguous = """replace_once(
    \"desktop-electron/electron/provider-network.cjs\",
    '''    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
''',
    '''    if (account.providerId === COMMANDCODE_PROVIDER_ID) {
      return startCommandCodeLogin(account);
    }
    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
''',
)
"""

safe = """replace_once(
    \"desktop-electron/electron/provider-network.cjs\",
    '''  async function openProviderLogin(accountId) {
    const account = accountRecord(accountId);
    if (account.providerId === \"chatgpt-web\" || account.providerId === \"codex-oauth\") {
      const browser = await getBrowserHost()?.openLogin();
      return { opened: true, mode: \"embedded\", browser: browser || null };
    }
    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
''',
    '''  async function openProviderLogin(accountId) {
    const account = accountRecord(accountId);
    if (account.providerId === \"chatgpt-web\" || account.providerId === \"codex-oauth\") {
      const browser = await getBrowserHost()?.openLogin();
      return { opened: true, mode: \"embedded\", browser: browser || null };
    }
    if (account.providerId === COMMANDCODE_PROVIDER_ID) {
      return startCommandCodeLogin(account);
    }
    if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
''',
)
"""

if safe in text:
    print("RC7_COMMANDCODE_MATERIALIZER_ALREADY_FIXED")
elif text.count(ambiguous) == 1:
    path.write_text(text.replace(ambiguous, safe, 1), encoding="utf-8")
    print("RC7_COMMANDCODE_MATERIALIZER_FIXED")
else:
    raise SystemExit(
        "expected exactly one legacy CommandCode materializer block; "
        f"legacy={text.count(ambiguous)} safe={text.count(safe)}"
    )
