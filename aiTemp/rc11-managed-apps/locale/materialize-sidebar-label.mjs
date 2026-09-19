import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const target = path.resolve(process.cwd(), "desktop-electron/src/App.tsx");
const source = fs.readFileSync(target, "utf8");
const before = 'label={language === "zh-TW" ? "受管理應用程式" : "Managed Apps"}';
const after = `label={language === "zh-TW"
                    ? "受管理應用程式"
                    : language === "zh-CN"
                      ? "托管应用"
                      : language === "ja"
                        ? "管理対象アプリ"
                        : "Managed Apps"}`;

if (source.includes(after)) {
  process.stdout.write("RC11_MANAGED_APPS_LOCALE_ALREADY_MATERIALIZED\n");
  process.exit(0);
}

const occurrences = source.split(before).length - 1;
if (occurrences !== 1) {
  throw new Error(`Expected one Managed Apps sidebar label anchor, found ${occurrences}`);
}

fs.writeFileSync(target, source.replace(before, after), "utf8");
process.stdout.write("RC11_MANAGED_APPS_LOCALE_MATERIALIZED\n");
