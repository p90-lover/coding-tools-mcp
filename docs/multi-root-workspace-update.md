# Multi-root Workspace update

This fork adds linked-project support to a single Coding Tools MCP workspace. The primary workspace stays unchanged, while explicitly approved folders on other drives or outside the primary root can be attached as child projects.

## What changed

- One MCP workspace can expose multiple approved local project roots.
- Linked projects are configured by `.mcp-paths/*.txt` files inside the primary workspace.
- Workspace settings includes **Quick Add Project**, which opens the native folder picker and creates a mapping automatically.
- Clicking the active workspace in the sidebar shows its linked projects.
- The MCP accepts `@alias/path` for linked-project paths.
- `set_default_cwd("@alias")` switches the MCP default working directory to a linked project for subsequent relative file, Git, patch, and exec operations.
- Approved absolute paths such as `F:\ClashOfClans\Macro\file.py` are accepted for write/patch/exec when they resolve inside a linked root.
- Existing explicit external read behavior is preserved.

## Example

Primary workspace:

```text
C:\Coding\MainWorkspace
```

Mapping file:

```text
C:\Coding\MainWorkspace\.mcp-paths\coc-macro.txt
```

Contents:

```text
name=CoC Macro
path=F:\ClashOfClans\Macro
mode=read-write
```

Then all of these can refer to the linked project:

```text
@coc-macro
@coc-macro/scripts/attack.py
F:\ClashOfClans\Macro\scripts\attack.py
```

To make it the MCP default project:

```text
set_default_cwd({ "path": "@coc-macro" })
```

## Quick Add Project

Open a workspace, find **Linked Projects**, and click **Quick Add Project**. Choose any folder on another drive or outside the primary workspace. The app creates a unique `.mcp-paths/<alias>.txt` mapping and refreshes the linked-project list immediately. Existing mappings are never overwritten; duplicate names receive `-2`, `-3`, and so on.

## Mapping format

Key/value format:

```text
name=Reference Assets
path=D:\Shared\Assets
mode=read-only
```

A legacy one-line mapping is also accepted:

```text
F:\ClashOfClans\Macro
```

Supported modes are `read-write` and `read-only`. Quick Add creates `read-write` mappings by default.

## Safety boundaries

The patch does not enable unrestricted host access. Writes and exec working directories must resolve under either the primary workspace or an explicitly mapped linked root. Canonical-path checks are used so symlink/junction escapes remain blocked. `read-only` mappings reject writes and exec workdirs. `.git`, `.github`, and `.mcp-paths` stay protected from ordinary write/patch operations.

Paths outside every approved root continue to return `PATH_OUTSIDE_WORKSPACE`.

## Files changed

The implementation touches the central workspace resolver, command policy/exec validation, MCP metadata/default cwd display, workspace commands/API/store, sidebar workspace item, Workspace settings form, and workspace settings page. The linked-project parser lives in `src-tauri/src/workspace/linked_projects.rs`.

## Verification

The feature branch applies the patch through a one-shot GitHub Actions workflow and runs:

```text
cargo test
npm run check
```

Focused Rust tests cover linked alias resolution, approved absolute writes, blocking unapproved roots, read-only mappings, and Quick Add alias collision handling.
