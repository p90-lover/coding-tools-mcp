# CommandCode CPA plugin

This Windows CPA provider plugin replaces the text, reasoning, streaming and tool-call path of the in-tree CommandCode proxy using the same `/alpha/generate` wire. It is based on [sperictao/cpa-plugin-commandcode-go](https://github.com/sperictao/cpa-plugin-commandcode-go) commit `444ee977daaa96e6fa6ef5155b14cac3a6f9cdc3` (MIT) and checked against the pinned [zahidhussaina2l/commandcode-proxy](https://github.com/zahidhussaina2l/commandcode-proxy) source at `c123a3ebe017415ef45e619600a1110198dea7f8`.

Coding Tools adds CPA browser login, per-account auth files, and credential selection. The built Windows DLL is pinned in `../../bundled/cpa-plugins/BUNDLE.json`. CPA 7.3.7 reports it registered, effective, and OAuth-capable. An isolated test completed login, auth-file persistence, model discovery and mock inference.

The upstream Go-plan plugin does not process image input. Keep the old proxy available until a vision replacement or an explicit acceptance of that gap. A real CommandCode account and running installed app are needed for live inference proof.

To rebuild on Windows, use Go 1.26.8 with CGO enabled and Zig 0.16.0 as `CC="zig cc -target x86_64-windows-gnu"`, then run `go test ./...` and `go build -buildmode=c-shared -o commandcode-go-v1.0.0-codingtools.1.dll ./cmd/commandcodego`.
