# Windows launcher crash evidence (2026-10-18)

This is a logs-only report. It does not contain an application fix or establish the cause of a new crash on October 18.

## Reported symptom and environment

- Reported symptom: launching Coding Tools did not show a GUI.
- Reported OS: Windows 10.0.26220.
- The update worker recorded upgrades to `v0.7.0-rc.17` on October 17 and `v0.7.0-rc.18` on October 18. These are update-log observations, not an independent verification of the running application's version.
- All timestamps below are UTC.

Personal installation paths, the Windows username, and the archive snapshot ID have been replaced with placeholders. Only relevant excerpts are included; settings, credentials, session data, and complete logs are not attached.

## 1. Last recorded fatal startup failure: missing packaged runtime file

Source: `%APPDATA%\Coding Tools\logs\launcher-fatal.log`.

```text
2026-10-15T04:30:57.203Z Error: Packaged runtime did not fully materialize within 30000ms: Runtime bundle file is missing: <install>\resources\runtime\LICENSES\Bun-1.4.0.md
    at waitForPackagedRuntimeSource (<install>\resources\app.asar\electron\runtime-install.cjs:215:9)
    at async start (<install>\resources\app.asar\electron\main.cjs:2416:3)
```

The same missing-file error was recorded on `2026-10-11T04:48:08.260Z`, with the caller at `main.cjs:2301:3`.

The recorded failure is a startup timeout while validating the packaged runtime. **The named license file exists and is readable at inspection on October 18.** Its earlier absence explains those recorded failures, but does not establish the cause of a current no-window launch. The logs do not establish why the file was missing at the time.

## 2. Earlier fatal startup failure: exclusive temporary-file creation

Source: `%APPDATA%\Coding Tools\logs\launcher-fatal.log`.

```text
2026-10-04T11:14:27.551Z Error: EEXIST: file already exists, open '<app-data>\archives\retired-services\snapshots\<snapshot-id>\manifest.json.tmp-87380-1791112467550-5'
    at Object.openSync (node:fs:561:18)
    at Object.func [as openSync] (node:electron/js2c/node_init:2:2630)
    at Object.writeFileSync (node:fs:2436:35)
    at writePrivateFileAtomic (<install>\resources\app.asar\electron\atomic-file.cjs:51:10)
    at archiveRetiredServicesState (<install>\resources\app.asar\electron\external-services.cjs:433:7)
    at createExternalServicesController (<install>\resources\app.asar\electron\external-services.cjs:488:3)
    at createManagedExternalServicesController (<install>\resources\app.asar\electron\managed-external-services.cjs:105:20)
    at start (<install>\resources\app.asar\electron\main.cjs:2279:32)
```

Similar failures were recorded on October 3 at `07:22:54.578Z`, `07:27:12.531Z`, and `07:28:36.854Z`, and on October 4 at `02:21:24.152Z`. The temporary-file names differ between launches.

The stack identifies the failing operation: writing a temporary archive manifest during startup. It does not explain why exclusive creation reported an existing file. A stale temporary file, concurrent writer, or filesystem interference has not been proven. Deleting archives or settings is not justified by this evidence.

## 3. October 18: update and local execution-service errors

Source: `%APPDATA%\Coding Tools\logs\launcher.jsonl`.

```json
{"at":"2026-10-18T00:31:55.750Z","level":"error","event":"launcher.ipc_failed","detail":{"channel":"launcher:update-install","message":"getaddrinfo ENOTFOUND github.com"}}
{"at":"2026-10-18T00:38:32.511Z","level":"error","event":"launcher.ipc_failed","detail":{"channel":"coding-tools:apps:call","message":"connect ECONNREFUSED 127.0.0.1:54867"}}
{"at":"2026-10-18T00:38:33.570Z","level":"error","event":"launcher.ipc_failed","detail":{"channel":"coding-tools:apps:call","message":"Local execution service is stopping"}}
{"at":"2026-10-18T00:38:36.573Z","level":"error","event":"launcher.ipc_failed","detail":{"channel":"coding-tools:apps:call","message":"Local execution service is stopping"}}
{"at":"2026-10-18T00:38:37.509Z","level":"error","event":"launcher.ipc_failed","detail":{"channel":"coding-tools:apps:call","message":"Local execution service is stopping"}}
```

Source: `%APPDATA%\Coding Tools\logs\app-update-worker.log`.

```text
2026-10-17T15:44:47.070Z waiting for the app (PID 24132) to close before updating to v0.7.0-rc.17
2026-10-17T15:44:53.501Z v0.7.0-rc.17 applied: 9 file(s) replaced, 0 removed, 1 still in use
2026-10-18T00:38:32.435Z waiting for the app (PID 47176) to close before updating to v0.7.0-rc.18
2026-10-18T00:38:41.746Z v0.7.0-rc.18 applied: 12 file(s) replaced, 1 removed, 1 still in use
```

The DNS error affected an update-install request. The connection refusal and stopping-service errors overlap the later update window. Neither these IPC errors nor the updater's "still in use" message proves that the launcher crashed or identifies which file remained in use.

Later launcher records show activity, including successful bridge connection, followed by another startup marker:

```json
{"at":"2026-10-18T00:45:36.687Z","level":"info","event":"bridge.auto_connected","detail":{"reason":"setup-signin-check","changed":false}}
{"at":"2026-10-18T00:54:44.484Z","level":"info","event":"launcher.ipc_minimal_registered","detail":{"reason":"pre-renderer"}}
```

## Inspection results and limits

- The last fatal entry in the inspected log is October 15, not October 18.
- The previously missing `Bun-1.4.0.md` file is now present and readable.
- Two installed `Coding Tools.exe` processes were observed; both returned an empty `MainWindowTitle`. This does not independently verify window visibility or renderer health.
- A read-only query of the Windows Application event log for event IDs `1000`, `1001`, and `1002` over the preceding seven days returned no messages matching `Coding Tools.exe`. This does not rule out all crashes or hangs.
- No application files, settings, archives, or processes were modified during this collection. No restart or native GUI verification was performed.

## Follow-up investigation

1. Capture a fresh failing launch with the installed app version and window/renderer lifecycle evidence. Distinguish a process exit from a running process that never shows its window.
2. Verify packaged-runtime completeness after an update and identify the file reported as still in use. The old missing-file error must not be treated as current while that file is present.
3. Reproduce the archive manifest `EEXIST` failure with isolated data before changing the shared atomic writer. Preserve settings and archives, and do not assume all temporary files are owned by the failing writer.

No fix, successful relaunch, or resolution of these failures is claimed by this report.
