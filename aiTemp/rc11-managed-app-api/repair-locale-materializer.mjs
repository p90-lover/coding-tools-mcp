import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const target = path.resolve(
  process.cwd(),
  "aiTemp/rc11-managed-app-api/materialize.mjs",
);
const source = fs.readFileSync(target, "utf8");
const before = `  '{ id: "anneal", english: "Anneal", traditionalChinese: "Anneal" },',`;
const after = `  "const appByHandle = useMemo(",`;
const beforeCount = source.split(before).length - 1;
const afterCount = source.split(after).length - 1;

if (beforeCount === 0 && afterCount >= 2) {
  process.stdout.write("RC11_MANAGED_APP_LOCALE_MATERIALIZER_ALREADY_REPAIRED\n");
  process.exit(0);
}

if (beforeCount !== 1 || afterCount !== 1) {
  throw new Error(
    `Expected one locale-sensitive sentinel and one existing API sentinel, found ${beforeCount} and ${afterCount}`,
  );
}

fs.writeFileSync(target, source.replace(before, after), "utf8");
process.stdout.write("RC11_MANAGED_APP_LOCALE_MATERIALIZER_REPAIRED\n");
