# CommandCode Studio CPA plugin

Based on [UNICKCHENG/cliproxyapi-plugins](https://github.com/UNICKCHENG/cliproxyapi-plugins) commit `7ead2c1df31472b9272910e733a94560dfa04815` (MIT), plugin `auth-commandcode` v0.1.0. Coding Tools adds a browser login callback for CPA OAuth Login, distinguishes the Studio option in metadata, and decodes CPA 7.3.7's `StatusCode` host HTTP field.

Provider key: `commandcode`. This plugin uses the official CommandCode Provider API and requires a Studio API-enabled account. The Go-plan `/alpha/generate` plugin is separate.

The Windows binary is pinned by `../../bundled/cpa-plugins/BUNDLE.json`. An isolated CPA 7.3.7 run proved registration, OAuth login, auth-file persistence, model discovery, and mocked Chat Completions inference. Real account inference remains a cutover check.

Build with Go 1.26.8, CGO enabled, and Zig 0.16.0 as `CC="zig cc -target x86_64-windows-gnu"`: in `go/`, run `go test ./...` and `go build -buildmode=c-shared -o auth-commandcode-v0.1.0-codingtools.1.dll .`.
