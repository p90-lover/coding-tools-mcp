"use strict";

// Runtime > App layout (src/features/AppLayoutSurface.tsx) and the `app_layout` chat-agent MCP tool
// (chat-agent-tools.cjs): the whole picture of Coding Tools across its 6 core categories, 4 layers
// (Sidebar Navigation, Unified Settings, Built-in MCP Tools, Background Services & Plugins), and
// current overlaps/misplacements. Both the person (in the App layout tab) and a chat model (via
// `mcp__coding-tools__app_layout`) can read and edit any category, layer row, or overlap; changes
// are saved off the main thread and pushed live to the open App layout tab.

const fs = require("node:fs");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

function cleanText(value, maxLength = 600, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.replace(CONTROL, "").trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function cleanId(value, fallbackTitle = "item") {
  const raw = typeof value === "string" ? value.trim() : "";
  if (ID_PATTERN.test(raw)) return raw;
  const slug = String(fallbackTitle || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "item";
}

function cleanStringList(value, maxItems = 40, maxItemLength = 300) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/)
      : [];
  const out = [];
  for (const entry of source) {
    const line = cleanText(entry, maxItemLength, "");
    if (!line) continue;
    out.push(line);
    if (out.length >= maxItems) break;
  }
  return out;
}

const DEFAULT_APP_LAYOUT = Object.freeze({
  version: 1,
  updatedAt: "2026-11-23T00:00:00.000Z",
  overview: {
    title: "App layout",
    subtitle: "The whole picture of Coding Tools across 6 core categories, 4 architecture layers, and current overlaps. Both you and chat models (via the app_layout MCP tool) can edit any layer.",
  },
  categories: [
    {
      id: "chats-agents",
      title: "1. Chats & Agents (The Workbench)",
      eli5: "Where you talk to coding agents, run autonomous missions, and manage agent teams and subagents.",
      items: [
        {
          id: "chat-workbench",
          title: "Chat (agent-orchestrator / ChatPages.tsx)",
          surfaceId: "agent-orchestrator",
          summary: "Main coding workbench for folder/GitHub projects and standalone general chats.",
          bullets: [
            "Projects: Folder-backed or GitHub-backed project workspaces and their chat threads",
            "General Chat (No-project chats): Unrestricted read, reviewer-gated write/command execution",
            "Multi-Pane Split View & Chat Pages (Pages 1–10): Side-by-side split screens and Ctrl+1..0 pages",
            "In-Chat Panes: Sandboxed Terminal (exec_command) and live Preview Browser (preview_open / preview_render)",
            "Missions / Goals & Schedules: Multi-step autonomous runs, wake-ups, and scheduled turns",
          ],
        },
        {
          id: "orchestrator-team",
          title: "Orchestrator Team (agent-orchestrator-teams)",
          surfaceId: "agent-orchestrator-teams",
          summary: "Role templates and model routing for multi-agent teams.",
          bullets: [
            "Planner, Worker, Reviewer, Sub-reviewer, and Approver role nodes",
            "Per-role harness, provider, model, and effort routing",
          ],
        },
        {
          id: "subagents",
          title: "Subagents (subagents)",
          surfaceId: "subagents",
          summary: "Subagent pool configuration and delegated run inspection.",
          bullets: [
            "Explorer, Implementer, Reviewer, and custom subagent definitions",
            "Allowed provider filters and live/completed subagent transcripts",
          ],
        },
        {
          id: "legacy-mission-board",
          title: "Chats (agent-orchestrator-original)",
          surfaceId: "agent-orchestrator-original",
          summary: "The Orchestrator's own app: its chats, task graph and kanban board.",
          bullets: [
            "In Runtime as Chats, beside the Chat built on the Orchestrator",
          ],
        },
      ],
    },
    {
      id: "tools-mcp-permissions",
      title: "2. Tools, MCP & Permissions (The Agent's Hands)",
      eli5: "Controls what tools, folders, MCP servers, and screen controls chat agents are allowed to use.",
      items: [
        {
          id: "plugins-and-mcps",
          title: "Plugins & MCP Servers (plugins)",
          surfaceId: "plugins",
          summary: "Built-in coding-tools switches and external STDIO / Streamable HTTP MCP servers.",
          bullets: [
            "Apps tab: File/search/git tools (chatAgentTools), Terminal (chatAgentTerminalTools), Preview (chatAgentPreviewTools), Desktop (chatAgentDesktopTools)",
            "MCPs tab: User-added STDIO and Streamable HTTP MCP servers + README config parser",
            "Ready-to-add MCP catalog: One-click GitHub MCP (using gh auth token), Playwright, Chrome DevTools, etc.",
          ],
        },
        {
          id: "workspace-mcp-listeners",
          title: "Workspace MCP & Authentication (instant-mcp + workspace-auth)",
          surfaceId: "instant-mcp",
          summary: "Per-folder MCP listeners, read/write scopes, linked projects, and listener credentials.",
          bullets: [
            "Workspace folder list, linked projects, and read/write scope badges",
            "Permission & approval profiles: Read-only, Core, Advanced; Ask / On request / Never",
            "Local MCP listener port controls (Start / Stop / Restart) and OAuth / Bearer / API key auth (workspace-auth)",
          ],
        },
        {
          id: "computer-use",
          title: "Computer Use (computer-use)",
          surfaceId: "computer-use",
          summary: "Screen capture, window allowlist, step-by-step review, and Always-allowed apps.",
          bullets: [
            "Let chat agents use the computer & Review each step switches",
            "Live window under control with instant Stop and Always-allowed apps manager",
          ],
        },
        {
          id: "rtk-compactor",
          title: "RTK — Token Compactor (rtk)",
          surfaceId: "rtk",
          summary: "Shortens shell command output before the model reads it (github.com/rtk-ai/rtk).",
          bullets: [
            "Covers Coding Tools terminal (exec_command), Claude Code Bash, Codex shell, and OpenCode bash",
            "One-click winget installer and rtk gain token-savings report",
          ],
        },
      ],
    },
    {
      id: "models-accounts-providers",
      title: "3. Models, Accounts & Providers (The Brains & Keys)",
      eli5: "Everything that logs into AI providers, manages OAuth tokens or API keys, and routes requests through CPA.",
      items: [
        {
          id: "cpa-accounts",
          title: "Accounts & Provider Manager (oauth)",
          surfaceId: "oauth",
          summary: "OAuth sign-ins, saved account credentials, balances, and per-account proxies.",
          bullets: [
            "CPA Provider Manager account cards, quota/balance tracking, and credential health",
            "Per-account proxy binding and upstream usage logs",
          ],
        },
        {
          id: "cpa-console",
          title: "CPA Console (cpa)",
          surfaceId: "cpa",
          summary: "Full embedded CLI Proxy API management dashboard on 127.0.0.1:8317.",
          bullets: [
            "Model routing, OpenAI/Codex twin responses routing, and Antigravity prompt filter",
          ],
        },
        {
          id: "api-models-providers",
          title: "API Models / Provider Center (providers)",
          surfaceId: "providers",
          summary: "Custom API-key providers, endpoints, and model catalog configuration.",
          bullets: [
            "Direct API key accounts and provider execution routing plans",
          ],
        },
        {
          id: "antigravity-cli",
          title: "Antigravity CLI (antigravity-cli)",
          surfaceId: "antigravity-cli",
          summary: "Google Antigravity (agy) CLI installation, native sign-in, and agy acp chat harness.",
          bullets: [
            "Isolated auth home, native browser login, and ACP chat readiness",
          ],
        },
        {
          id: "register-and-email",
          title: "Register & Verification Email (register + email)",
          surfaceId: "register",
          summary: "Automated account registration helper and built-in verification email inbox.",
          bullets: [
            "Register surface for account provisioning and Email surface for verification codes",
          ],
        },
      ],
    },
    {
      id: "browser-webgpt-bridge",
      title: "4. Browser & ChatGPT Web Bridge (The WebGPT Engine)",
      eli5: "Everything dedicated to running ChatGPT in a browser or bridging ChatGPT Web into the Codex app and CLI.",
      items: [
        {
          id: "chatgpt-browser",
          title: "Browser (browser)",
          surfaceId: "browser",
          summary: "Multi-account Chromium browser for ChatGPT Web and Codex WebGPT turns.",
          bullets: [
            "Up to 12 ChatGPT accounts, 10 manual tabs + 5 Codex task tabs per account",
            "Dedicated Chrome passkey sign-in window and session import",
          ],
        },
        {
          id: "chatgpt-browser-management",
          title: "ChatGPT Browser Management (chatgpt-browser-management)",
          surfaceId: "chatgpt-browser-management",
          summary: "Account slots, session status, cookie/profile import, and per-account proxies.",
          bullets: [
            "Plan inspection (Plus / Team / Pro), session load balancing, and Codex thread bindings",
          ],
        },
        {
          id: "chatgpt-desktop",
          title: "ChatGPT Desktop (chatgpt-desktop)",
          surfaceId: "chatgpt-desktop",
          summary: "Embedded and local ChatGPT Desktop instance management.",
          bullets: [
            "Multi-slot desktop sign-in switcher and local window preview",
          ],
        },
        {
          id: "webgpt-setup-and-mcp",
          title: "Codex WebGPT Setup & Tunnel MCP (setup + mcp)",
          surfaceId: "setup",
          summary: "3-step Codex bridge setup, Keysmith instructions, and OpenAI Tunnel MCP connector.",
          bullets: [
            "Setup: Sign in to ChatGPT → Browser smoke test → Install models into Codex + Keysmith",
            "MCP: OpenAI Tunnel ID + Runtime API key + Codex Native2 / Codex Zero Risk connector check",
          ],
        },
        {
          id: "native-codex",
          title: "Native Codex (native-codex)",
          surfaceId: "native-codex",
          summary: "Connects a local codex.exe App Server to a workspace MCP listener.",
          bullets: [
            "Lets ChatGPT Web call codex_agent_control with :read-only or :workspace sandbox profiles",
          ],
        },
      ],
    },
    {
      id: "network-updates",
      title: "5. Network, Components & Updates (The Plumbing)",
      eli5: "How Coding Tools routes outbound traffic through proxies and keeps its bundled engines and plugins up to date.",
      items: [
        {
          id: "proxy-network",
          title: "Proxy & Network Routing (network)",
          surfaceId: "network",
          summary: "ProxyBridge Nova gateway, custom HTTP/SOCKS profiles, and Decodo sticky proxies.",
          bullets: [
            "Per-target egress routing (app, CPA, providers, credentials, browser partitions)",
            "Exit IP/country verification and Decodo automatic sync",
          ],
        },
        {
          id: "app-plugins-updater",
          title: "App Plugins / Component Updater (app-plugins)",
          surfaceId: "app-plugins",
          summary: "Checks installed versions against GitHub releases with manual and auto-update.",
          bullets: [
            "Services: CPA, Agent Orchestrator, Browser Engine",
            "Agent tools: Antigravity CLI, RTK",
            "CPA plugins: cpa-provider-manager DLL updater",
          ],
        },
      ],
    },
    {
      id: "settings-diagnostics",
      title: "6. Settings & Diagnostics (The Control Room)",
      eli5: "One unified place for startup behavior, chat & review preferences, standing AGENTS.md rules, app updates, and logs.",
      items: [
        {
          id: "unified-settings",
          title: "Settings (settings + ChatSettingsPage)",
          surfaceId: "settings",
          summary: "App preferences, Chat behavior, Response style, Instructions (AGENTS.md), Computer use, and Updates.",
          bullets: [
            "General & Accessibility: Language, Launch at login, Keep running in tray, Screen reader mode",
            "Chat & Turns: Auto-compact %, Auto-retry, Let the model judge, Quota-based reviews, Question timeout",
            "Instructions: Global AGENTS.md and per-project Workspace AGENTS.md editors",
            "Updates & Recovery: Delta updater (.ctpack), wait-for-chats gate, idle timer, auto-rollback",
          ],
        },
        {
          id: "activity-diagnostics",
          title: "Activity & Diagnostics (activity)",
          surfaceId: "activity",
          summary: "Action time latency profiler, Doctor health checks, and runtime event logs.",
          bullets: [
            "Action time: Tab first-open/render/response latency and web page load timings",
            "Recent activity events, safe log export, and Doctor runtime verification",
          ],
        },
      ],
    },
  ],
  layers: [
    {
      id: "sidebar",
      title: "Layer 1: Sidebar Navigation (Current vs. Clean Category Separation)",
      eli5: "Maps every sidebar surface in Coding Tools from its current sidebar group to the category it belongs to by job.",
      rows: [
        {
          id: "sidebar-chats-agents",
          category: "1. Chats & Agents",
          title: "Coding Workbench & Agent Teams",
          surfaceId: "agent-orchestrator",
          controllingSwitch: "Always on",
          currentLocation: "Runtime › Chat / Chats / Orchestrator Team / Subagents",
          belongsIn: "1. Chats & Agents",
          items: [
            "Chat (agent-orchestrator — Projects, General Chat, Split View, Pages 1–10)",
            "Orchestrator Team (agent-orchestrator-teams — Planner/Worker/Reviewer team templates)",
            "Subagents (subagents — Delegated worker pool & transcripts)",
            "Chats (agent-orchestrator-original — the Orchestrator's own app)",
            "App layout (app-layout — Full architecture map & live layer editor)",
          ],
          note: "Core daily workspace surfaces.",
        },
        {
          id: "sidebar-tools-mcp",
          category: "2. Tools, MCP & Permissions",
          title: "Agent Capabilities, MCP Servers & Folder Scopes",
          surfaceId: "plugins",
          controllingSwitch: "chatAgentTools",
          currentLocation: "Configuration › Plugins / Workspace + Connections › Workspace Auth + Runtime › Computer use + More › RTK",
          belongsIn: "2. Tools, MCP & Permissions",
          items: [
            "Plugins (plugins — Apps tool switches + custom STDIO/HTTP MCPs + Ready-to-add catalog)",
            "Workspace MCP (instant-mcp — Folder scopes, linked projects, permission profiles, local port)",
            "Workspace Authentication (workspace-auth — OAuth/Bearer/API keys for local MCP listeners)",
            "Computer use (computer-use — Desktop control, step review, Always-allowed apps)",
            "RTK (rtk — Shell command output compactor & savings report)",
          ],
          note: "Workspace Authentication configures auth for the exact same listener on the Workspace MCP page.",
        },
        {
          id: "sidebar-models-accounts",
          category: "3. Models, Accounts & Providers",
          title: "AI Providers, OAuth Accounts & Registration",
          surfaceId: "oauth",
          controllingSwitch: "Provider Manager / CPA",
          currentLocation: "Connections › Accounts / Register + Workspace › Email + More › CPA / Antigravity CLI",
          belongsIn: "3. Models, Accounts & Providers",
          items: [
            "Accounts (oauth — Embedded CPA auth-files & Provider Manager cards)",
            "CPA (cpa — Full embedded CLI Proxy API management console)",
            "Providers / API Models (providers / api-models — Custom API key endpoints)",
            "Antigravity CLI (antigravity-cli — Google agy CLI sign-in & ACP harness)",
            "Register (register) + Email (email — Verification code inbox)",
          ],
          note: "Email is primarily used for verification codes when registering or signing into accounts.",
        },
        {
          id: "sidebar-browser-webgpt",
          category: "4. Browser & ChatGPT Web Bridge",
          title: "ChatGPT Browser & Codex Bridge",
          surfaceId: "browser",
          controllingSwitch: "codexRoute / browserInteractionMode",
          currentLocation: "Workspace › Browser / Management / Desktop + Configuration › Setup / MCP + Runtime › Native Codex",
          belongsIn: "4. Browser & ChatGPT Web Bridge",
          items: [
            "Browser (browser — 12-account ChatGPT browser + Chrome passkey sign-in)",
            "ChatGPT browser management (chatgpt-browser-management — Slots, cookies, per-account proxies)",
            "ChatGPT Desktop (chatgpt-desktop — Embedded desktop client view)",
            "Setup (setup — 3-step Codex WebGPT setup + Keysmith instructions)",
            "MCP (mcp — OpenAI Tunnel + Codex Native2 / Codex Zero Risk connector wizard)",
            "Native Codex (native-codex — Local codex.exe App Server bridge for ChatGPT Web)",
          ],
          note: "Separates ChatGPT Browser / WebGPT bridge tools from local folder Workspaces.",
        },
        {
          id: "sidebar-network-updates",
          category: "5. Network & Component Updates",
          title: "Proxies & Binary Component Updaters",
          surfaceId: "network",
          controllingSwitch: "Auto-update / Nova routing",
          currentLocation: "More › Proxy + Connections › App plugins",
          belongsIn: "5. Network, Components & Updates",
          items: [
            "Proxy (network — ProxyBridge Nova, custom HTTP/SOCKS profiles, Decodo sync)",
            "App plugins (app-plugins — Updater for CPA, AO, Browser Engine, Antigravity CLI, RTK, CPA plugins)",
          ],
          note: "Keep binary updaters (App plugins) distinct from chat MCP servers (Plugins).",
        },
        {
          id: "sidebar-settings-diagnostics",
          category: "6. Settings & Diagnostics",
          title: "Unified Settings, Instructions & Runtime Logs",
          surfaceId: "settings",
          controllingSwitch: "Always on",
          currentLocation: "Sidebar Footer › Settings + Chat (Ctrl+,) + More › Activity",
          belongsIn: "6. Settings & Diagnostics",
          items: [
            "Settings (settings + ChatSettingsPage — General, Chat, Response style, Instructions, Computer use, Updates)",
            "Activity (activity — Action time latency profiler, runtime logs, safe log export)",
          ],
          note: "Unifies the launcher Settings page and the in-chat Ctrl+, Settings overlay.",
        },
      ],
    },
    {
      id: "settings",
      title: "Layer 2: Unified Settings Map (Every Setting Row Separated)",
      eli5: "Maps every single setting row across Launcher Settings (App.tsx) and Chat Settings (ChatSettingsPage.tsx) into 8 clean sub-categories without duplicates.",
      rows: [
        {
          id: "settings-general-startup",
          category: "6. Settings & Diagnostics",
          title: "A. General, Window & Accessibility",
          surfaceId: "settings",
          controllingSwitch: "autoStart / keepRunningOnClose / rendererAccessibility",
          currentLocation: "Duplicated across SettingsSurface and ChatSettingsPage › General",
          belongsIn: "Settings › General",
          items: [
            "Language (English, 简体中文, 繁體中文, 日本語)",
            "Start at login (autoStart)",
            "Keep running when the window closes (keepRunningOnClose)",
            "Screen reader support / Accessibility (Automatic, Always on, Off)",
          ],
          note: "Start at login and Keep running on close currently appear in both Settings UIs.",
        },
        {
          id: "settings-chat-turns",
          category: "6. Settings & Diagnostics",
          title: "B. Chat List, Pages, Context & Turn Execution",
          surfaceId: "agent-orchestrator",
          controllingSwitch: "chat_auto_compact / chat_auto_retry",
          currentLocation: "ChatSettingsPage › Chat",
          belongsIn: "Settings › Chat",
          items: [
            "Chat list: Chats shown per project & Keep running chats on top",
            "Archive & delete: Archive inactive chats after N days & Delete archived chats after N days",
            "Chat pages (1–10): Use pages, Open pages, Scroll to switch pages (Alt+Scroll), Page number keys (Ctrl+1..0)",
            "Context: Auto-compact toggle + Compact threshold (50%–100% full)",
            "Turns: Retry automatically (up to 8 times) & Keep work expanded on a mission",
            "Keyboard shortcuts reference table",
          ],
          note: "Controls how the Chat workbench lists, paginates, and compacts conversations.",
        },
        {
          id: "settings-approvals-safety",
          category: "2. Tools, MCP & Permissions",
          title: "C. Approvals, Reviewer & Secret Redaction",
          surfaceId: "settings",
          controllingSwitch: "modelJudges / meteredReviews / confirmAgentToolRequests",
          currentLocation: "Split between ChatSettingsPage › Chat › Turns, Computer use, and SettingsSurface",
          belongsIn: "Settings › Approvals & Safety",
          items: [
            "Let the model judge (modelJudges — reviewer decides eligible requests and goal rounds)",
            "Allow quota-based reviews (meteredReviews — off by default; uses native Codex Guardian when off)",
            "Agent questions timeout (Wait for my answer vs. Answer for me after N seconds)",
            "Confirm agent requests in a dialog (confirmAgentToolRequests)",
            "Let chat agents hide secrets in your messages (chatAgentRedactSecrets) + What to hide list",
            "Always-allowed apps for Computer Use (AllowedApps)",
          ],
          note: "All human-in-the-loop and auto-reviewer safety gates belong together.",
        },
        {
          id: "settings-agent-tools",
          category: "2. Tools, MCP & Permissions",
          title: "D. Built-in Agent Tool Group Switches",
          surfaceId: "plugins",
          controllingSwitch: "chatAgentTools / Terminal / Preview / Desktop",
          currentLocation: "Duplicated in both SettingsSurface and Configuration › Plugins › Apps",
          belongsIn: "Tools, MCP & Permissions › Plugins › Apps",
          items: [
            "Give chat agents the app's tools (chatAgentTools)",
            "Let chat agents run commands in the app's terminal (chatAgentTerminalTools)",
            "Let chat agents preview their pages (chatAgentPreviewTools)",
            "Let chat agents see and control the screen (chatAgentDesktopTools)",
          ],
          note: "Keeping these switches in Plugins › Apps avoids duplicating them in General Settings.",
        },
        {
          id: "settings-instructions-style",
          category: "6. Settings & Diagnostics",
          title: "E. Standing Instructions (AGENTS.md) & Response Style",
          surfaceId: "agent-orchestrator",
          controllingSwitch: "agent_instructions",
          currentLocation: "ChatSettingsPage › Instructions & Response style",
          belongsIn: "Settings › Instructions & Response Style",
          items: [
            "Global AGENTS.md editor (applies to every agent in every project)",
            "Workspace AGENTS.md editor (per-project instructions at the project folder root)",
            "Response style presets and custom instructions",
          ],
          note: "Injected into every new chat's first turn and updated live when edited.",
        },
        {
          id: "settings-webgpt-bridge",
          category: "4. Browser & ChatGPT Web Bridge",
          title: "F. WebGPT & Codex Bridge Options",
          surfaceId: "setup",
          controllingSwitch: "codexRoute / browserInteractionMode",
          currentLocation: "Mixed into SettingsSurface › General",
          belongsIn: "Browser & WebGPT Bridge (or Settings › WebGPT Bridge)",
          items: [
            "Use Coding Tools in Codex (codexRoute)",
            "ChatGPT interaction mode (With Automation vs. Zero Risk)",
            "Auto-connect existing MCP harness (autoConnectExistingMcp)",
            "Show browser during turns (showBrowserDuringTurns)",
            "Bigger Context 3× experimental (experimentalBiggerContext)",
            "Save chats in ChatGPT vs. Temporary Chat (useSavedChats)",
          ],
          note: "All six options specifically control the ChatGPT Web ↔ Codex bridge.",
        },
        {
          id: "settings-updates-recovery",
          category: "6. Settings & Diagnostics",
          title: "G. App Updates & Rollback Recovery",
          surfaceId: "settings",
          controllingSwitch: "automaticUpdates / updateWaitForChats",
          currentLocation: "Duplicated across SettingsSurface and ChatSettingsPage › Updates",
          belongsIn: "Settings › Updates & Recovery",
          items: [
            "Check for updates / Update now (.ctpack delta updater)",
            "Automatic updates while idle (automaticUpdates)",
            "Wait for chats to finish before installing (updateWaitForChats)",
            "Idle time before installing (updateIdleMinutes)",
            "Roll back a failed update automatically (updateAutoRollback)",
            "Health check window (updateHealthMinutes) & Reuse matching background services only",
          ],
          note: "ChatSettingsPage › Updates has the full recovery controls; SettingsSurface only shows the basic toggle.",
        },
        {
          id: "settings-diagnostics",
          category: "6. Settings & Diagnostics",
          title: "H. Diagnostics, Doctor & Action Times",
          surfaceId: "activity",
          controllingSwitch: "Read-only diagnostics",
          currentLocation: "Split between SettingsSurface › Diagnostics and More › Activity",
          belongsIn: "Settings & Diagnostics › Activity & Doctor",
          items: [
            "Run doctor (checks Responses proxy, tunnel binary/key/runtime, and ChatGPT connector)",
            "Cancel active Codex turn & Remove Codex integration",
            "Action time (tab render/response latency & web page load timings)",
            "Recent runtime activity events & Export safe log",
          ],
          note: "Combines health checks and runtime latency/event logs.",
        },
      ],
    },
    {
      id: "mcp-tools",
      title: "Layer 3: Built-in coding-tools MCP Server (Tools by Category)",
      eli5: "Every Claude Code, Codex, and OpenCode chat gets the built-in coding-tools MCP server (chat-agent-tools.cjs). Here is how its tools separate into 8 categories.",
      rows: [
        {
          id: "mcp-worktree-files-git",
          category: "2. Tools, MCP & Permissions",
          title: "1. Worktree Files, Search, Patches & Git",
          surfaceId: "plugins",
          controllingSwitch: "chatAgentTools (On by default)",
          currentLocation: "chat-agent-tools.cjs (AGENT_TOOLS + headless catalog)",
          belongsIn: "Core Agent Tools (Worktree-confined)",
          items: [
            "Files & Search: read_file, list_dir, list_files, search_text, grep_text",
            "Patching: apply_patch, patch_check",
            "Git: git_status, git_diff, git_log, git_show, git_blame",
            "Plans & Meta: update_plan, get_plan, open_plan, get_current_time, tool_search, server_info",
          ],
          note: "Confined to the chat session's git worktree or folder-mode project root.",
        },
        {
          id: "mcp-chat-project-layout",
          category: "1. Chats & Agents",
          title: "2. Chat, Project, App Layout & Session Organization",
          surfaceId: "app-layout",
          controllingSwitch: "chatAgentTools (On by default)",
          currentLocation: "chat-agent-tools.cjs + chat-history.cjs + app-layout.cjs",
          belongsIn: "Workbench & Architecture Tools",
          items: [
            "Cross-Chat Read: chat_list, chat_read (read-only; asks user before reading another project)",
            "Chat Lifecycle: rename_chat, move_chat, redact_message",
            "UI & Architecture: show_in_chat (brings terminal or preview pane forward), app_layout (reads or edits this App layout map)",
          ],
          note: "Lets models organize chats and read/edit the App layout layers live.",
        },
        {
          id: "mcp-autonomy-goals-alerts",
          category: "1. Chats & Agents",
          title: "3. Long-Horizon Autonomy, Goals & User Notifications",
          surfaceId: "agent-orchestrator",
          controllingSwitch: "chatAgentTools (On by default)",
          currentLocation: "chat-agent-tools.cjs + chat-goals.cjs + chat-wakeups.cjs",
          belongsIn: "Autonomy & Scheduling Tools",
          items: [
            "Goals: get_goal, create_goal, update_goal",
            "Wake-ups & Pauses: schedule_wakeup (1–720 min non-polling timer), sleep (up to 100s in-turn wait)",
            "User Alerts: push_notification (Windows desktop toast + taskbar flash)",
          ],
          note: "Replaces token-burning polling loops with event/timer wake-ups.",
        },
        {
          id: "mcp-subagents",
          category: "1. Chats & Agents",
          title: "4. Subagent Delegation",
          surfaceId: "subagents",
          controllingSwitch: "chatAgentTools + Subagents enabled",
          currentLocation: "subagents.cjs",
          belongsIn: "Multi-Agent Delegation Tools",
          items: [
            "Discovery: subagent_models, subagent_list",
            "Execution: subagent_start, subagent_status, subagent_inspect, subagent_message, subagent_result, subagent_stop",
          ],
          note: "Spawns isolated worker sessions in the same project under the same safety rules.",
        },
        {
          id: "mcp-images-self-view",
          category: "2. Tools, MCP & Permissions",
          title: "5. Worktree Images & App Self-Inspection",
          surfaceId: "activity",
          controllingSwitch: "chatAgentTools (On by default)",
          currentLocation: "chat-images.cjs + app-processes.cjs + main.cjs captureApp",
          belongsIn: "Visual & Diagnostic Tools",
          items: [
            "Worktree Images: view_image, image_info, compare_images, ocr_image, generate_image",
            "Coding Tools Self-Inspection: view_app (captures only the Coding Tools window), app_processes (CPU/RAM/handles of Coding Tools and child agents)",
          ],
          note: "view_app sees only the Coding Tools window, never the rest of the desktop.",
        },
        {
          id: "mcp-terminal-watches",
          category: "2. Tools, MCP & Permissions",
          title: "6. Sandboxed Terminal & Command Monitors",
          surfaceId: "plugins",
          controllingSwitch: "chatAgentTerminalTools (On by default with Codex sandbox)",
          currentLocation: "chat-sandbox.cjs + chat-command-watches.cjs + chat-command-monitors.cjs",
          belongsIn: "Terminal & Process Watch Tools",
          items: [
            "Execution: exec_command, write_stdin, read_output, kill_command, list_commands, check_exec_environment",
            "Watches & Streaming Monitors: watch_command, list_command_watches, cancel_command_watch, monitor, stop_monitor",
          ],
          note: "Commands are compacted by RTK when enabled and reviewed before execution.",
        },
        {
          id: "mcp-preview-browser",
          category: "2. Tools, MCP & Permissions",
          title: "7. Localhost Preview Browser",
          surfaceId: "plugins",
          controllingSwitch: "chatAgentPreviewTools (On by default)",
          currentLocation: "chat-preview.cjs",
          belongsIn: "Frontend & GUI Verification Tools",
          items: [
            "Panels & Localhost: preview_render (self-contained HTML/CSS/JS panel), preview_open, preview_navigate",
            "Inspection & Interaction: preview_read, preview_screenshot, preview_click, preview_type, preview_press, preview_scroll, preview_wait, preview_console",
          ],
          note: "Restricted to localhost/127.0.0.1/[::1] and blocked from Coding Tools' own internal ports.",
        },
        {
          id: "mcp-desktop-computer-use",
          category: "2. Tools, MCP & Permissions",
          title: "8. Desktop Screen Vision & Computer Control",
          surfaceId: "computer-use",
          controllingSwitch: "chatAgentDesktopTools (Off by default; per-app consent)",
          currentLocation: "computer-control.cjs + computer-guides.cjs + headless vision/computer",
          belongsIn: "Desktop Automation Tools",
          items: [
            "Screen & Window Vision: capture_screenshot, capture_window, capture_process, list_windows, list_displays, list_monitors, ocr_screen, vision_status",
            "Computer Control: computer_status, computer_list_windows, computer_select_window, computer_snapshot, computer_find_control, computer_action, computer_sequence, computer_wait, computer_stop, computer_guide, computer_route",
          ],
          note: "Requires user consent per app window and shows a live Stop bar at the top of the screen.",
        },
      ],
    },
    {
      id: "services",
      title: "Layer 4: Background Services & Component Categories",
      eli5: "Under the hood, Coding Tools coordinates separate background binaries and plugins managed in App plugins (app-plugins.cjs).",
      rows: [
        {
          id: "services-core",
          category: "5. Network, Components & Updates",
          title: "1. Core Runtime Services (kind: \"service\")",
          surfaceId: "app-plugins",
          controllingSwitch: "Managed by Coding Tools runtime supervisor",
          currentLocation: "Connections › App plugins › Services",
          belongsIn: "Core Runtime Daemons",
          items: [
            "Agent Orchestrator (agent-orchestrator.exe — Go daemon for sessions, SQLite ao.db, git worktrees, and ACP/Codex/OpenCode drivers)",
            "CPA (cli-proxy-api.exe — Go proxy server on 127.0.0.1:8317 for multi-provider OAuth, token refresh, and model routing)",
            "Headless MCP Core (coding-tools-headless.exe — Rust binary serving worktree-isolated file/patch/git/terminal/vision tools)",
            "Browser Engine (Electron/Chromium multi-partition browser host & Preview pane)",
            "ProxyBridge Nova (nova — Local proxy gateway and per-service traffic router)",
          ],
          note: "Swappable backend bundle updates AO and Headless without dropping the core bridge.",
        },
        {
          id: "services-agent-tools",
          category: "2. Tools, MCP & Permissions",
          title: "2. External Agent CLI Tools (kind: \"tool\")",
          surfaceId: "app-plugins",
          controllingSwitch: "Auto-updatable in App plugins",
          currentLocation: "Connections › App plugins › Agent tools",
          belongsIn: "External CLI Helpers",
          items: [
            "Antigravity CLI (agy — Google Antigravity ACP agent CLI)",
            "RTK (rtk.exe — Rust Token Killer CLI installed via winget to compact shell output)",
          ],
          note: "Checked against GitHub releases and updated in place.",
        },
        {
          id: "services-cpa-plugins",
          category: "3. Models, Accounts & Providers",
          title: "3. CPA Plugins (kind: \"cpa-plugin\")",
          surfaceId: "app-plugins",
          controllingSwitch: "Auto-updatable in App plugins (restarts CPA)",
          currentLocation: "Connections › App plugins › CPA plugins",
          belongsIn: "CPA Provider Extensions",
          items: [
            "CPA Provider Manager (cpa-provider-manager — Bundled DLL plugin unifying provider management, per-account proxy routing, and upstream usage)",
          ],
          note: "Replaces the retired standalone CPA helper plugins.",
        },
      ],
    },
  ],
  overlaps: [
    {
      id: "two-settings-uis",
      item: "Two separate Settings UIs",
      currentLocation: "Sidebar Footer (SettingsSurface) AND Chat Ctrl+, (ChatSettingsPage)",
      belongsIn: "6. Settings & Diagnostics (merged into one)",
      why: "Both pages have Startup, Tray, App Updates, and Agent Tool toggles, making it unclear which Settings page is authoritative.",
    },
    {
      id: "agent-tool-toggles",
      item: "Agent Tool Toggles duplicated",
      currentLocation: "Both Launcher Settings AND Configuration › Plugins › Apps",
      belongsIn: "2. Tools, MCP & Permissions › Plugins › Apps",
      why: "Identical switches (chatAgentTools, Terminal, Preview, Desktop) appear in two separate places.",
    },
    {
      id: "two-workspaces",
      item: "Two different things named \"Workspace\"",
      currentLocation: "Sidebar group \"Workspace\" (Browser/Email) AND item \"Workspace\" (instant-mcp)",
      belongsIn: "Rename group to Browser & WebGPT; keep Workspace MCP under Tools & MCP",
      why: "\"Workspace\" means ChatGPT Browser tabs in one place and local folder MCP permissions in another.",
    },
    {
      id: "workspace-auth-split",
      item: "Workspace Authentication separated from Workspace MCP",
      currentLocation: "Connections › Workspace Authentication",
      belongsIn: "2. Tools, MCP & Permissions (inside/next to Workspace MCP)",
      why: "Configures credentials for the exact same local MCP listener managed on the Workspace (instant-mcp) page.",
    },
    {
      id: "plugins-vs-app-plugins",
      item: "\"Plugins\" vs. \"App plugins\" naming collision",
      currentLocation: "Configuration › Plugins vs. Connections › App plugins",
      belongsIn: "Agent Tools & MCP (Plugins) vs. Component Updates (App plugins)",
      why: "Nearly identical names, but Plugins configures chat MCP servers/tools while App plugins updates CPA/AO/RTK binaries.",
    },
    {
      id: "email-and-register",
      item: "Email & Register in separate groups",
      currentLocation: "Workspace › Email and Connections › Register",
      belongsIn: "3. Models, Accounts & Providers (together)",
      why: "Email is primarily used to read verification codes during Register and provider account sign-ins.",
    },
    {
      id: "retired-stubs",
      item: "Retired module stubs (paseo, anneal)",
      currentLocation: "Surface union in types.ts / App.tsx",
      belongsIn: "Keep retired and hidden from sidebar",
      why: "Already retired in favor of Agent Orchestrator and CPA.",
    },
  ],
});

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_APP_LAYOUT));
}

function normalizeCategoryItem(item, index = 0) {
  const title = cleanText(item?.title, 160, `Item ${index + 1}`);
  const id = cleanId(item?.id, title);
  const surfaceId = cleanText(item?.surfaceId, 64, "");
  const summary = cleanText(item?.summary, 400, "");
  const bullets = cleanStringList(item?.bullets, 25, 300);
  return {
    id,
    title,
    ...(surfaceId ? { surfaceId } : {}),
    summary,
    bullets,
  };
}

function normalizeCategory(category, index = 0) {
  const title = cleanText(category?.title, 160, `Category ${index + 1}`);
  const id = cleanId(category?.id, title);
  const eli5 = cleanText(category?.eli5, 400, "");
  const rawItems = Array.isArray(category?.items) ? category.items.slice(0, 30) : [];
  return {
    id,
    title,
    eli5,
    items: rawItems.map((entry, idx) => normalizeCategoryItem(entry, idx)),
  };
}

function normalizeLayerRow(row, index = 0) {
  const title = cleanText(row?.title, 160, `Row ${index + 1}`);
  const id = cleanId(row?.id, title);
  const category = cleanText(row?.category, 120, "");
  const surfaceId = cleanText(row?.surfaceId, 64, "");
  const controllingSwitch = cleanText(row?.controllingSwitch, 140, "");
  const currentLocation = cleanText(row?.currentLocation, 240, "");
  const belongsIn = cleanText(row?.belongsIn, 240, "");
  const items = cleanStringList(row?.items, 30, 320);
  const note = cleanText(row?.note, 400, "");
  return {
    id,
    category,
    title,
    ...(surfaceId ? { surfaceId } : {}),
    ...(controllingSwitch ? { controllingSwitch } : {}),
    currentLocation,
    belongsIn,
    items,
    ...(note ? { note } : {}),
  };
}

function normalizeLayer(layer, index = 0) {
  const title = cleanText(layer?.title, 180, `Layer ${index + 1}`);
  const id = cleanId(layer?.id, title);
  const eli5 = cleanText(layer?.eli5, 400, "");
  const rawRows = Array.isArray(layer?.rows) ? layer.rows.slice(0, 40) : [];
  return {
    id,
    title,
    eli5,
    rows: rawRows.map((entry, idx) => normalizeLayerRow(entry, idx)),
  };
}

function normalizeOverlap(overlap, index = 0) {
  const item = cleanText(overlap?.item, 160, `Overlap ${index + 1}`);
  const id = cleanId(overlap?.id, item);
  const currentLocation = cleanText(overlap?.currentLocation, 240, "");
  const belongsIn = cleanText(overlap?.belongsIn, 240, "");
  const why = cleanText(overlap?.why, 400, "");
  return { id, item, currentLocation, belongsIn, why };
}

function normalizeAppLayout(input, nowIso = () => new Date().toISOString()) {
  const fallback = cloneDefault();
  if (!input || typeof input !== "object") return fallback;
  const overview = {
    title: cleanText(input.overview?.title, 160, fallback.overview.title),
    subtitle: cleanText(input.overview?.subtitle, 500, fallback.overview.subtitle),
  };
  const categories = Array.isArray(input.categories) && input.categories.length
    ? input.categories.slice(0, 20).map((entry, idx) => normalizeCategory(entry, idx))
    : fallback.categories;
  const layers = Array.isArray(input.layers) && input.layers.length
    ? input.layers.slice(0, 12).map((entry, idx) => normalizeLayer(entry, idx))
    : fallback.layers;
  const overlaps = Array.isArray(input.overlaps)
    ? input.overlaps.slice(0, 30).map((entry, idx) => normalizeOverlap(entry, idx))
    : fallback.overlaps;
  return {
    version: 1,
    updatedAt: cleanText(input.updatedAt, 64, nowIso()),
    overview,
    categories,
    layers,
    overlaps,
  };
}

/**
 * Applies a granular edit or full replacement to `current`, returning the new normalized layout.
 * Throws an Error with a clear message on invalid arguments.
 */
function applyAppLayoutAction(current, input, nowIso = () => new Date().toISOString()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("App layout edit requires an object with an action");
  }
  const action = cleanText(input.action, 64, "");
  const next = JSON.parse(JSON.stringify(normalizeAppLayout(current, nowIso)));

  switch (action) {
    case "reset": {
      const fresh = cloneDefault();
      fresh.updatedAt = nowIso();
      return fresh;
    }
    case "replace": {
      if (!input.layout || typeof input.layout !== "object") {
        throw new Error("replace requires a layout object");
      }
      const replaced = normalizeAppLayout(input.layout, nowIso);
      replaced.updatedAt = nowIso();
      return replaced;
    }
    case "update_overview": {
      const title = cleanText(input.title ?? input.overview?.title, 160, "");
      const subtitle = cleanText(input.subtitle ?? input.overview?.subtitle, 500, "");
      if (!title && !subtitle) throw new Error("Give a title or subtitle to update");
      if (title) next.overview.title = title;
      if (subtitle) next.overview.subtitle = subtitle;
      next.updatedAt = nowIso();
      return next;
    }
    case "upsert_category": {
      const raw = input.category && typeof input.category === "object" ? input.category : input;
      const title = cleanText(raw.title, 160, "");
      const id = cleanId(raw.id, title);
      const existingIndex = next.categories.findIndex((entry) => entry.id === id);
      const previous = existingIndex >= 0 ? next.categories[existingIndex] : null;
      if (!title && !previous) throw new Error("A new category needs a title");
      const merged = normalizeCategory({
        id,
        title: title || previous?.title,
        eli5: raw.eli5 !== undefined ? raw.eli5 : previous?.eli5 ?? "",
        items: raw.items !== undefined ? raw.items : previous?.items ?? [],
      }, existingIndex >= 0 ? existingIndex : next.categories.length);
      if (existingIndex >= 0) next.categories[existingIndex] = merged;
      else next.categories.push(merged);
      next.updatedAt = nowIso();
      return next;
    }
    case "remove_category": {
      const id = cleanText(input.id ?? input.categoryId, 80, "");
      if (!id) throw new Error("remove_category requires an id");
      const filtered = next.categories.filter((entry) => entry.id !== id);
      if (filtered.length === next.categories.length) throw new Error(`No category has id "${id}"`);
      if (!filtered.length) throw new Error("At least one category must remain");
      next.categories = filtered;
      next.updatedAt = nowIso();
      return next;
    }
    case "upsert_category_item": {
      const categoryId = cleanText(input.categoryId, 80, "");
      const category = next.categories.find((entry) => entry.id === categoryId);
      if (!category) throw new Error(`Unknown categoryId "${categoryId}"`);
      const raw = input.item && typeof input.item === "object" ? input.item : input;
      const title = cleanText(raw.title, 160, "");
      const id = cleanId(raw.id, title);
      const existingIndex = category.items.findIndex((entry) => entry.id === id);
      const previous = existingIndex >= 0 ? category.items[existingIndex] : null;
      if (!title && !previous) throw new Error("A new category item needs a title");
      const merged = normalizeCategoryItem({
        id,
        title: title || previous?.title,
        surfaceId: raw.surfaceId !== undefined ? raw.surfaceId : previous?.surfaceId ?? "",
        summary: raw.summary !== undefined ? raw.summary : previous?.summary ?? "",
        bullets: raw.bullets !== undefined ? raw.bullets : previous?.bullets ?? [],
      }, existingIndex >= 0 ? existingIndex : category.items.length);
      if (existingIndex >= 0) category.items[existingIndex] = merged;
      else category.items.push(merged);
      next.updatedAt = nowIso();
      return next;
    }
    case "remove_category_item": {
      const categoryId = cleanText(input.categoryId, 80, "");
      const itemId = cleanText(input.itemId ?? input.id, 80, "");
      const category = next.categories.find((entry) => entry.id === categoryId);
      if (!category) throw new Error(`Unknown categoryId "${categoryId}"`);
      const before = category.items.length;
      category.items = category.items.filter((entry) => entry.id !== itemId);
      if (category.items.length === before) throw new Error(`No item "${itemId}" in category "${categoryId}"`);
      next.updatedAt = nowIso();
      return next;
    }
    case "upsert_layer_row": {
      const layerId = cleanId(input.layerId, input.layerTitle || "layer");
      let layer = next.layers.find((entry) => entry.id === layerId);
      if (!layer) {
        const layerTitle = cleanText(input.layerTitle, 180, "");
        if (!layerTitle) throw new Error(`Unknown layerId "${layerId}" (provide layerTitle to add a new layer)`);
        layer = normalizeLayer({ id: layerId, title: layerTitle, eli5: input.layerEli5 ?? "", rows: [] }, next.layers.length);
        next.layers.push(layer);
      } else {
        if (typeof input.layerTitle === "string" && input.layerTitle.trim()) layer.title = cleanText(input.layerTitle, 180, layer.title);
        if (typeof input.layerEli5 === "string" && input.layerEli5.trim()) layer.eli5 = cleanText(input.layerEli5, 400, layer.eli5);
      }
      const raw = input.row && typeof input.row === "object" ? input.row : input;
      const title = cleanText(raw.title, 160, "");
      const id = cleanId(raw.id, title);
      const existingIndex = layer.rows.findIndex((entry) => entry.id === id);
      const previous = existingIndex >= 0 ? layer.rows[existingIndex] : null;
      if (!title && !previous) throw new Error("A new layer row needs a title");
      const merged = normalizeLayerRow({
        id,
        category: raw.category !== undefined ? raw.category : previous?.category ?? "",
        title: title || previous?.title,
        surfaceId: raw.surfaceId !== undefined ? raw.surfaceId : previous?.surfaceId ?? "",
        controllingSwitch: raw.controllingSwitch !== undefined ? raw.controllingSwitch : previous?.controllingSwitch ?? "",
        currentLocation: raw.currentLocation !== undefined ? raw.currentLocation : previous?.currentLocation ?? "",
        belongsIn: raw.belongsIn !== undefined ? raw.belongsIn : previous?.belongsIn ?? "",
        items: raw.items !== undefined ? raw.items : previous?.items ?? [],
        note: raw.note !== undefined ? raw.note : previous?.note ?? "",
      }, existingIndex >= 0 ? existingIndex : layer.rows.length);
      if (existingIndex >= 0) layer.rows[existingIndex] = merged;
      else layer.rows.push(merged);
      next.updatedAt = nowIso();
      return next;
    }
    case "remove_layer_row": {
      const layerId = cleanText(input.layerId, 80, "");
      const rowId = cleanText(input.rowId ?? input.id, 80, "");
      const layer = next.layers.find((entry) => entry.id === layerId);
      if (!layer) throw new Error(`Unknown layerId "${layerId}"`);
      const before = layer.rows.length;
      layer.rows = layer.rows.filter((entry) => entry.id !== rowId);
      if (layer.rows.length === before) throw new Error(`No row "${rowId}" in layer "${layerId}"`);
      next.updatedAt = nowIso();
      return next;
    }
    case "upsert_overlap": {
      const raw = input.overlap && typeof input.overlap === "object" ? input.overlap : input;
      const item = cleanText(raw.item ?? raw.title, 160, "");
      const id = cleanId(raw.id, item);
      const existingIndex = next.overlaps.findIndex((entry) => entry.id === id);
      const previous = existingIndex >= 0 ? next.overlaps[existingIndex] : null;
      if (!item && !previous) throw new Error("A new overlap entry needs an item title");
      const merged = normalizeOverlap({
        id,
        item: item || previous?.item,
        currentLocation: raw.currentLocation !== undefined ? raw.currentLocation : previous?.currentLocation ?? "",
        belongsIn: raw.belongsIn !== undefined ? raw.belongsIn : previous?.belongsIn ?? "",
        why: raw.why !== undefined ? raw.why : previous?.why ?? "",
      }, existingIndex >= 0 ? existingIndex : next.overlaps.length);
      if (existingIndex >= 0) next.overlaps[existingIndex] = merged;
      else next.overlaps.push(merged);
      next.updatedAt = nowIso();
      return next;
    }
    case "remove_overlap": {
      const id = cleanText(input.id ?? input.overlapId, 80, "");
      if (!id) throw new Error("remove_overlap requires an id");
      const before = next.overlaps.length;
      next.overlaps = next.overlaps.filter((entry) => entry.id !== id);
      if (next.overlaps.length === before) throw new Error(`No overlap has id "${id}"`);
      next.updatedAt = nowIso();
      return next;
    }
    default:
      throw new Error(`Unknown app_layout action "${action}"`);
  }
}

function selectAppLayoutSection(layout, section = "all") {
  const normalized = normalizeAppLayout(layout);
  const key = cleanText(section, 64, "all").toLowerCase();
  if (!key || key === "all") return normalized;
  if (key === "overview") return { updatedAt: normalized.updatedAt, overview: normalized.overview };
  if (key === "categories") return { updatedAt: normalized.updatedAt, categories: normalized.categories };
  if (key === "overlaps") return { updatedAt: normalized.updatedAt, overlaps: normalized.overlaps };
  const layer = normalized.layers.find((entry) => entry.id.toLowerCase() === key);
  if (layer) return { updatedAt: normalized.updatedAt, layer };
  throw new Error(`Unknown app_layout section "${section}". Choose all, overview, categories, sidebar, settings, mcp-tools, services, or overlaps.`);
}

function formatAppLayoutSummary(layout, section = "all") {
  const normalized = normalizeAppLayout(layout);
  const key = cleanText(section, 64, "all").toLowerCase();
  const lines = [`# ${normalized.overview.title}`, normalized.overview.subtitle, ""];
  if (key === "all" || key === "categories") {
    lines.push("## Core Categories");
    for (const category of normalized.categories) {
      lines.push(`### ${category.title} (${category.id})`);
      if (category.eli5) lines.push(category.eli5);
      for (const item of category.items) {
        lines.push(`- **${item.title}** [${item.id}${item.surfaceId ? ` · surface: ${item.surfaceId}` : ""}]: ${item.summary}`);
      }
      lines.push("");
    }
  }
  for (const layer of normalized.layers) {
    if (key !== "all" && key !== layer.id.toLowerCase()) continue;
    lines.push(`## ${layer.title} (layerId: ${layer.id})`);
    if (layer.eli5) lines.push(layer.eli5);
    for (const row of layer.rows) {
      lines.push(`- **${row.title}** (id: ${row.id}${row.category ? ` · ${row.category}` : ""}) — Now: ${row.currentLocation} → Belongs: ${row.belongsIn}`);
    }
    lines.push("");
  }
  if (key === "all" || key === "overlaps") {
    lines.push("## Current Overlaps & Misplacements");
    for (const overlap of normalized.overlaps) {
      lines.push(`- **${overlap.item}** (id: ${overlap.id}): ${overlap.currentLocation} → ${overlap.belongsIn} (${overlap.why})`);
    }
  }
  return lines.join("\n").trim();
}

function createAppLayoutStore({ filePath, onChange = null, logger = null, nowIso = () => new Date().toISOString() } = {}) {
  let current = null;
  let loading = null;
  let lastWrittenText = "";
  let saving = null;
  let saveAgain = false;
  let saveFailure = null;

  async function ensureLoaded() {
    if (current) return current;
    if (loading) return loading;
    loading = (async () => {
      if (typeof filePath === "string" && filePath) {
        try {
          const raw = await fs.promises.readFile(filePath, "utf8");
          const parsed = JSON.parse(raw);
          current = normalizeAppLayout(parsed, nowIso);
          lastWrittenText = `${JSON.stringify(current, null, 2)}\n`;
          return current;
        } catch (error) {
          if (error?.code !== "ENOENT") {
            logger?.warn?.("app_layout.unreadable", {
              reason: error instanceof SyntaxError ? "invalid_json" : typeof error?.code === "string" ? error.code : "read_failed",
            });
          }
        }
      }
      current = cloneDefault();
      return current;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  function persist() {
    if (typeof filePath !== "string" || !filePath || !current) return;
    const text = `${JSON.stringify(current, null, 2)}\n`;
    if (text === lastWrittenText) return;
    if (saving) {
      saveAgain = true;
      return;
    }
    saving = writePrivateFileAtomicAsync(filePath, text)
      .then(() => {
        lastWrittenText = text;
        saveFailure = null;
      }, (error) => {
        saveFailure = error;
        logger?.warn?.("app_layout.save_failed", { message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        saving = null;
        if (saveAgain) {
          saveAgain = false;
          persist();
        }
      });
  }

  function publish(next) {
    current = next;
    persist();
    try {
      onChange?.(JSON.parse(JSON.stringify(current)));
    } catch { /* listener errors never break state updates */ }
    return JSON.parse(JSON.stringify(current));
  }

  return {
    async get(section = "all") {
      const loaded = await ensureLoaded();
      return JSON.parse(JSON.stringify(selectAppLayoutSection(loaded, section)));
    },
    async act(input) {
      const loaded = await ensureLoaded();
      if (!input || input.action === "get" || input.action === undefined) {
        return JSON.parse(JSON.stringify(selectAppLayoutSection(loaded, input?.section ?? "all")));
      }
      const updated = applyAppLayoutAction(loaded, input, nowIso);
      return publish(updated);
    },
    async edit(input) {
      return this.act(input);
    },
    async reset() {
      await ensureLoaded();
      const fresh = cloneDefault();
      fresh.updatedAt = nowIso();
      return publish(fresh);
    },
    async saved() {
      while (saving) await saving;
      if (saveFailure) throw saveFailure;
    },
  };
}

module.exports = {
  DEFAULT_APP_LAYOUT,
  normalizeAppLayout,
  applyAppLayoutAction,
  selectAppLayoutSection,
  formatAppLayoutSummary,
  createAppLayoutStore,
};
