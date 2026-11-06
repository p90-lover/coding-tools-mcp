# Antigravity Coding Filter

CPA v8 native keyword filter adapted from [jellyfish-p/cpa-plugin-antigravity-coding-filter](https://github.com/jellyfish-p/cpa-plugin-antigravity-coding-filter), commit `bed909ef1ed9a73543324113de67f49312572058` (MIT).

Coding Tools enables **rewrite** mode so Claude Code's system text uses Antigravity in place of configured client names. Filtering runs after CPA selects the upstream protocol and only for `ToFormat: antigravity`. It applies to the top-level `system` string or text blocks, preserving user messages, tool schemas/results, cache controls, numbers and response streams.

In CPA's plugin settings, keep the built-in preset (including Claude Code, Codex, Cursor and the other upstream coding-client names), or turn it off and specify exactly which words to replace:

```yaml
plugins:
  configs:
    antigravity-coding-filter:
      enabled: true
      priority: 1
      mode: rewrite
      use_default_keywords: false
      custom_mappings:
        Claude Code: Antigravity
        Claude CLI: Antigravity
```

Matching is case-insensitive and literal. Longer keywords take precedence; replacements run once, so a replacement is not filtered again. Custom mappings override the same built-in keyword. As upstream, mapping values must be non-empty. A comma/newline-delimited `keyword: replacement` string or list is also accepted. Saved mappings and explicit disabling survive app restarts. `mode: block` terminates matching Antigravity requests with HTTP 403; standalone plugin configuration defaults to block as upstream does.

Point Claude Code at your existing CPA Anthropic endpoint and select a model served by an authenticated Antigravity account. The filter does not add models or supply account access.

Build from this directory with the repository's portable Go 1.27.3 and Zig 0.16.0, `CGO_ENABLED=1`, and `CC="zig cc -target x86_64-windows-gnu"`. Explicitly set `TEMP`, `TMP`, `GOTMPDIR`, `GOCACHE`, `GOMODCACHE`, `ZIG_LOCAL_CACHE_DIR` and `ZIG_GLOBAL_CACHE_DIR` to task folders under the project's `aiTemp/` before running `go test ./...` and `go build -buildmode=c-shared -trimpath -ldflags "-s -w" -o <aiTemp-output>/antigravity-coding-filter-v0.2.1-codingtools.1.dll .`. Copy the DLL into the bundled plugin directory and update its BUNDLE digest. CPA's `/v0/management/plugins` must report it registered and enabled.
