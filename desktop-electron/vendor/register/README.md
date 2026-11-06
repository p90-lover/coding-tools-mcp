# Bundled Register runtime

This is Coding Tools' self-contained distribution of the current `reg-machine`
application, based on [lxf746/any-auto-register](https://github.com/lxf746/any-auto-register)
commit `ba1004241f4be7b0bb11b705b7c88a684e42b3db`, including the local application
fixes captured on 2026-10-23. The application is licensed under AGPL-3.0; the
complete corresponding application/frontend source and license travel with the
runtime in `source/register`. `SOURCE_MANIFEST.json` records each original and
vendored file's SHA-256. The private `reg-factory` project and all databases,
credentials, profiles, runtime state, diagnostics, caches and exports are excluded.

From the Coding Tools repository root, run:

```text
node scripts/prepare-register-runtime.cjs
```

The build uses Python 3.13, creates a disposable build environment under `aiTemp`,
installs `requirements-build.lock.txt`, rebuilds the actual frontend, and freezes
Python and its dependencies with PyInstaller 6.22.3. It includes the hash-pinned
Camoufox browser in `BROWSERS.json` and the Chromium revisions selected by the
exact pinned Playwright and patchright packages. Linux builds also require the
browser's normal OS shared libraries; build native to the target platform.

`REGISTER_BUILD_PYTHON` selects the build interpreter. For an already provisioned
build environment, `REGISTER_BUILD_REUSE_PYTHON=1` reuses that interpreter after
checking the packaging/browser dependency pins. These are build-time options;
the installed application needs neither Python nor an external project folder.
The output is `aiTemp/register-runtime`, which desktop packaging includes as
`resources/register-runtime`. Replaced generated bundles are retained in Trash.
An exact source/build-input fingerprint and the complete artifact inventory must
match before a cached runtime is reused. Unchanged verified browser engines may
be hardlinked into a new build; application code is rebuilt after source changes.

The service command is `register-service --host 127.0.0.1 --port PORT`. The native
host supplies `CT_REGISTER_DATA_DIR`, `ACCOUNT_MANAGER_DATA_DIR`,
`ACCOUNT_MANAGER_DATABASE_URL`, a random private `APP_PASSWORD`, and a fresh
`CT_REGISTER_INSTANCE_ID`. Storage and the working directory are set before any
application import. The install/source folders remain read-only. Browser add-ons
and optional GeoIP downloads use the managed data directory. Source-folder paths
are never needed by the installed service.

`--offline-smoke` initializes only the isolated database and registries, and
disables application lifespan workers; production launches retain the actual
application lifecycle. This flag exists for package verification without account,
provider, SMS, solver, login or registration activity.
`--verify-browsers` verifies all three bundled engines against offline synthetic
pages and excludes optional add-on downloads; it performs no account operations.

The private, bearer-authenticated integration routes are:

* `GET /api/coding-tools/accounts`: metadata and credential revisions, no secrets.
* `POST /api/coding-tools/export`: `{ "ids": [1] }` returns CPA auth objects.
* `POST /api/coding-tools/refresh`: the same explicit selection refreshes only
  saved tokens using the upstream identity-checked, noninteractive refresh path.

Selections must contain 1–100 unique positive integer IDs. Empty selections never
mean all accounts. Export revisions depend on saved OAuth identity/credentials,
not export-time timestamps. Disabled or restricted accounts are not exported or
automatically retried. Errors contain fixed categories, never provider responses
or credentials. The full user-facing application remains available separately
from this narrow integration. Refresh batches stop after caller disconnect, and
the bridge and application maintenance share a mutex for each account's token
rotation, reloading credentials after acquiring it. The optional encrypted authenticator integration
requires an independently configured authenticator because that private project
is deliberately not redistributed.
