"use strict";

// One long-lived PowerShell process that owns the Win32 calls for the embedded ChatGPT
// desktop window. A persistent helper avoids ~300 ms of PowerShell startup per move/resize
// and adds no native npm dependency to the package.

const { spawn } = require("node:child_process");
const path = require("node:path");

const WIN32_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CgdWin {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  const int GWL_EXSTYLE = -20, GWLP_HWNDPARENT = -8;
  const int SW_SHOWNOACTIVATE = 4;
  const long WS_EX_APPWINDOW = 0x40000, WS_EX_TOOLWINDOW = 0x80;
  const uint GW_OWNER = 4, WM_CLOSE = 0x10;
  const uint SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40;

  // Coordinates from Electron are physical pixels; the helper must not be DPI-virtualized.
  static void PerMonitor() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }

  public static long MainWindow(uint pid) {
    PerMonitor();
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    // Background accounts are kept hidden; after a restart their main window is the largest
    // titled hidden one, used only when no visible or minimized window exists.
    IntPtr hidden = IntPtr.Zero; long hiddenArea = 0;
    EnumWindows((hwnd, l) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner != pid || GetWindowTextLength(hwnd) == 0) return true;
      RECT r; GetWindowRect(hwnd, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (!IsWindowVisible(hwnd) && !IsIconic(hwnd)) {
        if (area > hiddenArea) { hidden = hwnd; hiddenArea = area; }
        return true;
      }
      if (area > bestArea) { best = hwnd; bestArea = area; }
      return true;
    }, IntPtr.Zero);
    return (best != IntPtr.Zero ? best : hidden).ToInt64();
  }

  public static bool Alive(long hwnd) { return IsWindow(new IntPtr(hwnd)); }

  public static void Dock(long hwnd, long owner) {
    PerMonitor();
    IntPtr h = new IntPtr(hwnd);
    if (IsZoomed(h) || IsIconic(h)) ShowWindow(h, SW_SHOWNOACTIVATE);
    ShowWindow(h, 0);
    long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
    SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr((ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW));
    SetWindowLongPtr(h, GWLP_HWNDPARENT, new IntPtr(owner));
  }

  public static void Undock(long hwnd) {
    PerMonitor();
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return;
    ShowWindow(h, 0);
    SetWindowLongPtr(h, GWLP_HWNDPARENT, IntPtr.Zero);
    long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
    SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr((ex & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW));
    ShowWindow(h, 5);
  }

  // Re-pins the window when it drifted, was maximized, minimized, or hidden. Returns true when moved.
  public static bool Place(long hwnd, int x, int y, int w, int h) {
    PerMonitor();
    IntPtr handle = new IntPtr(hwnd);
    if (!IsWindow(handle)) return false;
    if (IsZoomed(handle) || IsIconic(handle)) ShowWindow(handle, SW_SHOWNOACTIVATE);
    RECT r; GetWindowRect(handle, out r);
    bool same = IsWindowVisible(handle) && r.Left == x && r.Top == y && r.Right - r.Left == w && r.Bottom - r.Top == h;
    if (same) return false;
    SetWindowPos(handle, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
    return true;
  }

  public static void Hide(long hwnd) { IntPtr h = new IntPtr(hwnd); if (IsWindow(h)) ShowWindow(h, 0); }

  public static void Close(long hwnd) { IntPtr h = new IntPtr(hwnd); if (IsWindow(h)) PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }
}
`;

// PowerShell side: JSON request per stdin line, JSON response per stdout line.
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${WIN32_SOURCE}
'@
function Find-Instance($marker) {
  $children = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) -and $_.CommandLine.Contains('--type=') })
  foreach ($child in $children) {
    $main = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ParentProcessId)"
    if ($main -and $main.Name -eq 'ChatGPT.exe') {
      return @{ pid = [int]$main.ProcessId; hwnd = [CgdWin]::MainWindow([uint32]$main.ProcessId) }
    }
  }
  return @{ pid = $null; hwnd = 0 }
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $a = $req.args
    $result = switch ($req.op) {
      'package' {
        $pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
        if ($pkg) { @{ family = $pkg.PackageFamilyName; location = $pkg.InstallLocation; version = [string]$pkg.Version } } else { $null }
      }
      'launch' {
        Invoke-CommandInDesktopPackage -PackageFamilyName $a.family -AppId 'App' -Command $a.command -Args $a.arguments -PreventBreakaway
        $true
      }
      'find' { Find-Instance $a.marker }
      'alive' { [CgdWin]::Alive([long]$a.hwnd) }
      'dock' { [CgdWin]::Dock([long]$a.hwnd, [long]$a.owner); $true }
      'undock' { [CgdWin]::Undock([long]$a.hwnd); $true }
      'place' { [CgdWin]::Place([long]$a.hwnd, [int]$a.x, [int]$a.y, [int]$a.width, [int]$a.height) }
      'hide' { [CgdWin]::Hide([long]$a.hwnd); $true }
      'close' { [CgdWin]::Close([long]$a.hwnd); $true }
      'kill-tree' { & taskkill.exe /PID ([int]$a.pid) /T /F 2>&1 | Out-Null; $true }
      'running' { [bool](Get-Process -Id ([int]$a.pid) -ErrorAction SilentlyContinue) }
      default { throw "Unknown operation $($req.op)" }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 5))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`;

function createWin32Helper({ logger, spawnProcess = spawn } = {}) {
  let child = null;
  let buffer = "";
  let sequence = 0;
  const pending = new Map();

  function failAll(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function ensure() {
    if (child && child.exitCode === null && !child.killed) return child;
    const encoded = Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64");
    child = spawnProcess(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.ok) waiter.resolve(message.result);
        else waiter.reject(new Error(message.error || "ChatGPT desktop helper failed"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message && !message.startsWith("#< CLIXML")) {
        logger?.warn?.("chatgpt_desktop.helper_stderr", { message: message.slice(0, 500) });
      }
    });
    const exited = child;
    child.on("exit", (code) => {
      if (child === exited) child = null;
      failAll(new Error(`ChatGPT desktop helper exited (${code})`));
    });
    return child;
  }

  function call(op, args = {}, timeoutMs = 20_000) {
    const process = ensure();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ChatGPT desktop helper timed out on ${op}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      process.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  function dispose() {
    const current = child;
    child = null;
    failAll(new Error("ChatGPT desktop helper stopped"));
    if (current && current.exitCode === null) {
      try { current.stdin.end(); } catch {}
      setTimeout(() => { try { current.kill(); } catch {} }, 1_000).unref?.();
    }
  }

  return { call, dispose };
}

module.exports = { createWin32Helper };
