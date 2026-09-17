import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function runCli(...args: string[]) {
  return Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("bundled CLI Codex Router integration", () => {
  test("exposes a router integration dry-run through the shipped entrypoint", () => {
    const result = runCli("router", "integrate");
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("Coding Tools will integrate providers through Codex Router");
    expect(stdout).toContain("coding-tools-web");
    expect(stdout).toContain("Dry run only");
  });

  test("can plan CommandCode Proxy without exposing provider or caller secrets", () => {
    const result = runCli("router", "integrate", "--with-commandcode-proxy");
    expect(result.exitCode).toBe(0);
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(output).toContain("commandcode-proxy");
    expect(output).not.toMatch(/user_[A-Za-z0-9_-]+/);
    expect(output).not.toMatch(/caller[_-]?key/i);
  });
});
