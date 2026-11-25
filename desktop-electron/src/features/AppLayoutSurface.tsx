import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  AppLayoutCategory,
  AppLayoutCategoryItem,
  AppLayoutEditInput,
  AppLayoutLayer,
  AppLayoutLayerRow,
  AppLayoutOverlap,
  AppLayoutSnapshot,
  Surface,
} from "../types";
import "./app-layout.css";

// Runtime > App layout (the sidebar tab): the whole picture of Coding Tools across its 6 core
// categories, 4 architecture layers (Sidebar Navigation, Unified Settings, Built-in MCP Tools,
// Background Services & Plugins), and current overlaps/misplacements. Both the user (here) and
// chat models (via `mcp__coding-tools__app_layout`) can read and edit any category, layer row,
// or overlap; model edits push live through `onAppLayoutChanged`.

export type AppLayoutFilter = "all" | "categories" | "sidebar" | "settings" | "mcp-tools" | "services" | "overlaps";

type EditorState =
  | { kind: "overview"; title: string; subtitle: string }
  | { kind: "category"; id: string; title: string; eli5: string }
  | { kind: "category-item"; categoryId: string; id: string; title: string; surfaceId: string; summary: string; bullets: string }
  | {
      kind: "layer-row";
      layerId: string;
      id: string;
      category: string;
      title: string;
      surfaceId: string;
      controllingSwitch: string;
      currentLocation: string;
      belongsIn: string;
      items: string;
      note: string;
    }
  | { kind: "overlap"; id: string; item: string; currentLocation: string; belongsIn: string; why: string };

const KNOWN_SURFACES = new Set<string>([
  "browser",
  "chatgpt-browser-management",
  "chatgpt-desktop",
  "email",
  "register",
  "setup",
  "mcp",
  "instant-mcp",
  "workspace-auth",
  "native-codex",
  "oauth",
  "api-models",
  "agent-orchestrator",
  "agent-orchestrator-original",
  "agent-orchestrator-teams",
  "subagents",
  "computer-use",
  "app-layout",
  "rtk",
  "plugins",
  "antigravity-cli",
  "providers",
  "integrations",
  "app-plugins",
  "cpa",
  "network",
  "activity",
  "settings",
]);

export const INITIAL_APP_LAYOUT: AppLayoutSnapshot = {
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
          title: "Mission Board (agent-orchestrator-original)",
          surfaceId: "agent-orchestrator-original",
          summary: "Raw Agent Orchestrator task-graph and kanban board view.",
          bullets: [
            "Currently folded under More; belongs with Chats & Agents as a mission graph view",
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
          currentLocation: "Runtime › Chat / Orchestrator Team / Subagents + More › Agent Orchestrator",
          belongsIn: "1. Chats & Agents",
          items: [
            "Chat (agent-orchestrator — Projects, General Chat, Split View, Pages 1–10)",
            "Orchestrator Team (agent-orchestrator-teams — Planner/Worker/Reviewer team templates)",
            "Subagents (subagents — Delegated worker pool & transcripts)",
            "Mission Board (agent-orchestrator-original — Raw mission graph view)",
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
            "Allow quota-based reviews (meteredReviews — off by default; covers standalone Codex Guardian and CPA)",
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
};

const FILTER_TABS: { id: AppLayoutFilter; label: string }[] = [
  { id: "all", label: "Whole picture" },
  { id: "categories", label: "6 Categories" },
  { id: "sidebar", label: "Layer 1: Sidebar" },
  { id: "settings", label: "Layer 2: Settings" },
  { id: "mcp-tools", label: "Layer 3: MCP Tools" },
  { id: "services", label: "Layer 4: Services" },
  { id: "overlaps", label: "Overlaps" },
];

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function matchesAppLayoutQuery(query: string, ...parts: (string | undefined | readonly string[])[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === "string") {
      if (part.toLowerCase().includes(needle)) return true;
    } else {
      for (const item of part) if (item && item.toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}

function Heading({ label, meta, children }: { label: string; meta?: string; children?: ReactNode }) {
  return (
    <div className="section-heading is-spaced al-section-head">
      <div className="al-section-head-title">
        <span>{label}</span>
        {meta ? <small>{meta}</small> : null}
      </div>
      {children ? <div className="al-section-head-actions">{children}</div> : null}
    </div>
  );
}

export function AppLayoutSurface({
  active,
  navigateSurface,
  setError,
}: {
  active: boolean;
  navigateSurface: (surface: Surface) => void;
  setError: (error: string | null) => void;
}) {
  const [layout, setLayout] = useState<AppLayoutSnapshot>(INITIAL_APP_LAYOUT);
  const [filter, setFilter] = useState<AppLayoutFilter>("all");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = window.codexWebLauncher;
    if (!api?.appLayout) return;
    try {
      const next = await api.appLayout();
      if (next && typeof next === "object") setLayout(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [setError]);

  useEffect(() => {
    if (!active) return undefined;
    void load();
    const api = window.codexWebLauncher;
    const off = api?.onAppLayoutChanged?.((next) => {
      if (next && typeof next === "object") setLayout(next);
    });
    return () => {
      off?.();
    };
  }, [active, load]);

  const applyEdit = async (input: AppLayoutEditInput) => {
    const api = window.codexWebLauncher;
    if (!api?.editAppLayout) return;
    setBusy(true);
    try {
      const next = await api.editAppLayout(input);
      if (next && typeof next === "object") setLayout(next);
      setEditor(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const resetAll = async () => {
    const api = window.codexWebLauncher;
    if (!api?.resetAppLayout) return;
    if (typeof window.confirm === "function" && !window.confirm("Restore the default Coding Tools App layout?")) return;
    setBusy(true);
    try {
      const next = await api.resetAppLayout();
      if (next && typeof next === "object") setLayout(next);
      setEditor(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = () => {
    if (!editor) return;
    if (editor.kind === "overview") {
      void applyEdit({ action: "update_overview", title: editor.title, subtitle: editor.subtitle });
      return;
    }
    if (editor.kind === "category") {
      void applyEdit({
        action: "upsert_category",
        category: { id: editor.id, title: editor.title, eli5: editor.eli5 },
      });
      return;
    }
    if (editor.kind === "category-item") {
      void applyEdit({
        action: "upsert_category_item",
        categoryId: editor.categoryId,
        item: {
          id: editor.id,
          title: editor.title,
          surfaceId: editor.surfaceId.trim() || undefined,
          summary: editor.summary,
          bullets: editor.bullets.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        },
      });
      return;
    }
    if (editor.kind === "layer-row") {
      void applyEdit({
        action: "upsert_layer_row",
        layerId: editor.layerId,
        row: {
          id: editor.id,
          category: editor.category,
          title: editor.title,
          surfaceId: editor.surfaceId.trim() || undefined,
          controllingSwitch: editor.controllingSwitch.trim() || undefined,
          currentLocation: editor.currentLocation,
          belongsIn: editor.belongsIn,
          items: editor.items.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
          note: editor.note.trim() || undefined,
        },
      });
      return;
    }
    if (editor.kind === "overlap") {
      void applyEdit({
        action: "upsert_overlap",
        overlap: {
          id: editor.id,
          item: editor.item,
          currentLocation: editor.currentLocation,
          belongsIn: editor.belongsIn,
          why: editor.why,
        },
      });
    }
  };

  const canOpenSurface = (surfaceId?: string): surfaceId is Surface =>
    Boolean(surfaceId && KNOWN_SURFACES.has(surfaceId));

  const showCategories = filter === "all" || filter === "categories";
  const showOverlaps = filter === "all" || filter === "overlaps";
  const visibleLayers = layout.layers.filter((layer) => filter === "all" || filter === layer.id);

  const totalCategoryItems = layout.categories.reduce((sum, category) => sum + category.items.length, 0);
  const totalLayerRows = layout.layers.reduce((sum, layer) => sum + layer.rows.length, 0);

  return (
    <section className="content-surface app-layout-surface" aria-label="App layout">
      <div className="content-scroll">
        <header className="surface-header al-header">
          <div className="al-header-copy">
            <span>Runtime · Architecture & Layer Map</span>
            <h1>{layout.overview.title}</h1>
            <p>{layout.overview.subtitle}</p>
          </div>
          <div className="al-header-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => setEditor({ kind: "overview", title: layout.overview.title, subtitle: layout.overview.subtitle })}
            >
              Edit overview
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => void resetAll()}
            >
              Reset layout
            </button>
          </div>
        </header>

        <div className="al-stats-bar" role="region" aria-label="App layout summary">
          <div className="al-stat-pill">
            <strong>{layout.categories.length}</strong>
            <span>Core categories ({totalCategoryItems} modules)</span>
          </div>
          <div className="al-stat-pill">
            <strong>{layout.layers.length}</strong>
            <span>Architecture layers ({totalLayerRows} groups)</span>
          </div>
          <div className="al-stat-pill">
            <strong>{layout.overlaps.length}</strong>
            <span>Tracked overlaps</span>
          </div>
          <div className="al-stat-pill is-model">
            <code>mcp__coding-tools__app_layout</code>
            <span>Editable by you & chat models</span>
          </div>
        </div>

        <div className="al-toolbar">
          <div className="plugins-tabs al-tabs" role="tablist" aria-label="App layout layers">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={filter === tab.id}
                onClick={() => setFilter(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="al-search"
            aria-label="Filter app layout"
            placeholder="Filter categories, layers, tools or settings…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {editor ? (
          <div className="al-editor-card" role="region" aria-label="Edit app layout">
            <h2>
              {editor.kind === "overview"
                ? "Edit overview"
                : editor.kind === "category"
                  ? "Edit category"
                  : editor.kind === "category-item"
                    ? "Edit category module"
                    : editor.kind === "layer-row"
                      ? `Edit ${editor.layerId} layer row`
                      : "Edit overlap"}
            </h2>
            {editor.kind === "overview" ? (
              <div className="al-editor-fields">
                <label className="field-row">
                  <span>Title</span>
                  <input value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} />
                </label>
                <label className="field-row is-stacked">
                  <span>Subtitle</span>
                  <textarea rows={2} value={editor.subtitle} onChange={(e) => setEditor({ ...editor, subtitle: e.target.value })} />
                </label>
              </div>
            ) : null}

            {editor.kind === "category" ? (
              <div className="al-editor-fields">
                <label className="field-row">
                  <span>Category ID</span>
                  <input value={editor.id} onChange={(e) => setEditor({ ...editor, id: e.target.value })} placeholder="chats-agents" />
                </label>
                <label className="field-row">
                  <span>Title</span>
                  <input value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} placeholder="1. Chats & Agents" />
                </label>
                <label className="field-row is-stacked">
                  <span>ELI5 summary</span>
                  <textarea rows={2} value={editor.eli5} onChange={(e) => setEditor({ ...editor, eli5: e.target.value })} />
                </label>
              </div>
            ) : null}

            {editor.kind === "category-item" ? (
              <div className="al-editor-fields">
                <label className="field-row">
                  <span>Title</span>
                  <input value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} placeholder="Chat (agent-orchestrator)" />
                </label>
                <label className="field-row">
                  <span>Surface ID (optional)</span>
                  <input value={editor.surfaceId} onChange={(e) => setEditor({ ...editor, surfaceId: e.target.value })} placeholder="agent-orchestrator" />
                </label>
                <label className="field-row">
                  <span>Summary</span>
                  <input value={editor.summary} onChange={(e) => setEditor({ ...editor, summary: e.target.value })} />
                </label>
                <label className="field-row is-stacked">
                  <span>What belongs inside (one bullet per line)</span>
                  <textarea rows={4} value={editor.bullets} onChange={(e) => setEditor({ ...editor, bullets: e.target.value })} />
                </label>
              </div>
            ) : null}

            {editor.kind === "layer-row" ? (
              <div className="al-editor-fields">
                <label className="field-row">
                  <span>Title</span>
                  <input value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} />
                </label>
                <label className="field-row">
                  <span>Category</span>
                  <input value={editor.category} onChange={(e) => setEditor({ ...editor, category: e.target.value })} placeholder="1. Chats & Agents" />
                </label>
                <label className="field-row">
                  <span>Where it sits now</span>
                  <input value={editor.currentLocation} onChange={(e) => setEditor({ ...editor, currentLocation: e.target.value })} />
                </label>
                <label className="field-row">
                  <span>Where it belongs</span>
                  <input value={editor.belongsIn} onChange={(e) => setEditor({ ...editor, belongsIn: e.target.value })} />
                </label>
                <label className="field-row">
                  <span>Controlling switch / service</span>
                  <input value={editor.controllingSwitch} onChange={(e) => setEditor({ ...editor, controllingSwitch: e.target.value })} />
                </label>
                <label className="field-row">
                  <span>Surface ID (optional)</span>
                  <input value={editor.surfaceId} onChange={(e) => setEditor({ ...editor, surfaceId: e.target.value })} placeholder="plugins" />
                </label>
                <label className="field-row is-stacked">
                  <span>Items inside this layer group (one per line)</span>
                  <textarea rows={4} value={editor.items} onChange={(e) => setEditor({ ...editor, items: e.target.value })} />
                </label>
                <label className="field-row">
                  <span>Note (optional)</span>
                  <input value={editor.note} onChange={(e) => setEditor({ ...editor, note: e.target.value })} />
                </label>
              </div>
            ) : null}

            {editor.kind === "overlap" ? (
              <div className="al-editor-fields">
                <label className="field-row">
                  <span>Overlap / misplacement</span>
                  <input value={editor.item} onChange={(e) => setEditor({ ...editor, item: e.target.value })} />
                </label>
                <label className="field-row">
                  <span>Where it sits now</span>
                  <input value={editor.currentLocation} onChange={(e) => setEditor({ ...editor, currentLocation: e.target.value })} />
                </label>
                <label className="field-row">
                  <span>Where it belongs</span>
                  <input value={editor.belongsIn} onChange={(e) => setEditor({ ...editor, belongsIn: e.target.value })} />
                </label>
                <label className="field-row is-stacked">
                  <span>Why</span>
                  <textarea rows={2} value={editor.why} onChange={(e) => setEditor({ ...editor, why: e.target.value })} />
                </label>
              </div>
            ) : null}

            <div className="inline-actions">
              <button type="button" className="button-primary" disabled={busy} onClick={saveEditor}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button type="button" className="button-secondary" disabled={busy} onClick={() => setEditor(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {showCategories ? (
          <section className="al-block" aria-label="6 Core Categories">
            <Heading label="6 Core Categories (What Belongs Where)" meta={`${layout.categories.length} categories`}>
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => setEditor({ kind: "category", id: "", title: "", eli5: "" })}
              >
                Add category
              </button>
            </Heading>
            <div className="al-category-grid">
              {layout.categories
                .filter((category: AppLayoutCategory) =>
                  matchesAppLayoutQuery(
                    query,
                    category.title,
                    category.eli5,
                    category.items.map((item) => `${item.title} ${item.summary} ${item.bullets.join(" ")}`),
                  ))
                .map((category: AppLayoutCategory) => (
                  <article className="al-category-card" key={category.id}>
                    <header className="al-category-head">
                      <div>
                        <h2>{category.title}</h2>
                        <p>{category.eli5}</p>
                      </div>
                      <div className="al-row-actions">
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => setEditor({
                            kind: "category-item",
                            categoryId: category.id,
                            id: "",
                            title: "",
                            surfaceId: "",
                            summary: "",
                            bullets: "",
                          })}
                        >
                          Add item
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => setEditor({
                            kind: "category",
                            id: category.id,
                            title: category.title,
                            eli5: category.eli5,
                          })}
                        >
                          Edit
                        </button>
                      </div>
                    </header>
                    <div className="al-category-items">
                      {category.items.map((item: AppLayoutCategoryItem) => (
                        <div className="al-category-item" key={item.id}>
                          <div className="al-item-top">
                            <strong>{item.title}</strong>
                            <div className="al-row-actions">
                              {canOpenSurface(item.surfaceId) && item.surfaceId !== "app-layout" ? (
                                <button
                                  type="button"
                                  className="button-link"
                                  onClick={() => navigateSurface(item.surfaceId as Surface)}
                                >
                                  Open {item.surfaceId}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="button-link"
                                onClick={() => setEditor({
                                  kind: "category-item",
                                  categoryId: category.id,
                                  id: item.id,
                                  title: item.title,
                                  surfaceId: item.surfaceId ?? "",
                                  summary: item.summary,
                                  bullets: item.bullets.join("\n"),
                                })}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="button-link"
                                disabled={busy}
                                onClick={() => void applyEdit({ action: "remove_category_item", categoryId: category.id, itemId: item.id })}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          {item.summary ? <p className="al-item-summary">{item.summary}</p> : null}
                          {item.bullets.length ? (
                            <ul className="al-bullet-list">
                              {item.bullets.map((bullet, idx) => <li key={idx}>{bullet}</li>)}
                            </ul>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
            </div>
          </section>
        ) : null}

        {visibleLayers.map((layer: AppLayoutLayer) => {
          const rows = layer.rows.filter((row: AppLayoutLayerRow) =>
            matchesAppLayoutQuery(
              query,
              layer.title,
              row.title,
              row.category,
              row.currentLocation,
              row.belongsIn,
              row.controllingSwitch,
              row.note,
              row.items,
            ));
          return (
            <section className="al-block" key={layer.id} aria-label={layer.title}>
              <Heading label={layer.title} meta={`${rows.length} groups`}>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => setEditor({
                    kind: "layer-row",
                    layerId: layer.id,
                    id: "",
                    category: "",
                    title: "",
                    surfaceId: "",
                    controllingSwitch: "",
                    currentLocation: "",
                    belongsIn: "",
                    items: "",
                    note: "",
                  })}
                >
                  Add row
                </button>
              </Heading>
              <p className="al-layer-eli5">{layer.eli5}</p>
              <div className="al-layer-list">
                {rows.map((row: AppLayoutLayerRow) => (
                  <div className="al-layer-row" key={row.id}>
                    <div className="al-layer-row-head">
                      <div className="al-layer-row-title">
                        <strong>{row.title}</strong>
                        {row.category ? <span className="rtk-chip">{row.category}</span> : null}
                        {row.controllingSwitch ? <span className="al-switch-chip">{row.controllingSwitch}</span> : null}
                      </div>
                      <div className="al-row-actions">
                        {canOpenSurface(row.surfaceId) && row.surfaceId !== "app-layout" ? (
                          <button
                            type="button"
                            className="button-secondary"
                            onClick={() => navigateSurface(row.surfaceId as Surface)}
                          >
                            Open {row.surfaceId}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => setEditor({
                            kind: "layer-row",
                            layerId: layer.id,
                            id: row.id,
                            category: row.category,
                            title: row.title,
                            surfaceId: row.surfaceId ?? "",
                            controllingSwitch: row.controllingSwitch ?? "",
                            currentLocation: row.currentLocation,
                            belongsIn: row.belongsIn,
                            items: row.items.join("\n"),
                            note: row.note ?? "",
                          })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={busy}
                          onClick={() => void applyEdit({ action: "remove_layer_row", layerId: layer.id, rowId: row.id })}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="al-location-grid">
                      <div>
                        <small>Where it sits now</small>
                        <span>{row.currentLocation}</span>
                      </div>
                      <div>
                        <small>Where it belongs</small>
                        <b>{row.belongsIn}</b>
                      </div>
                    </div>
                    {row.items.length ? (
                      <ul className="al-bullet-list">
                        {row.items.map((entry, idx) => <li key={idx}>{entry}</li>)}
                      </ul>
                    ) : null}
                    {row.note ? <p className="al-row-note">{row.note}</p> : null}
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        {showOverlaps ? (
          <section className="al-block" aria-label="Current Overlaps and Misplacements">
            <Heading label="Current Overlaps & Misplacements" meta={`${layout.overlaps.length} items`}>
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => setEditor({ kind: "overlap", id: "", item: "", currentLocation: "", belongsIn: "", why: "" })}
              >
                Add overlap
              </button>
            </Heading>
            <div className="al-layer-list">
              {layout.overlaps
                .filter((overlap: AppLayoutOverlap) =>
                  matchesAppLayoutQuery(query, overlap.item, overlap.currentLocation, overlap.belongsIn, overlap.why))
                .map((overlap: AppLayoutOverlap) => (
                  <div className="al-layer-row is-overlap" key={overlap.id}>
                    <div className="al-layer-row-head">
                      <strong>{overlap.item}</strong>
                      <div className="al-row-actions">
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => setEditor({
                            kind: "overlap",
                            id: overlap.id,
                            item: overlap.item,
                            currentLocation: overlap.currentLocation,
                            belongsIn: overlap.belongsIn,
                            why: overlap.why,
                          })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={busy}
                          onClick={() => void applyEdit({ action: "remove_overlap", overlapId: overlap.id })}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="al-location-grid">
                      <div>
                        <small>Where it sits now</small>
                        <span>{overlap.currentLocation}</span>
                      </div>
                      <div>
                        <small>Where it belongs</small>
                        <b>{overlap.belongsIn}</b>
                      </div>
                    </div>
                    <p className="al-row-note">{overlap.why}</p>
                  </div>
                ))}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}
