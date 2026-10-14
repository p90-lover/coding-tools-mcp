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

// The user's own ChatGPT window (not a docked copy): a still capture for the preview panel and
// keyboard input for the panel's send box. Compiled only on first use, so the docking helper
// never pays for System.Drawing.
const LOCAL_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class CgdShot { public byte[] Jpeg; public int Width, Height; }

public static class CgdLocal {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  const uint PW_RENDERFULLCONTENT = 2, GA_ROOTOWNER = 3;
  const int SW_RESTORE = 9, DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const uint INPUT_KEYBOARD = 1, KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
  const ushort VK_RETURN = 0x0D, VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_END = 0x23;
  // Small batches, each after a foreground check: if the user switches windows mid-message,
  // typing stops instead of landing in whatever app is now in front.
  const int TYPE_BATCH = 48;

  static void PerMonitor() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }

  // "gone" also covers a recycled handle that now belongs to another process.
  public static string State(long hwnd, uint pid) {
    IntPtr h = new IntPtr(hwnd);
    uint owner;
    if (hwnd == 0 || !IsWindow(h)) return "gone";
    GetWindowThreadProcessId(h, out owner);
    if (owner != pid) return "gone";
    if (IsIconic(h)) return "minimized";
    return IsWindowVisible(h) ? "visible" : "hidden";
  }

  public static string Title(long hwnd) {
    StringBuilder text = new StringBuilder(256);
    GetWindowText(new IntPtr(hwnd), text, text.Capacity);
    return text.ToString();
  }

  // PW_RENDERFULLCONTENT captures Chromium's GPU-composited content even while the window is
  // covered; a minimized window has nothing to capture.
  public static CgdShot Capture(long hwnd, int maxWidth) {
    PerMonitor();
    IntPtr h = new IntPtr(hwnd);
    RECT r;
    if (!GetWindowRect(h, out r)) return null;
    int w = r.Right - r.Left, ht = r.Bottom - r.Top;
    if (w < 16 || ht < 16 || w > 16384 || ht > 16384) return null;
    Rectangle crop = new Rectangle(0, 0, w, ht);
    RECT f;
    // The window rect includes invisible resize borders; crop to what is actually drawn.
    if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out f, Marshal.SizeOf(typeof(RECT))) == 0) {
      Rectangle frame = Rectangle.FromLTRB(f.Left - r.Left, f.Top - r.Top, f.Right - r.Left, f.Bottom - r.Top);
      frame.Intersect(crop);
      if (frame.Width >= 16 && frame.Height >= 16) crop = frame;
    }
    using (Bitmap full = new Bitmap(w, ht, PixelFormat.Format32bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) {
        IntPtr hdc = g.GetHdc();
        bool ok;
        try { ok = PrintWindow(h, hdc, PW_RENDERFULLCONTENT); } finally { g.ReleaseHdc(hdc); }
        if (!ok) return null;
      }
      double scale = Math.Min(1.0, (double)Math.Max(160, maxWidth) / crop.Width);
      int ow = Math.Max(1, (int)Math.Round(crop.Width * scale)), oh = Math.Max(1, (int)Math.Round(crop.Height * scale));
      using (Bitmap output = new Bitmap(ow, oh, PixelFormat.Format24bppRgb)) {
        using (Graphics g = Graphics.FromImage(output)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.PixelOffsetMode = PixelOffsetMode.HighQuality;
          g.DrawImage(full, new Rectangle(0, 0, ow, oh), crop, GraphicsUnit.Pixel);
        }
        byte[] jpeg = Encode(output, 72L);
        if (jpeg.Length > 1000000) jpeg = Encode(output, 45L);
        CgdShot shot = new CgdShot();
        shot.Jpeg = jpeg; shot.Width = ow; shot.Height = oh;
        return shot;
      }
    }
  }

  static byte[] Encode(Bitmap image, long quality) {
    ImageCodecInfo codec = null;
    foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders()) {
      if (candidate.FormatID == ImageFormat.Jpeg.Guid) codec = candidate;
    }
    using (MemoryStream stream = new MemoryStream())
    using (EncoderParameters options = new EncoderParameters(1)) {
      options.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
      image.Save(stream, codec, options);
      return stream.ToArray();
    }
  }

  public static bool IsForeground(long hwnd) {
    IntPtr h = new IntPtr(hwnd), front = GetForegroundWindow();
    return front == h || GetAncestor(front, GA_ROOTOWNER) == h;
  }

  // Windows hands focus only to a process the foreground app allows; this helper is a child of
  // Coding Tools, which the user just clicked. Joining the foreground thread's input is the
  // documented fallback when the plain call is refused.
  public static bool Activate(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return false;
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    if (!IsForeground(hwnd)) SetForegroundWindow(h);
    if (!IsForeground(hwnd)) {
      uint ignored;
      uint front = GetWindowThreadProcessId(GetForegroundWindow(), out ignored), self = GetCurrentThreadId();
      bool joined = front != 0 && front != self && AttachThreadInput(self, front, true);
      try { BringWindowToTop(h); SetForegroundWindow(h); }
      finally { if (joined) AttachThreadInput(self, front, false); }
    }
    for (int i = 0; i < 20 && !IsForeground(hwnd); i++) Thread.Sleep(25);
    return IsForeground(hwnd);
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk; input.u.ki.wScan = scan; input.u.ki.dwFlags = flags;
    return input;
  }

  static bool Send(List<INPUT> inputs) {
    if (inputs.Count == 0) return true;
    INPUT[] batch = inputs.ToArray();
    return SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(INPUT))) == batch.Length;
  }

  // Types text into the focused control as Unicode key events (no clipboard involved). A line
  // break is Shift+Enter, which starts a new line in ChatGPT's composer instead of sending.
  // Returns null on success, otherwise why it stopped.
  public static string TypeText(long hwnd, string text) {
    List<INPUT> inputs = new List<INPUT>();
    // Caret to the end, so any draft already in the box is kept, not overwritten.
    inputs.Add(Key(VK_CONTROL, 0, 0));
    inputs.Add(Key(VK_END, 0, KEYEVENTF_EXTENDEDKEY));
    inputs.Add(Key(VK_END, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP));
    inputs.Add(Key(VK_CONTROL, 0, KEYEVENTF_KEYUP));
    if (!IsForeground(hwnd)) return "focus-lost";
    if (!Send(inputs)) return "blocked";
    int i = 0;
    while (i < text.Length) {
      if (!IsForeground(hwnd)) return "focus-lost";
      inputs.Clear();
      int end = Math.Min(text.Length, i + TYPE_BATCH);
      if (end < text.Length && char.IsHighSurrogate(text[end - 1])) end++;
      for (; i < end; i++) {
        char c = text[i];
        if (c == '\n') {
          inputs.Add(Key(VK_SHIFT, 0, 0));
          inputs.Add(Key(VK_RETURN, 0, 0));
          inputs.Add(Key(VK_RETURN, 0, KEYEVENTF_KEYUP));
          inputs.Add(Key(VK_SHIFT, 0, KEYEVENTF_KEYUP));
        } else {
          inputs.Add(Key(0, c, KEYEVENTF_UNICODE));
          inputs.Add(Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
      }
      if (!Send(inputs)) return "blocked";
      Thread.Sleep(15);
    }
    return null;
  }

  public static string Submit(long hwnd) {
    if (!IsForeground(hwnd)) return "focus-lost";
    List<INPUT> inputs = new List<INPUT>();
    inputs.Add(Key(VK_RETURN, 0, 0));
    inputs.Add(Key(VK_RETURN, 0, KEYEVENTF_KEYUP));
    return Send(inputs) ? null : "blocked";
  }
}
`;

// PowerShell for the user's own ChatGPT window. Sent over stdin with the first local-* request
// (see call below) rather than baked into -EncodedCommand, which Windows caps at 32K characters.
const LOCAL_SCRIPT = `
Add-Type -AssemblyName System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${LOCAL_SOURCE}
'@
# The user's own ChatGPT: a main ChatGPT.exe process that is not one of Coding Tools' copies.
# A copy is known by its pid, or by a child whose command line carries the slots folder.
function script:Find-Local($exclude, $ownedPids) {
  $all = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'")
  $owned = @{}
  foreach ($id in @($ownedPids)) { if ($id) { $owned[[int]$id] = $true } }
  foreach ($p in $all) {
    if ($exclude -and $p.CommandLine -and $p.CommandLine.Contains($exclude)) {
      $owned[[int]$p.ProcessId] = $true
      $owned[[int]$p.ParentProcessId] = $true
    }
  }
  foreach ($p in $all) {
    if ($owned.ContainsKey([int]$p.ProcessId)) { continue }
    if ($p.CommandLine -and $p.CommandLine.Contains('--type=')) { continue }
    $hwnd = [CgdWin]::MainWindow([uint32]$p.ProcessId)
    if ($hwnd -eq 0) { continue }
    $state = [CgdLocal]::State([long]$hwnd, [uint32]$p.ProcessId)
    if ($state -eq 'visible' -or $state -eq 'minimized') {
      return @{ pid = [int]$p.ProcessId; hwnd = $hwnd; state = $state; title = [CgdLocal]::Title([long]$hwnd) }
    }
  }
  return @{ pid = $null; hwnd = 0 }
}
function script:Capture-Local($hwnd, $procId, $maxWidth) {
  $state = [CgdLocal]::State([long]$hwnd, [uint32]$procId)
  if ($state -ne 'visible') { return @{ state = $state } }
  $shot = [CgdLocal]::Capture([long]$hwnd, [int]$maxWidth)
  if ($null -eq $shot) { return @{ state = 'blank' } }
  return @{ state = 'ok'; title = [CgdLocal]::Title([long]$hwnd); width = $shot.Width; height = $shot.Height; data = [Convert]::ToBase64String($shot.Jpeg) }
}
function script:Test-Editable($el) {
  if ($el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) { return $true }
  $vp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return -not $vp.Current.IsReadOnly }
  return $false
}
# ChatGPT's composer is the lowest editable control in its window. Chromium builds its
# accessibility tree on the first UI Automation query, so an empty first look is retried.
function script:Focus-Composer($hwnd) {
  $ae = [System.Windows.Automation.AutomationElement]
  $condition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($ae::IsKeyboardFocusableProperty, $true)),
    (New-Object System.Windows.Automation.PropertyCondition($ae::IsEnabledProperty, $true)))
  $best = $null
  for ($attempt = 0; $attempt -lt 4 -and -not $best; $attempt++) {
    if ($attempt) { Start-Sleep -Milliseconds 400 }
    $bottom = [double]::MinValue
    foreach ($el in $ae::FromHandle([IntPtr][long]$hwnd).FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
      try {
        $r = $el.Current.BoundingRectangle
        if ($el.Current.IsOffscreen -or $r.IsEmpty -or $r.Width -lt 40 -or -not (Test-Editable $el)) { continue }
        if ($r.Bottom -gt $bottom) { $best = $el; $bottom = $r.Bottom }
      } catch {}
    }
  }
  if (-not $best) { throw "Could not find ChatGPT's message box" }
  $best.SetFocus()
  Start-Sleep -Milliseconds 120
  # The editor may report focus on itself or on an editable part of it; anything else means
  # the keys would go somewhere other than the message box.
  $focused = $ae::FocusedElement
  $ok = $false
  try { $ok = $focused -and ([System.Windows.Automation.Automation]::Compare($focused, $best) -or (Test-Editable $focused)) } catch {}
  if (-not $ok) { throw "ChatGPT's message box did not take focus" }
}
function script:Send-Local($hwnd, $procId, $text, $returnTo) {
  $state = [CgdLocal]::State([long]$hwnd, [uint32]$procId)
  if ($state -ne 'visible' -and $state -ne 'minimized') { throw "ChatGPT's window is not open" }
  try {
    if (-not [CgdLocal]::Activate([long]$hwnd)) { throw "Windows did not let Coding Tools bring ChatGPT to the front" }
    Start-Sleep -Milliseconds 150
    Focus-Composer $hwnd
    if (-not [CgdLocal]::IsForeground([long]$hwnd)) { throw "ChatGPT lost focus before the message was typed" }
    $problem = [CgdLocal]::TypeText([long]$hwnd, [string]$text)
    if ($problem -eq 'focus-lost') { throw "Typing stopped because ChatGPT lost focus; part of the message may be in its box" }
    if ($problem) { throw "Windows blocked the typed input (is ChatGPT running as administrator?)" }
    Start-Sleep -Milliseconds 200
    $problem = [CgdLocal]::Submit([long]$hwnd)
    if ($problem) { throw "The message was typed but not sent: ChatGPT lost focus before Enter" }
  } finally {
    if ($returnTo) { Start-Sleep -Milliseconds 150; [void][CgdLocal]::Activate([long]$returnTo) }
  }
  $true
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
$script:localReady = $false
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
      'local-init' {
        if (-not $script:localReady) { . ([ScriptBlock]::Create([string]$a.script)); $script:localReady = $true }
        $true
      }
      'local-find' { Find-Local $a.exclude $a.ownedPids }
      'local-capture' { Capture-Local $a.hwnd $a.pid $a.maxWidth }
      'local-send' { Send-Local $a.hwnd $a.pid $a.text $a.returnTo }
      default { throw "Unknown operation $($req.op)" }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 5))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`;

// PowerShell reads stdin in the console's OEM code page, which mangles anything past ASCII
// (a typed message, a non-English profile path). JSON \u escapes keep every request ASCII.
function requestLine(request) {
  return JSON.stringify(request).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

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

  function request(op, args, timeoutMs) {
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
      process.stdin.write(`${requestLine({ id, op, args })}\n`);
    });
  }

  // The local-* operations need LOCAL_SCRIPT, loaded once into each helper process.
  let localInit = null; // { process, ready }
  function call(op, args = {}, timeoutMs = 20_000) {
    if (!op.startsWith("local-")) return request(op, args, timeoutMs);
    const process = ensure();
    if (localInit?.process !== process) {
      const current = { process, ready: request("local-init", { script: LOCAL_SCRIPT }, 60_000) };
      // A failed load is retried by the next local request instead of failing every one after it.
      current.ready.catch(() => { if (localInit === current) localInit = null; });
      localInit = current;
    }
    return localInit.ready.then(() => request(op, args, timeoutMs));
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

module.exports = { createWin32Helper, requestLine };
