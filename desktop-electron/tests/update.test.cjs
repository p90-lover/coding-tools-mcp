require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const {
  buildJob,
  compareVersions,
  createUpdateController,
  expectedChecksum,
  macApplicationPath,
  releaseAssetName,
  selectCompatibleRelease,
  validateReleaseAssetUrl,
} = require("../electron/update.cjs");

test("Linux auto-update fails closed without the stable installer wrapper", () => {
  const previousAppImage = process.env.CODEX_WEB_GPT_APPIMAGE;
  const previousWrapper = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  process.env.CODEX_WEB_GPT_APPIMAGE = "/opt/codex/Codex Web GPT.AppImage";
  delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  try {
    assert.throws(() => buildJob({
      version: "1.2.0",
      platform: "linux",
      executablePath: "/tmp/transient",
      assetPath: "/tmp/update.AppImage",
      stagingRoot: "/tmp/stage",
      tempRoot: "/tmp/update",
      logPath: "/tmp/update.log",
    }), /needs the install-launcher\.sh wrapper/);
  } finally {
    if (previousAppImage === undefined) delete process.env.CODEX_WEB_GPT_APPIMAGE;
    else process.env.CODEX_WEB_GPT_APPIMAGE = previousAppImage;
    if (previousWrapper === undefined) delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
    else process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = previousWrapper;
  }
});

test("release comparison and platform assets are strict", () => {
  assert.equal(compareVersions("1.1.5", "1.1.4"), 1);
  assert.equal(compareVersions("1.1.4", "1.1.4"), 0);
  assert.equal(compareVersions("1.1.3", "1.1.4"), -1);
  assert.equal(compareVersions("1.2.0", "1.1.99"), 1);
  assert.equal(compareVersions("0.7.0-rc.5", "0.7.0-rc.4"), 1);
  assert.equal(compareVersions("0.7.0", "0.7.0-rc.5"), 1);
  assert.equal(releaseAssetName("1.2.0", "darwin", "arm64"), "Coding.Tools_1.2.0_mac_arm64.zip");
  assert.equal(releaseAssetName("1.2.0", "darwin", "x64"), "Coding.Tools_1.2.0_mac_x64.zip");
  assert.equal(releaseAssetName("1.2.0", "win32", "x64"), "Coding.Tools_1.2.0_windows_x64_setup.exe");
  assert.equal(releaseAssetName("1.2.0", "linux", "x64"), "Coding.Tools_1.2.0_linux_x64.AppImage");
  assert.equal(releaseAssetName("1.2.0", "linux", "arm64"), null);
});

test("checksums and release URLs bind the exact expected asset", () => {
  const hash = "a".repeat(64);
  assert.equal(expectedChecksum(`${hash}  launcher.zip\n`, "launcher.zip"), hash);
  assert.throws(() => expectedChecksum(`${hash}  other.zip\n`, "launcher.zip"), /no entry/);
  assert.equal(
    validateReleaseAssetUrl(
      "https://github.com/p90-lover/coding-tools-mcp/releases/download/v1.2.0/launcher.zip",
      "1.2.0",
      "launcher.zip",
    ),
    "https://github.com/p90-lover/coding-tools-mcp/releases/download/v1.2.0/launcher.zip",
  );
  assert.throws(
    () => validateReleaseAssetUrl("https://example.com/launcher.zip", "1.2.0", "launcher.zip"),
    /unexpected release asset URL/,
  );
});

test("project updater selects the newest complete prerelease and ignores draft or incomplete releases", () => {
  const release = selectCompatibleRelease([
    {
      tag_name: "v0.7.0-rc.6",
      draft: true,
      assets: [],
    },
    {
      tag_name: "v0.7.0-rc.5",
      prerelease: true,
      assets: [
        {
          name: "Coding.Tools_0.7.0-rc.5_windows_x64_setup.exe",
          browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v0.7.0-rc.5/Coding.Tools_0.7.0-rc.5_windows_x64_setup.exe",
        },
        {
          name: "SHA256SUMS.txt",
          browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v0.7.0-rc.5/SHA256SUMS.txt",
        },
      ],
    },
    {
      tag_name: "v5.0.7",
      assets: [],
    },
  ], "win32", "x64");
  assert.equal(release?.version, "0.7.0-rc.5");
  assert.equal(release?.assetName, "Coding.Tools_0.7.0-rc.5_windows_x64_setup.exe");
});

test("macOS bundle resolution never guesses outside Contents/MacOS", () => {
  assert.equal(
    macApplicationPath("/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT"),
    "/Applications/Codex Web GPT.app",
  );
  assert.throws(() => macApplicationPath("/tmp/Codex Web GPT"), /Could not resolve/);
});

test("startup check runs once and exposes only a newer complete release", async () => {
  let calls = 0;
  const published = [];
  const controller = createUpdateController({
    currentVersion: "1.1.4",
    platform: "linux",
    arch: "x64",
    packaged: true,
    executablePath: "/tmp/launcher",
    runtimeExecutable: "/tmp/bun",
    logsDirectory: "/tmp/logs",
    publish: (state) => published.push(state),
    dependencies: {
      fetchRelease: async () => {
        calls += 1;
        return {
          tag_name: "v1.2.0",
          assets: [
            {
              name: "Coding.Tools_1.2.0_linux_x64.AppImage",
              browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v1.2.0/Coding.Tools_1.2.0_linux_x64.AppImage",
            },
            {
              name: "SHA256SUMS.txt",
              browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v1.2.0/SHA256SUMS.txt",
            },
          ],
        };
      },
    },
  });
  assert.deepEqual(await controller.checkOnce(), { status: "available", version: "1.2.0" });
  assert.deepEqual(await controller.checkOnce(), { status: "available", version: "1.2.0" });
  assert.equal(calls, 1);
  assert.deepEqual(published.map((state) => state.status), ["checking", "available"]);
});

test("manual and periodic checks can discover a release published after startup", async () => {
  let latest = "1.1.4";
  let calls = 0;
  let periodicCallback = null;
  const controller = createUpdateController({
    currentVersion: "1.1.4",
    platform: "win32",
    arch: "x64",
    packaged: true,
    executablePath: "C:\\Coding Tools\\Coding Tools.exe",
    runtimeExecutable: process.execPath,
    logsDirectory: os.tmpdir(),
    dependencies: {
      fetchRelease: async () => {
        calls += 1;
        const version = latest;
        return [{
          tag_name: `v${version}`,
          prerelease: version.includes("-"),
          assets: [
            {
              name: `Coding.Tools_${version}_windows_x64_setup.exe`,
              browser_download_url: `https://github.com/p90-lover/coding-tools-mcp/releases/download/v${version}/Coding.Tools_${version}_windows_x64_setup.exe`,
            },
            {
              name: "SHA256SUMS.txt",
              browser_download_url: `https://github.com/p90-lover/coding-tools-mcp/releases/download/v${version}/SHA256SUMS.txt`,
            },
          ],
        }];
      },
    },
  });

  assert.equal((await controller.checkOnce()).status, "up-to-date");
  latest = "1.2.0";
  assert.equal((await controller.checkOnce()).status, "up-to-date", "startup check remains idempotent");
  assert.deepEqual(await controller.checkNow({ force: true }), { status: "available", version: "1.2.0" });

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (callback) => {
    periodicCallback = callback;
    return { unref() {} };
  };
  global.clearInterval = () => {};
  try {
    const periodic = controller.startPeriodicChecks({ intervalMs: 1_000 });
    latest = "1.3.0";
    await periodic.tick();
    assert.deepEqual(controller.getState(), { status: "available", version: "1.3.0" });
    assert.equal(typeof periodicCallback, "function");
    periodic.stop();
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
  assert.ok(calls >= 3);
});

test("verified update is handed to one detached worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-update-test-"));
  const oldAppImage = path.join(root, "versions", "1.1.4", "Codex Web GPT.AppImage");
  const wrapper = path.join(root, "bin", "codex-web-gpt");
  fs.mkdirSync(path.dirname(oldAppImage), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(oldAppImage, "old");
  fs.writeFileSync(wrapper, "old wrapper");
  const assetBody = Buffer.from("new appimage");
  const hash = require("node:crypto").createHash("sha256").update(assetBody).digest("hex");
  let spawned = null;
  const previousAppImage = process.env.CODEX_WEB_GPT_APPIMAGE;
  const previousWrapper = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  process.env.CODEX_WEB_GPT_APPIMAGE = oldAppImage;
  process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = wrapper;
  try {
    const controller = createUpdateController({
      currentVersion: "1.1.4",
      platform: "linux",
      arch: "x64",
      packaged: true,
      executablePath: "/tmp/launcher",
      runtimeExecutable: "/durable/bun",
      logsDirectory: path.join(root, "logs"),
      dependencies: {
        fetchRelease: async () => ({
          tag_name: "v1.2.0",
          assets: [
            {
              name: "Coding.Tools_1.2.0_linux_x64.AppImage",
              browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v1.2.0/Coding.Tools_1.2.0_linux_x64.AppImage",
            },
            {
              name: "SHA256SUMS.txt",
              browser_download_url: "https://github.com/p90-lover/coding-tools-mcp/releases/download/v1.2.0/SHA256SUMS.txt",
            },
          ],
        }),
        downloadText: async () => `${hash}  Coding.Tools_1.2.0_linux_x64.AppImage\n`,
        downloadFile: async (_url, destination) => fs.writeFileSync(destination, assetBody),
        sha256: (filePath) => require("node:crypto").createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
        spawnWorker: (runtime, worker, job) => {
          spawned = { runtime, worker, job, data: JSON.parse(fs.readFileSync(job, "utf8")) };
          return { pid: 123, unref() {}, kill() {} };
        },
      },
    });
    await controller.checkOnce();
    const launch = await controller.beginInstall();
    assert.equal(spawned.runtime, "/durable/bun");
    assert.equal(spawned.data.version, "1.2.0");
    assert.equal(spawned.data.target, oldAppImage);
    assert.equal(spawned.data.wrapper, wrapper);
    assert.equal(path.basename(spawned.data.runnerSource), "linux-appimage-runner.sh");
    assert.equal(fs.existsSync(spawned.data.runnerSource), true);
    assert.equal(controller.getState().status, "installing");
    controller.cancelInstall(launch);
    assert.equal(fs.existsSync(launch.tempRoot), false);
    assert.deepEqual(controller.getState(), { status: "available", version: "1.2.0" });
  } finally {
    if (previousAppImage === undefined) delete process.env.CODEX_WEB_GPT_APPIMAGE;
    else process.env.CODEX_WEB_GPT_APPIMAGE = previousAppImage;
    if (previousWrapper === undefined) delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
    else process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = previousWrapper;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detached worker replaces an installed Linux AppImage and removes the old version", {
  skip: process.platform === "win32" ? "Linux AppImage execution is not meaningful on Windows" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-worker-test-"));
  const jobRoot = path.join(root, "job");
  const versionsRoot = path.join(root, "versions");
  const oldTarget = path.join(versionsRoot, "1.1.4", "Codex Web GPT.AppImage");
  const newTarget = path.join(versionsRoot, "1.2.0", "Codex Web GPT.AppImage");
  const wrapper = path.join(root, "bin", "codex-web-gpt");
  const marker = path.join(root, "launched");
  const source = path.join(jobRoot, "update.AppImage");
  const runnerSource = path.join(jobRoot, "run-appimage");
  const logPath = path.join(root, "logs", "update-worker.log");
  fs.mkdirSync(path.dirname(oldTarget), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.writeFileSync(oldTarget, "old");
  fs.writeFileSync(wrapper, "old wrapper");
  fs.writeFileSync(source, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  fs.writeFileSync(runnerSource, "#!/bin/sh\ntarget=\"$1\"\nshift\nexec \"$target\" \"$@\"\n", { mode: 0o755 });
  const jobPath = path.join(jobRoot, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify({
    version: "1.2.0",
    platform: "linux",
    parentPid: 2_147_483_647,
    tempRoot: jobRoot,
    logPath,
    source,
    target: oldTarget,
    wrapper,
    runnerSource,
  }));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "electron", "update-worker.cjs"), jobPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(newTarget), true);
    assert.equal(fs.existsSync(path.dirname(oldTarget)), false);
    assert.match(fs.readFileSync(wrapper, "utf8"), /versions\/1\.2\.0\/Codex Web GPT\.AppImage/);
    assert.doesNotMatch(fs.readFileSync(wrapper, "utf8"), /APPIMAGE_EXTRACT_AND_RUN/);
    assert.equal(fs.existsSync(path.join(versionsRoot, "run-appimage")), true);
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    assert.equal(fs.readFileSync(marker, "utf8"), "launched");
    assert.match(fs.readFileSync(logPath, "utf8"), /installed and relaunched/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update downloads go through the app's network, follow redirects and report bytes", async () => {
  const update = require("../electron/update.cjs");
  const seen = [];
  update.useNativeUpdateTransport(async (url, options) => {
    seen.push([url, options.headers["User-Agent"]]);
    if (url.endsWith("/release.zip")) return new Response(null, { status: 302, headers: { location: "https://objects.example.test/blob" } });
    return new Response("packed bytes", { status: 200 });
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-native-"));
  try {
    let bytes = 0;
    const file = path.join(root, "pack");
    await update.downloadFile("https://github.com/p90-lover/coding-tools-mcp/releases/download/v1/release.zip", file, (count) => { bytes += count; });
    assert.equal(fs.readFileSync(file, "utf8"), "packed bytes");
    assert.equal(bytes, "packed bytes".length);
    assert.deepEqual(seen.map(([url]) => url), [
      "https://github.com/p90-lover/coding-tools-mcp/releases/download/v1/release.zip", "https://objects.example.test/blob",
    ]);
    assert.ok(seen.every(([, agent]) => agent === "coding-tools-launcher-updater"));
    assert.equal(await update.downloadText("https://api.github.com/x"), "packed bytes");
  } finally {
    update.useNativeUpdateTransport(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an update response other than 200 fails instead of saving its body", async (testContext) => {
  const update = require("../electron/update.cjs");
  const waits = [];
  testContext.mock.method(https, "get", () => assert.fail("HTTP errors must not fall back to Node"));
  update.setUpdateSleepForTests(async (milliseconds) => { waits.push(milliseconds); });
  update.useNativeUpdateTransport(async () => new Response("rate limited", { status: 403 }));
  try {
    await assert.rejects(update.downloadText("https://api.github.com/x"), /HTTP 403/);
    assert.equal(https.get.mock.callCount(), 0);
    assert.deepEqual(waits, []);
  } finally {
    update.useNativeUpdateTransport(null);
    update.setUpdateSleepForTests((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }
});

test("a lookup that fails (ENOTFOUND github.com) is retried before the update gives up", async () => {
  const update = require("../electron/update.cjs");
  const waits = [];
  update.setUpdateSleepForTests(async (ms) => { waits.push(ms); });
  let calls = 0;
  // The first try fails in the app's network and in Node's fallback (a closed local port), the
  // second succeeds: the user sees the update, not "getaddrinfo ENOTFOUND github.com".
  update.useNativeUpdateTransport(async () => {
    calls += 1;
    if (calls === 1) throw new Error("net::ERR_NAME_NOT_RESOLVED");
    return new Response("manifest", { status: 200 });
  });
  try {
    assert.equal(await update.downloadText("https://127.0.0.1:1/manifest.json"), "manifest");
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1000]);
  } finally {
    update.useNativeUpdateTransport(null);
    update.setUpdateSleepForTests((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
});

test("native DNS failures remain retryable when the Node fallback is blocked", async (testContext) => {
  for (const downloadKind of ["metadata", "file"]) {
    await testContext.test(downloadKind, async (subtest) => {
      const update = require("../electron/update.cjs");
      const waits = [];
      let nativeCalls = 0;
      let fallbackCalls = 0;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "update-blocked-fallback-"));
      subtest.after(() => {
        update.useNativeUpdateTransport(null);
        update.setUpdateSleepForTests((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
        fs.rmSync(directory, { recursive: true, force: true });
      });
      subtest.mock.method(https, "get", () => {
        fallbackCalls += 1;
        const request = new EventEmitter();
        request.setTimeout = () => request;
        process.nextTick(() => request.emit("error", Object.assign(new Error("connect EACCES"), { code: "EACCES" })));
        return request;
      });
      update.setUpdateSleepForTests(async (milliseconds) => { waits.push(milliseconds); });
      update.useNativeUpdateTransport(async () => {
        nativeCalls += 1;
        if (nativeCalls === 1) {
          const failure = downloadKind === "metadata"
            ? new Error("net::ERR_NAME_NOT_RESOLVED")
            : Object.assign(new Error("native lookup failed"), { code: "EAI_AGAIN" });
          throw failure;
        }
        return new Response("verified response", { status: 200 });
      });

      if (downloadKind === "metadata") {
        assert.equal(await update.downloadText("https://example.test/metadata.json"), "verified response");
      } else {
        const destination = path.join(directory, "pack.ctpack");
        await update.downloadFile("https://example.test/pack.ctpack", destination);
        assert.equal(fs.readFileSync(destination, "utf8"), "verified response");
      }
      assert.equal(nativeCalls, 2);
      assert.equal(fallbackCalls, 1);
      assert.deepEqual(waits, [1_000]);
    });
  }
});

test("dual transport failures preserve both causes and keep retries bounded", async (testContext) => {
  for (const nativeCode of ["EAI_AGAIN", "ERR_CERT_AUTHORITY_INVALID"]) {
    await testContext.test(nativeCode, async (subtest) => {
      const update = require("../electron/update.cjs");
      const waits = [];
      const nativeFailure = Object.assign(new Error("native transport failed"), { code: nativeCode });
      const fallbackFailure = Object.assign(new Error("connect EACCES"), { code: "EACCES" });
      let nativeCalls = 0;
      let fallbackCalls = 0;
      subtest.after(() => {
        update.useNativeUpdateTransport(null);
        update.setUpdateSleepForTests((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
      });
      subtest.mock.method(https, "get", () => {
        fallbackCalls += 1;
        const request = new EventEmitter();
        request.setTimeout = () => request;
        process.nextTick(() => request.emit("error", fallbackFailure));
        return request;
      });
      update.setUpdateSleepForTests(async (milliseconds) => { waits.push(milliseconds); });
      update.useNativeUpdateTransport(async () => {
        nativeCalls += 1;
        throw nativeFailure;
      });

      await assert.rejects(update.downloadText("https://example.test/metadata.json"), (failure) => {
        assert.ok(failure instanceof AggregateError);
        assert.deepEqual(failure.errors, [nativeFailure, fallbackFailure]);
        assert.match(failure.message, /native transport failed/);
        assert.match(failure.message, /connect EACCES/);
        return true;
      });
      const retryable = nativeCode === "EAI_AGAIN";
      assert.equal(nativeCalls, retryable ? 3 : 1);
      assert.equal(fallbackCalls, nativeCalls);
      assert.deepEqual(waits, retryable ? [1_000, 3_000] : []);
    });
  }
});

test("a successful Node fallback still supplies the update without a retry", async (testContext) => {
  const update = require("../electron/update.cjs");
  testContext.after(() => update.useNativeUpdateTransport(null));
  testContext.mock.method(https, "get", (_url, _options, onResponse) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    const response = Readable.from([Buffer.from("fallback response")]);
    response.statusCode = 200;
    response.headers = {};
    process.nextTick(() => onResponse(response));
    return request;
  });
  update.useNativeUpdateTransport(async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); });
  assert.equal(await update.downloadText("https://example.test/metadata.json"), "fallback response");
  assert.equal(https.get.mock.callCount(), 1);
});

test("a fallback redirect does not hide a retryable native failure on the next host", async (testContext) => {
  const update = require("../electron/update.cjs");
  const waits = [];
  let nativeCalls = 0;
  testContext.after(() => {
    update.useNativeUpdateTransport(null);
    update.setUpdateSleepForTests((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  });
  testContext.mock.method(https, "get", (url, _options, onResponse) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    process.nextTick(() => {
      if (url.hostname === "example.test") {
        const response = Readable.from([]);
        response.statusCode = 302;
        response.headers = { location: "https://assets.example.test/metadata.json" };
        onResponse(response);
      } else {
        request.emit("error", Object.assign(new Error("connect EACCES"), { code: "EACCES" }));
      }
    });
    return request;
  });
  update.setUpdateSleepForTests(async (milliseconds) => { waits.push(milliseconds); });
  update.useNativeUpdateTransport(async (url) => {
    nativeCalls += 1;
    if (nativeCalls === 1) throw new Error("native connection failed");
    if (url.includes("assets.example.test")) {
      throw Object.assign(new Error("native lookup failed"), { code: "EAI_AGAIN" });
    }
    return new Response("recovered response", { status: 200 });
  });

  assert.equal(await update.downloadText("https://example.test/metadata.json"), "recovered response");
  assert.equal(nativeCalls, 3);
  assert.equal(https.get.mock.callCount(), 2);
  assert.deepEqual(waits, [1_000]);
});

test("a pack whose connection breaks partway is downloaded again from the start", async () => {
  const update = require("../electron/update.cjs");
  update.setUpdateSleepForTests(async () => {});
  let calls = 0;
  update.useNativeUpdateTransport(async () => {
    calls += 1;
    if (calls === 1) {
      // Headers and a first chunk arrive, then the connection resets.
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("half")); },
        pull(controller) { const error = new Error("read ECONNRESET"); error.code = "ECONNRESET"; controller.error(error); },
      });
      return new Response(body, { status: 200 });
    }
    return new Response("whole pack", { status: 200 });
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-retry-"));
  try {
    const file = path.join(root, "pack");
    await update.downloadFile("https://github.com/x/pack", file);
    assert.equal(fs.readFileSync(file, "utf8"), "whole pack", "the broken attempt's part is not kept");
    assert.equal(calls, 2);
  } finally {
    update.useNativeUpdateTransport(null);
    update.setUpdateSleepForTests((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an update request that goes quiet times out instead of hanging", async () => {
  const update = require("../electron/update.cjs");
  update.setUpdateIdleMsForTests(50);
  update.setUpdateSleepForTests(async () => {});
  let aborted = 0;
  // The app's network answers with headers, then sends nothing more; the body never ends.
  update.useNativeUpdateTransport(async (_url, options) => {
    options.signal.addEventListener("abort", () => { aborted += 1; });
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 200 });
  });
  // The idle timer is unref'd (it must not hold the app open); Electron's loop keeps it alive, here this does.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(update.downloadText("https://github.com/x/manifest.json"), /timed out/);
    assert.ok(aborted >= 1, "the stalled request is aborted, not left open");
  } finally {
    update.useNativeUpdateTransport(null);
    clearInterval(keepAlive);
    update.setUpdateIdleMsForTests(60_000);
    update.setUpdateSleepForTests((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
});

test("an update download given up partway closes the app's network response instead of leaving it open", async () => {
  const update = require("../electron/update.cjs");
  let cancelled = 0;
  // Metadata that grows past its size limit: the read stops there; the response must not stay open.
  update.useNativeUpdateTransport(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode("0123456789")); },
    cancel() { cancelled += 1; },
  }), { status: 200 }));
  try {
    await assert.rejects(update.downloadText("https://api.github.com/x", 25), /size limit/);
    for (let tries = 0; tries < 50 && !cancelled; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled, 1, "the body is cancelled, so the request ends");
  } finally { update.useNativeUpdateTransport(null); }
});
