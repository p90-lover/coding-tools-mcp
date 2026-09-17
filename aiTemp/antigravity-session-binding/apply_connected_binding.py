from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "desktop-electron/electron/provider-network.cjs"

text = TARGET.read_text(encoding="utf-8")

before = '''    const selectedName = antigravityAuthFileName(selected);
    const selectedAuthIndex = antigravityAuthIndex(selected);
    store.mergeAccountSecret(account.id, {
      antigravityAuthName: selectedName,
      antigravityAuthIndex: selectedAuthIndex,
    });

    const detail = `${selected.status ?? ""} ${selected.status_message ?? ""}`.trim();
    let status = "connected";
    if (selected.disabled === true) status = "disabled";
    else if (providerSessionFailureStatus(detail) === "expired") status = "expired";
    else if (selected.unavailable === true || /error|failed|invalid/i.test(detail)) status = "error";

    let models = Array.isArray(account.models) ? account.models : [];
'''

after = '''    const selectedName = antigravityAuthFileName(selected);
    const selectedAuthIndex = antigravityAuthIndex(selected);
    const detail = `${selected.status ?? ""} ${selected.status_message ?? ""}`.trim();
    let status = "connected";
    if (selected.disabled === true) status = "disabled";
    else if (providerSessionFailureStatus(detail) === "expired") status = "expired";
    else if (selected.unavailable === true || /error|failed|invalid/i.test(detail)) status = "error";

    if (status === "connected") {
      store.mergeAccountSecret(account.id, {
        antigravityAuthName: selectedName,
        antigravityAuthIndex: selectedAuthIndex,
      });
    }

    let models = Array.isArray(account.models) ? account.models : [];
'''

if after in text:
    print("ANTIGRAVITY_CONNECTED_BINDING_ALREADY_APPLIED")
elif before not in text:
    raise SystemExit("Missing Antigravity connected-binding anchor")
else:
    TARGET.write_text(text.replace(before, after, 1), encoding="utf-8")
    print("ANTIGRAVITY_CONNECTED_BINDING_APPLIED")
