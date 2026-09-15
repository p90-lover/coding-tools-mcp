from pathlib import Path

runtime_build = Path("runtime-web/scripts/build-runtime-bundle.ts")
text = runtime_build.read_text(encoding="utf-8")
old_import = 'import { VERSION } from "../src/version";\n'
new_import = 'import { resolveRuntimeBundleAppVersion } from "../src/runtime-bundle-version";\nimport { VERSION } from "../src/version";\n'
if old_import in text:
    text = text.replace(old_import, new_import, 1)
elif new_import not in text:
    raise SystemExit("runtime bundle version import anchor missing")

old_check = 'if (packageJson.version !== VERSION) throw new Error("package.json and runtime version are out of sync");\n'
new_check = old_check + 'const bundleAppVersion = resolveRuntimeBundleAppVersion();\n'
if new_check not in text:
    if old_check not in text:
        raise SystemExit("runtime bundle version check anchor missing")
    text = text.replace(old_check, new_check, 1)

old_manifest = '  appVersion: VERSION,\n'
new_manifest = '  appVersion: bundleAppVersion,\n'
if old_manifest in text:
    text = text.replace(old_manifest, new_manifest, 1)
elif new_manifest not in text:
    raise SystemExit("runtime manifest appVersion anchor missing")
runtime_build.write_text(text, encoding="utf-8")

runtime_preparation = Path("desktop-electron/scripts/runtime-preparation.cjs")
text = runtime_preparation.read_text(encoding="utf-8")
old_env = '      env: process.env,\n'
new_env = '      env: { ...process.env, CODEX_CHATGPT_WEB_BUNDLE_APP_VERSION: layout.version },\n'
if old_env in text:
    text = text.replace(old_env, new_env, 1)
elif new_env not in text:
    raise SystemExit("desktop runtime preparation environment anchor missing")
runtime_preparation.write_text(text, encoding="utf-8")

desktop_manifest = Path("desktop-electron/package.json")
text = desktop_manifest.read_text(encoding="utf-8")
old_version = '  "version": "0.6.0-rc.1",\n'
new_version = '  "version": "0.7.0-rc.1",\n'
if old_version in text:
    text = text.replace(old_version, new_version, 1)
elif new_version not in text:
    raise SystemExit("desktop release version anchor missing")
desktop_manifest.write_text(text, encoding="utf-8")

print("CODEX_ROUTER_RELEASE_IDENTITY_PATCH_OK")
