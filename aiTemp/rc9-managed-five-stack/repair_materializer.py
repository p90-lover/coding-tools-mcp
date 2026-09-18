from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "aiTemp/rc9-managed-five-stack/apply_integration.py"

text = TARGET.read_text(encoding="utf-8")

old_guard = "if new in text and old not in text:"
new_guard = "if new in text:"
if old_guard in text:
    text = text.replace(old_guard, new_guard, 1)
elif new_guard not in text:
    raise SystemExit("replace_once guard was not found")

helper_marker = "def insert_before_once("
if helper_marker not in text:
    insertion_anchor = "\n\nreplace_once(\n    \"desktop-electron/electron/managed-components.cjs\","
    if text.count(insertion_anchor) != 1:
        raise SystemExit("managed-components insertion anchor was not unique")
    helper = '''


def insert_before_once(relative: str, anchor: str, block: str, sentinel: str) -> None:
    path = ROOT / relative
    current = path.read_text(encoding="utf-8")
    if sentinel in current:
        print(f"already patched: {relative}")
        return
    count = current.count(anchor)
    if count != 1:
        raise SystemExit(f"expected exactly one insertion anchor in {relative}, found {count}: {anchor[:120]!r}")
    path.write_text(current.replace(anchor, block + anchor, 1), encoding="utf-8")
    print(f"patched: {relative}")
'''
    text = text.replace(insertion_anchor, helper + insertion_anchor, 1)

old_start = '''replace_once(
    "desktop-electron/electron/main.cjs",
    \'\'\'  handle("launcher:external-service-configure", (event, serviceId, input) => {\n\'\'\','''
start = text.find(old_start)
new_call_marker = '''insert_before_once(
    "desktop-electron/electron/main.cjs",
    \'\'\'  handle("launcher:external-services-snapshot", (event) => {\n\'\'\','''

if start >= 0:
    end_anchor = '''

replace_once(
    "desktop-electron/electron/preload.cjs",'''
    end = text.find(end_anchor, start)
    if end < 0:
        raise SystemExit("preload replacement anchor was not found after the IPC block")
    new_call = '''insert_before_once(
    "desktop-electron/electron/main.cjs",
    \'\'\'  handle("launcher:external-services-snapshot", (event) => {\n\'\'\',
    \'\'\'  handle("launcher:managed-components-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.managedComponentsSnapshot();
  });
  handle("launcher:managed-component-install", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.installManagedComponent(serviceId);
  });
  handle("launcher:managed-component-repair", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.repairManagedComponent(serviceId);
  });
\'\'\',
    "launcher:managed-components-snapshot",
)'''
    text = text[:start] + new_call + text[end:]
elif new_call_marker not in text:
    raise SystemExit("managed IPC materializer block was not found")

TARGET.write_text(text, encoding="utf-8")
print("repaired idempotent rc.9 materializer")
